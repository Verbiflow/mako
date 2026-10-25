import { createHash } from "node:crypto"
import { closeSync, createReadStream, openSync, writeSync } from "node:fs"
import { mkdir, rename, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { z } from "zod"
import { recordsOverHttp } from "@mako/protocol/records-http"
import type { ThreadRef } from "./format.js"
import { NativeStores } from "./read-only-sqlite.js"
import { RecordStore } from "./record-store.js"
import { RecordPushes, type PushStatus, type RecordRemote, type RecordsLink } from "./record-sync.js"
import type { SessionView } from "./view-cache.js"

/**
 * A device's reading copies: each Session its account lists, as Mako draws it (its view's entries, one JSON line
 * each), kept in the account's records for that device, so another device reads one while this one is off. Not the
 * Session's records: a Cursor chat's records hold its store's every checkpoint, and an editor chat's the editor's whole
 * database; a copy holds only what Mako shows, and reads on a device without the harness. Moving a Session still
 * sends its records, from its owner, awake.
 *
 * A copy is written where its Session changed and its turn came: one at work every 10 s (a large one less often, its
 * size permitting), one at rest a minute after it last went, in the scope's order, the ones at work first. Each is
 * captured into a record store of its own, so content-defined chunks carry only what changed, and pushed to the
 * account by the pushes a device runs (`RecordPushes`).
 */
export const COPY_FORMAT = 1

/** Which Sessions a device keeps copies of, most wanted first, by their native session and where the catalog reads it. */
export const CopyScopeSchema = z.object({
  sessions: z.array(z.object({ harness: z.string().min(1), nativeId: z.string().min(1), path: z.string().min(1), busy: z.boolean() })).max(10_000),
  /** Catching up waits (on a low battery): only Sessions at work are copied meanwhile. */
  paused: z.boolean(),
})
export type CopyScope = z.infer<typeof CopyScopeSchema>

/** A copy's first line: what it's a copy of, drawn by which decoder build, from which state of its records, and when. */
export const CopyHeaderSchema = z.object({
  copy: z.literal(COPY_FORMAT),
  harness: z.string(),
  nativeId: z.string(),
  title: z.string().optional(),
  cwd: z.string().optional(),
  model: z.string().optional(),
  translator: z.string(),
  total: z.number().int().nonnegative(),
  /** The records' stamp the view was drawn from (`SessionCatalog.stampOf`), with the decoder build. */
  stamp: z.string(),
  at: z.number(),
})
export type CopyHeader = z.infer<typeof CopyHeaderSchema>

/** How the catalog reads a Session as Mako draws it, decoding only when its view is out of date: what a copy reads of it. */
export type CopyViews = {
  view(path: string): Promise<{ view: Pick<SessionView, "total" | "translator" | "at">; ref: ThreadRef } | null>
  stamp(path: string): string | null
  translator(): string
}

/** How often a Session at work is copied, at the least: a large one waits longer, by its size. */
const BUSY_EVERY_MS = 10_000
const BUSY_MS_PER_MIB = 2_000
/** And one at rest, after it last went. */
const REST_EVERY_MS = 60_000
/** How often copies are looked at; a look that finds nothing changed reads a stamp a Session. */
const LOOK_EVERY_MS = 5_000

/** Where a Session's copy is written, under the copies' folder. */
export function copyFile(folder: string, harness: string, nativeId: string): string {
  return join(folder, "files", harness, `${createHash("sha1").update(nativeId).digest("hex")}.jsonl`)
}

/** A copy's first line, read without reading the rest; null when there's none or it isn't one. */
export async function readCopyHeader(file: string): Promise<CopyHeader | null> {
  const lines = createInterface({ input: createReadStream(file, { end: 64 * 1024 }), crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const parsed = CopyHeaderSchema.safeParse(JSON.parse(line))
      return parsed.success ? parsed.data : null
    }
    return null
  } catch {
    return null
  } finally {
    lines.close()
  }
}

type Copied = { stamp: string; at: number; bytes: number }

export class ReadingCopies {
  readonly #folder: string
  readonly #views: CopyViews
  readonly #log: (level: "info" | "warn", message: string, fields: Record<string, string | number>) => void
  readonly #now: () => number
  readonly #remote: (link: { current: RecordsLink }) => RecordRemote
  #store: RecordStore | null = null
  #pushes: RecordPushes | null = null
  #link: { current: RecordsLink } | null = null
  #scope: CopyScope | null = null
  /** What each Session's copy was last written from, by `<harness>\n<native id>`; read from the files after a restart. */
  readonly #copied = new Map<string, Copied>()
  #looking: Promise<void> | undefined
  #again = false
  #timer: ReturnType<typeof setInterval> | undefined
  #stopped = false
  #written = 0

  constructor(
    folder: string,
    views: CopyViews,
    log: (level: "info" | "warn", message: string, fields: Record<string, string | number>) => void,
    options: { now?: () => number; remote?: (link: { current: RecordsLink }) => RecordRemote } = {}
  ) {
    this.#folder = folder
    this.#views = views
    this.#log = log
    this.#now = options.now ?? Date.now
    this.#remote = options.remote ?? ((link) => recordsOverHttp({ id: link.current.id, base: link.current.base, authorization: () => link.current.authorization }))
  }

  /** The Sessions to keep copies of, most wanted first; said again as the list changes. */
  scope(scope: CopyScope): void {
    this.#scope = scope
    this.#pushes?.scoped({ sessions: scope.sessions.map(({ harness, nativeId }) => ({ harness, nativeId })), paused: scope.paused })
    this.#look()
  }

  /** Where copies go (this device's records in the account); null stops. A renewed credential goes on where it was. */
  link(link: RecordsLink | null): void {
    const held = this.#link
    if (link && held && this.#pushes && held.current.id === link.id && held.current.base === link.base) {
      held.current = link
      return
    }
    this.#pushes?.stop()
    this.#pushes = null
    this.#link = null
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
    if (!link || this.#stopped) return
    const store = this.#open()
    const remote = { current: link }
    this.#pushes = new RecordPushes(store, this.#remote(remote), this.#log)
    this.#link = remote
    if (this.#scope) this.#pushes.scoped({ sessions: this.#scope.sessions.map(({ harness, nativeId }) => ({ harness, nativeId })), paused: this.#scope.paused })
    this.#timer = setInterval(() => this.#look(), LOOK_EVERY_MS)
    this.#timer.unref?.()
    this.#look()
  }

  status(): (PushStatus & { copies: number; written: number }) | null {
    const pushes = this.#pushes?.status()
    return pushes ? { ...pushes, copies: this.#copied.size, written: this.#written } : null
  }

  /** Once the look under way and the pushes it started have settled. */
  async settled(): Promise<void> {
    while (this.#looking) await this.#looking
    await this.#pushes?.settled()
  }

  stop(): void {
    this.#stopped = true
    this.link(null)
    this.#store?.close()
    this.#store = null
  }

  #open(): RecordStore {
    this.#store ??= new RecordStore(join(this.#folder, "store"), new NativeStores(true, join(this.#folder, "restored")))
    return this.#store
  }

  /** Looks at every Session in scope, now or once the look under way ends. */
  #look(): void {
    if (this.#stopped || !this.#pushes || !this.#scope) return
    if (this.#looking) {
      this.#again = true
      return
    }
    this.#looking = this.#lookOnce()
      .catch((error: Error) => this.#log("warn", "copies stopped looking", { error: error.message }))
      .finally(() => {
        this.#looking = undefined
        if (this.#again) {
          this.#again = false
          this.#look()
        }
      })
  }

  async #lookOnce(): Promise<void> {
    const scope = this.#scope
    if (!scope) return
    const translator = this.#views.translator()
    for (const session of scope.sessions) {
      if (this.#stopped || !this.#pushes || this.#scope !== scope) return
      if (scope.paused && !session.busy) continue
      const records = this.#views.stamp(session.path)
      if (!records) continue
      const stamp = `${records}\n${translator}`
      const key = `${session.harness}\n${session.nativeId}`
      const file = copyFile(this.#folder, session.harness, session.nativeId)
      const copied = this.#copied.get(key) ?? (await this.#fromFile(key, file))
      if (copied?.stamp === stamp) continue
      const now = this.#now()
      const every = session.busy ? Math.max(BUSY_EVERY_MS, ((copied?.bytes ?? 0) / (1024 * 1024)) * BUSY_MS_PER_MIB) : REST_EVERY_MS
      if (copied && now - copied.at < every) continue
      await this.#copy(session, key, file, stamp)
      // Yield to the person between Sessions: a large copy is written in one go.
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  async #fromFile(key: string, file: string): Promise<Copied | undefined> {
    const header = await readCopyHeader(file)
    if (!header) return undefined
    const bytes = (await stat(file).catch(() => null))?.size ?? 0
    const copied = { stamp: header.stamp, at: header.at, bytes }
    this.#copied.set(key, copied)
    return copied
  }

  async #copy(session: CopyScope["sessions"][number], key: string, file: string, stamp: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true })
    const served = await this.#views.view(session.path)
    if (!served || this.#stopped) return
    const { view, ref } = served
    const header: CopyHeader = { copy: COPY_FORMAT, harness: session.harness, nativeId: session.nativeId, translator: view.translator, total: view.total, stamp, at: this.#now() }
    if (ref.title) header.title = ref.title
    if (ref.cwd) header.cwd = ref.cwd
    if (ref.model) header.model = ref.model
    const temporary = `${file}.${process.pid}.tmp`
    // Written in one go, entry by entry, 500 lines a write: the catalog's view stays open throughout (nothing else runs
    // on the catalog's thread meanwhile to close it), and a long Session is never held as one string.
    const handle = openSync(temporary, "w")
    let bytes = 0
    try {
      const write = (text: string) => {
        bytes += Buffer.byteLength(text)
        writeSync(handle, text)
      }
      write(`${JSON.stringify(header)}\n`)
      let lines: string[] = []
      for (let index = 0; index < view.total; index++) {
        const entry = view.at(index)
        if (entry) lines.push(JSON.stringify(entry))
        if (lines.length === 500 || index === view.total - 1) {
          if (lines.length) write(`${lines.join("\n")}\n`)
          lines = []
        }
      }
    } finally {
      closeSync(handle)
    }
    await rename(temporary, file)
    const root = join(this.#folder, "files")
    await this.#open().capture({ harness: session.harness, nativeId: session.nativeId, home: root, records: { roots: [{ name: "copy", path: root }], files: [file], databases: [] } })
    this.#copied.set(key, { stamp, at: header.at, bytes })
    this.#written += 1
    this.#pushes?.captured(session.harness, session.nativeId)
  }
}

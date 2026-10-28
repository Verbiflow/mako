import { createHash } from "node:crypto"
import { closeSync, createReadStream, openSync, writeSync } from "node:fs"
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { z } from "zod"
import { recordsOverHttp } from "@mako/protocol/records-http"
import type { ThreadRef } from "./format.js"
import { NativeStores } from "./read-only-sqlite.js"
import { RecordStore } from "./record-store.js"
import { RecordSync, type RecordRemote, type RecordsLink } from "./record-sync.js"
import { ScopedUploads, type SyncScope, type UploadsStatus } from "./scoped-uploads.js"
import { EntrySchema, type Entry } from "./entries.js"
import type { SessionView } from "./view-cache.js"

/**
 * A device's reading copies: each Session its account lists, as Mako draws it (its view's entries, one JSON line
 * each), kept in the account's records for that device, so another device reads one while this one is off. Not the
 * Session's records: a Cursor chat's records hold its store's every checkpoint, and an editor chat's the editor's whole
 * database; a copy holds only what Mako shows, and reads on a device without the harness. The records go up beside
 * it, to the device's originals (`SessionCatalog.syncOriginals`), for continuing the Session anywhere.
 *
 * A copy is written where its Session changed and its turn came: one at work or worked in today every 10 s (a large
 * one less often, its size permitting), an older one a minute after it last went, in the scope's order (`SyncScope`), the ones at work
 * first. Each is captured into a record store of its own, so content-defined chunks carry only what changed, and
 * pushed to the account in the same order (`ScopedUploads`), which keeps in that store what the account holds.
 */
export const COPY_FORMAT = 1

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
/** And one at rest since before today, after it last went. */
const REST_EVERY_MS = 60_000
/** How often copies are looked at; a look that finds nothing changed reads a stamp a Session. */
const LOOK_EVERY_MS = 5_000
/** Catching up on copies goes at no more than this, so a first upload of a month never fills the connection. */
const COPIES_BYTES_PER_SECOND = 1024 * 1024

/**
 * Where a Session's copy is written, under the copies' folder. Not `.jsonl`: the record store takes a `.jsonl` file
 * that grew as an append, checking only its old end (a harness's transcript is only ever appended to), while a copy's
 * header changes with every write and an entry can change in place, so each copy is taken whole, and content-defined
 * chunks still carry only what changed.
 */
export function copyFile(folder: string, harness: string, nativeId: string): string {
  return join(folder, "files", copyName(harness, nativeId))
}

/** A copy's file within its root, the same where it's written and where another device restores it. */
function copyName(harness: string, nativeId: string): string {
  return join(harness, `${createHash("sha1").update(nativeId).digest("hex")}.copy`)
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
  #uploads: ScopedUploads | null = null
  #link: { current: RecordsLink } | null = null
  #scope: SyncScope | null = null
  /** What each Session's copy was last written from, by `<harness>\n<native id>`; read from the files after a restart. */
  readonly #copied = new Map<string, Copied>()
  #looking: Promise<void> | undefined
  #again = false
  #timer: ReturnType<typeof setInterval> | undefined
  #stopped = false

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
  scope(scope: SyncScope): void {
    this.#scope = scope
    this.#uploads?.scope(scope)
    this.#look()
  }

  /** Where copies go (this device's records in the account); null stops. A renewed credential goes on where it was. */
  link(link: RecordsLink | null): void {
    const held = this.#link
    if (link && held && this.#uploads && held.current.id === link.id && held.current.base === link.base) {
      held.current = link
      return
    }
    this.#uploads?.stop()
    this.#uploads = null
    this.#link = null
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
    if (!link || this.#stopped) return
    const store = this.#open()
    const remote = { current: link }
    this.#uploads = new ScopedUploads(store, this.#remote(remote), this.#log, { bytesPerSecond: COPIES_BYTES_PER_SECOND })
    this.#link = remote
    if (this.#scope) this.#uploads.scope(this.#scope)
    this.#timer = setInterval(() => this.#look(), LOOK_EVERY_MS)
    this.#timer.unref?.()
    this.#look()
  }

  /** How the copies' uploads go; null without a link. */
  status(): UploadsStatus | null {
    return this.#uploads?.status() ?? null
  }

  /**
   * Whether another device can read the Session as it is now: its copy in the account, and drawn from the Session's
   * records as they are (a newer copy waits for its turn otherwise: `current`).
   */
  readable(session: SyncScope["sessions"][number]): boolean {
    return (this.#uploads?.inCloud(session.harness, session.nativeId) ?? false) && this.current(session)
  }

  /** Whether the Session's copy was written from its records as they are now; true when its records can't be read. */
  current(session: SyncScope["sessions"][number]): boolean {
    const records = this.#views.stamp(session.path)
    const copied = this.#copied.get(`${session.harness}\n${session.nativeId}`)
    return !records || !copied || copied.stamp === `${records}\n${this.#views.translator()}`
  }

  /** Once the look under way and the pushes it started have settled. */
  async settled(): Promise<void> {
    while (this.#looking) await this.#looking
    await this.#uploads?.settled()
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
    if (this.#stopped || !this.#uploads || !this.#scope) return
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
      if (this.#stopped || !this.#uploads || this.#scope !== scope) return
      if (scope.paused && !session.busy) continue
      const records = this.#views.stamp(session.path)
      if (!records) continue
      const stamp = `${records}\n${translator}`
      const key = `${session.harness}\n${session.nativeId}`
      const file = copyFile(this.#folder, session.harness, session.nativeId)
      const copied = this.#copied.get(key) ?? (await this.#fromFile(key, file))
      if (copied?.stamp === stamp) continue
      const now = this.#now()
      // One at work, or worked in today, goes again within seconds of a change (a large one as its size allows): a turn
      // that just ended is the one another device opens next. Older ones changing again wait a minute.
      const every = session.busy || session.tier === "day" ? Math.max(BUSY_EVERY_MS, ((copied?.bytes ?? 0) / (1024 * 1024)) * BUSY_MS_PER_MIB) : REST_EVERY_MS
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

  async #copy(session: SyncScope["sessions"][number], key: string, file: string, stamp: string): Promise<void> {
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
    this.#uploads?.look()
  }
}

/** A copy as read here: its header, and its entries in order. */
export type ReadCopy = { header: CopyHeader; entries: Entry[] }
/** A run of a copy's entries ending before `before` (the newest when it isn't given), with the copy's header. */
export const CopyPageSchema = z.object({
  header: CopyHeaderSchema,
  entries: z.array(EntrySchema),
  start: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
})
export type CopyPage = z.infer<typeof CopyPageSchema>

/** A copy read again at most this often: a reader paging back through one asks every page. */
const PULL_EVERY_MS = 10_000
/** Copies held parsed: the ones the windows read now. */
const HELD_COPIES = 3

type HeldCopy = { copy: ReadCopy; through: number; pulledAt: number; used: number }

/**
 * Copies other devices keep (`ReadingCopies`), read here: pulled into a record store of their own (only the versions
 * past the last pull, and only the chunks this store lacks), the newest version restored into a home made for the
 * read and parsed, entry by entry against `EntrySchema`. The last few read are held, and pulled again at most every 10
 * seconds, so paging back through one reads it once.
 */
export class ReceivedCopies {
  readonly #folder: string
  readonly #remote: (link: { current: RecordsLink }) => RecordRemote
  readonly #now: () => number
  #store: RecordStore | null = null
  /** Each device's records as pulled from: the link renewed in place, and the remote's own ID, which names its cursors. */
  readonly #links = new Map<string, { holder: { current: RecordsLink }; sync: RecordSync; remote: string }>()
  readonly #held = new Map<string, HeldCopy>()
  readonly #reading = new Map<string, Promise<HeldCopy | null>>()

  constructor(folder: string, options: { now?: () => number; remote?: (link: { current: RecordsLink }) => RecordRemote } = {}) {
    this.#folder = folder
    this.#now = options.now ?? Date.now
    this.#remote = options.remote ?? ((link) => recordsOverHttp({ id: link.current.id, base: link.current.base, authorization: () => link.current.authorization }))
  }

  /** The copy of a Session another device keeps at `link`, as of now; null when it keeps none. */
  async read(link: RecordsLink, harness: string, nativeId: string): Promise<ReadCopy | null> {
    return (await this.#copy(link, harness, nativeId))?.copy ?? null
  }

  /** A page of it, newest first (`ThreadPage`'s paging): entries ending before `before`. */
  async page(link: RecordsLink, harness: string, nativeId: string, before: number | undefined, limit: number): Promise<CopyPage | null> {
    const held = await this.#copy(link, harness, nativeId)
    if (!held) return null
    const { header, entries } = held.copy
    const end = Math.min(before ?? entries.length, entries.length)
    const start = Math.max(0, end - limit)
    return { header, entries: entries.slice(start, end), start, total: entries.length }
  }

  /** One of its entries, by ID. */
  async entry(link: RecordsLink, harness: string, nativeId: string, id: string): Promise<Entry | null> {
    return (await this.#copy(link, harness, nativeId))?.copy.entries.find((entry) => entry.id === id) ?? null
  }

  close(): void {
    this.#store?.close()
    this.#store = null
  }

  #copy(link: RecordsLink, harness: string, nativeId: string): Promise<HeldCopy | null> {
    const key = `${link.id}\n${harness}\n${nativeId}`
    const held = this.#held.get(key)
    if (held && this.#now() - held.pulledAt < PULL_EVERY_MS) {
      held.used = this.#now()
      return Promise.resolve(held)
    }
    let reading = this.#reading.get(key)
    if (!reading) {
      reading = this.#pull(key, link, harness, nativeId).finally(() => this.#reading.delete(key))
      this.#reading.set(key, reading)
    }
    return reading
  }

  async #pull(key: string, link: RecordsLink, harness: string, nativeId: string): Promise<HeldCopy | null> {
    const store = (this.#store ??= new RecordStore(join(this.#folder, "store"), new NativeStores(true, join(this.#folder, "restored"))))
    let remote = this.#links.get(link.id)
    if (remote) remote.holder.current = link
    else {
      const holder = { current: link }
      const records = this.#remote(holder)
      remote = { holder, sync: new RecordSync(store, records), remote: records.id }
      this.#links.set(link.id, remote)
    }
    await remote.sync.pull(harness, nativeId)
    const through = store.pulledThrough(remote.remote, harness, nativeId)
    const held = this.#held.get(key)
    if (held && held.through === through) {
      held.pulledAt = held.used = this.#now()
      return held
    }
    if (!store.units(harness, nativeId).length) return null
    // A home of its own for each read, gone once it's parsed: nothing here is read again from it.
    const home = join(this.#folder, "homes", createHash("sha1").update(key).digest("hex"), String(through))
    try {
      await store.restore({ harness, nativeId, home, roots: [{ name: "copy", path: home }] })
      const text = await readFile(join(home, copyName(harness, nativeId)), "utf8")
      const copy = parseCopy(text)
      const fresh: HeldCopy = { copy, through, pulledAt: this.#now(), used: this.#now() }
      this.#held.set(key, fresh)
      for (const [other, value] of [...this.#held].sort((left, right) => right[1].used - left[1].used).slice(HELD_COPIES)) {
        if (value !== fresh) this.#held.delete(other)
      }
      return fresh
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }
}

/** A copy's text, read: its header line, then an entry a line, each checked; a line that isn't one fails the read. */
export function parseCopy(text: string): ReadCopy {
  const lines = text.split("\n")
  const header = CopyHeaderSchema.parse(JSON.parse(lines[0] ?? ""))
  const entries: Entry[] = []
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]
    if (!line) continue
    entries.push(EntrySchema.parse(JSON.parse(line)))
  }
  return { header, entries }
}

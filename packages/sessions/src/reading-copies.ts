import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { z } from "zod"
import { recordsOverHttp } from "@mako/protocol/records-http"
import type { ThreadRef } from "./format.js"
import { NativeStores } from "./read-only-sqlite.js"
import { RecordStore } from "./record-store.js"
import type { RecordRemote, RecordsLink } from "./record-sync.js"
import { namedWork, type WorkUnderWay } from "./loop-watch.js"
import { ScopedUploads, type SyncScope, type UploadsStatus } from "./scoped-uploads.js"
import type { SessionView } from "./view-cache.js"
import { ZstdFrames } from "./zstd-frames.js"
import { COPY_FORMAT, CopyHeaderSchema, CopyManifestSchema, CopyReader, type CopyHeader, type CopyManifest, type CopyPage, type CopyReaderOptions, type CopyStore, type HeldCopy, type ReadCopy } from "./copy-reader.js"
import type { UploadBudget } from "./upload-budget.js"

/**
 * A device's reading copies: each Session its account lists, as Mako draws it (its view's entries, one JSON line
 * each), kept in the account's records for that device, so another device reads one while this one is off. Not the
 * Session's records: a Cursor chat's records hold its store's every checkpoint, and an editor chat's the editor's whole
 * database; a copy holds only what Mako shows, and reads on a device without the harness. The records go up beside
 * it, to the device's originals (`SessionCatalog.syncOriginals`), for continuing the Session anywhere.
 *
 * A copy is written where its Session changed and its turn came: one at work or worked in today within seconds of
 * its capture (`changed`; at most every second, a large one less often, its size permitting), an older one a minute
 * after it last went, in the scope's order (`SyncScope`), the ones at work first. Each is captured into a record
 * store of its own, so content-defined chunks carry only what changed, and pushed to the account in the same order
 * (`ScopedUploads`), which keeps in that store what the account holds.
 */
export { COPY_FORMAT, CopyHeaderSchema, CopyPageSchema, parseCopy, type CopyHeader, type CopyPage, type ReadCopy } from "./copy-reader.js"

/** How the catalog reads a Session as Mako draws it, decoding only when its view is out of date: what a copy reads of it. */
export type CopyViews = {
  view(path: string): Promise<{ view: Pick<SessionView, "total" | "translator" | "json">; ref: ThreadRef } | null>
  stamp(path: string): string | null
  translator(): string
}

/** How often a Session at work is copied, at the most: a large one waits longer, by its size (`MS_PER_MIB`). */
const BUSY_EVERY_MS = 1_000
/** And one at rest since before today, after it last went. */
const REST_EVERY_MS = 60_000
/**
 * Any copy waits this long for each MiB its last one held, whatever its tier: each copy is written and captured whole,
 * about 4 ms of work a MiB, so a 146 MB Session at work goes about every 15 s at under a twentieth of a core. Writing
 * no longer holds the catalog's thread (`COPY_SLICE_ENTRIES`); this paces only the work. It was 2 s a MiB while a
 * copy was written in one go, which held the thread 1 to 7 s, timed out the sync status, and put a large Session's
 * copy five minutes behind.
 */
const MS_PER_MIB = 100
/** The least a wake for a Session's turn waits, so turns due together are one look. */
const WAKE_LEAST_MS = 100
/**
 * A copy is written this many entries at a time, as bytes, the thread free between them for the requests it answers.
 * Few enough that a slice of large entries (a tool's whole output) stays a few MiB: written in one go, as strings, a
 * 150 MB copy took the sync daemon past 500 MB and its memory guard retired it.
 */
const COPY_SLICE_ENTRIES = 64
const NEWLINE = Buffer.from("\n")
/** How often copies are looked at; a look that finds nothing changed reads a stamp a Session. */
const LOOK_EVERY_MS = 5_000
/** Catching up on copies goes at no more than this, so a first upload of a week never fills the connection. */
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
type Wanted = SyncScope["sessions"][number]
const keyOf = (session: { harness: string; nativeId: string }) => `${session.harness}\n${session.nativeId}`

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
  /** The scope's Sessions by `<harness>\n<native id>`, which a capture names. */
  #inScope = new Map<string, Wanted>()
  /** What each Session's copy was last written from, by `<harness>\n<native id>`; read from the files after a restart. */
  readonly #copied = new Map<string, Copied>()
  /** The one look under way: every other waits for it, merged into the next. */
  #looking: Promise<void> | undefined
  /** A look over the whole scope is wanted next. */
  #all = false
  /** Sessions captured since the look under way began, looked at once it ends: a burst of captures is one look. */
  readonly #captured = new Map<string, Wanted>()
  #timer: ReturnType<typeof setInterval> | undefined
  /** Sessions changed before their turn came, by `<harness>\n<native id>`, with when it comes (`#arm`). */
  readonly #waiting = new Map<string, { session: Wanted; at: number }>()
  #wake: { timer: ReturnType<typeof setTimeout> } | undefined
  /** Names each copy while it's written, for the watch on the process's loop. */
  readonly #work: WorkUnderWay | undefined
  /** The zstd context a copy reads its view's compressed entries through (`ZstdFrames`). */
  readonly #frames = new ZstdFrames()
  /** The bytes this process's uploads share, the originals' included (`UploadBudget`). */
  readonly #budget: UploadBudget | undefined
  #stopped = false

  constructor(
    folder: string,
    views: CopyViews,
    log: (level: "info" | "warn", message: string, fields: Record<string, string | number>) => void,
    options: { now?: () => number; remote?: (link: { current: RecordsLink }) => RecordRemote; work?: WorkUnderWay; budget?: UploadBudget } = {}
  ) {
    this.#work = options.work
    this.#budget = options.budget
    this.#folder = folder
    this.#views = views
    this.#log = log
    this.#now = options.now ?? Date.now
    this.#remote = options.remote ?? ((link) => recordsOverHttp({ id: link.current.id, base: link.current.base, authorization: () => link.current.authorization }))
  }

  /** The Sessions to keep copies of, most wanted first; said again as the list changes. */
  scope(scope: SyncScope): void {
    this.#scope = scope
    this.#inScope = new Map(scope.sessions.map((session) => [keyOf(session), session]))
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
    if (this.#wake) clearTimeout(this.#wake.timer)
    this.#wake = undefined
    if (!link || this.#stopped) return
    const store = this.#open()
    const remote = { current: link }
    this.#uploads = new ScopedUploads(store, this.#remote(remote), this.#log, { bytesPerSecond: COPIES_BYTES_PER_SECOND, ...this.#work && { work: this.#work }, ...this.#budget && { budget: this.#budget } })
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
  readable(session: Wanted): boolean {
    return (this.#uploads?.inCloud(session.harness, session.nativeId) ?? false) && this.current(session)
  }

  /** Whether the Session's copy was written from its records as they are now; true when its records can't be read. */
  current(session: Wanted): boolean {
    const records = this.#views.stamp(session.path)
    const copied = this.#copied.get(keyOf(session))
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
    this.#frames.close()
  }

  #open(): RecordStore {
    this.#store ??= new RecordStore(join(this.#folder, "store"), new NativeStores(true, join(this.#folder, "restored")))
    return this.#store
  }

  /**
   * A Session's records were just captured: its copy is looked at now, alone, instead of at the next look over the
   * whole scope, so a turn that just ended is readable elsewhere within seconds. One not in scope is nothing to do;
   * captures that land while a look is under way are looked at together once it ends.
   */
  changed(harness: string, nativeId: string): void {
    const key = keyOf({ harness, nativeId })
    const session = this.#inScope.get(key)
    if (!session) return
    this.#captured.set(key, session)
    this.#next()
  }

  /** Looks at every Session in scope, now or once the look under way ends. */
  #look(): void {
    this.#all = true
    this.#next()
  }

  /**
   * Starts the look wanted unless one is under way: one look at a time, whatever asks, so neither a scope said again
   * nor a run of captures stacks looks up behind it. A look over the whole scope takes in the captured ones.
   */
  #next(): void {
    if (this.#stopped || !this.#uploads || !this.#scope || this.#looking) return
    let only: Wanted[] | undefined
    if (this.#all) this.#captured.clear()
    else if (this.#captured.size) only = [...this.#captured.values()]
    else return
    this.#all = false
    this.#captured.clear()
    this.#looking = this.#lookOnce(only)
      .catch((error: Error) => this.#log("warn", "copies stopped looking", { error: error.message }))
      .finally(() => {
        this.#looking = undefined
        this.#next()
      })
  }

  async #lookOnce(only?: readonly Wanted[]): Promise<void> {
    const scope = this.#scope
    if (!scope) return
    const translator = this.#views.translator()
    for (const session of only ?? scope.sessions) {
      if (this.#stopped || !this.#uploads || this.#scope !== scope) return
      if (scope.paused && !session.busy) continue
      const records = this.#views.stamp(session.path)
      if (!records) continue
      const stamp = `${records}\n${translator}`
      const key = keyOf(session)
      const file = copyFile(this.#folder, session.harness, session.nativeId)
      const copied = this.#copied.get(key) ?? (await this.#fromFile(key, file))
      if (copied?.stamp === stamp) continue
      const now = this.#now()
      // One at work, or worked in today, goes again within seconds of a change: a turn that just ended is the one another
      // device opens next. Older ones changing again wait a minute. A large one, either way, as its size allows.
      const every = Math.max(session.busy || session.tier === "day" ? BUSY_EVERY_MS : REST_EVERY_MS, ((copied?.bytes ?? 0) / (1024 * 1024)) * MS_PER_MIB)
      if (copied && now - copied.at < every) {
        // Changed before its turn: it goes once its turn comes, not at the next look over the scope.
        this.#waiting.set(key, { session, at: copied.at + every })
        continue
      }
      this.#waiting.delete(key)
      await namedWork(this.#work, `copy ${session.harness} ${session.nativeId.slice(0, 8)}`, () => this.#copy(session, key, file, stamp))
    }
    this.#arm()
  }

  /** Wakes for the first of the Sessions waiting for their turn, and looks at every one whose turn came then. */
  #arm(): void {
    if (this.#wake) clearTimeout(this.#wake.timer)
    this.#wake = undefined
    if (!this.#waiting.size || this.#stopped) return
    const at = Math.min(...[...this.#waiting.values()].map((each) => each.at))
    const timer = setTimeout(() => {
      this.#wake = undefined
      const now = this.#now()
      for (const [key, { session, at: due }] of this.#waiting) {
        if (due > now) continue
        this.#waiting.delete(key)
        if (this.#inScope.has(key)) this.#captured.set(key, this.#inScope.get(key) ?? session)
      }
      this.#next()
      this.#arm()
    }, Math.max(WAKE_LEAST_MS, at - this.#now()))
    timer.unref?.()
    this.#wake = { timer }
  }

  async #fromFile(key: string, file: string): Promise<Copied | undefined> {
    const header = await readCopyHeader(file)
    if (!header) return undefined
    const bytes = (await stat(file).catch(() => null))?.size ?? 0
    const copied = { stamp: header.stamp, at: header.at, bytes }
    this.#copied.set(key, copied)
    return copied
  }

  async #copy(session: Wanted, key: string, file: string, stamp: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true })
    const served = await this.#views.view(session.path)
    if (!served || this.#stopped) return
    const { view, ref } = served
    const header: CopyHeader = { copy: COPY_FORMAT, harness: session.harness, nativeId: session.nativeId, translator: view.translator, total: view.total, stamp, at: this.#now() }
    if (ref.title) header.title = ref.title
    if (ref.cwd) header.cwd = ref.cwd
    if (ref.model) header.model = ref.model
    const temporary = `${file}.${process.pid}.tmp`
    // A slice of entries at a time, as the view keeps them, the thread free between slices: a 146 MB copy written in
    // one go held it 1 to 7 s. A view written again meanwhile is closed under the copy, which then waits for the next
    // look, whose stamp is the new one's.
    const handle = await open(temporary, "w")
    let bytes = 0
    try {
      const write = async (parts: Uint8Array[]) => {
        for (const part of parts) bytes += part.byteLength
        await handle.writev(parts)
      }
      await write([Buffer.from(JSON.stringify(header)), NEWLINE])
      for (let start = 0; start < view.total; start += COPY_SLICE_ENTRIES) {
        const lines = await view.json(start, Math.min(view.total, start + COPY_SLICE_ENTRIES), this.#frames)
        if (lines.length) await write(lines.flatMap((line) => [line, NEWLINE]))
        if (this.#stopped) break
      }
    } catch (error) {
      await handle.close()
      await rm(temporary, { force: true })
      this.#log("info", "a copy was left for the next look", { harness: session.harness, nativeId: session.nativeId, error: error instanceof Error ? error.message : String(error) })
      return
    }
    await handle.close()
    if (this.#stopped) {
      await rm(temporary, { force: true })
      return
    }
    await rename(temporary, file)
    const root = join(this.#folder, "files")
    await this.#open().capture({ harness: session.harness, nativeId: session.nativeId, home: root, records: { roots: [{ name: "copy", path: root }], files: [file], databases: [] } })
    this.#copied.set(key, { stamp, at: header.at, bytes })
    this.#uploads?.look()
  }
}

/**
 * Copies other devices keep (`ReadingCopies`), read here by the reader every device runs (`CopyReader`): what it
 * reads kept in a folder of this device's (`FolderCopyStore`), so a copy read again fetches only its new chunks, and
 * one whose device and account are both out of reach still reads as it was last read.
 */
export class ReceivedCopies {
  readonly #reader: CopyReader
  /** Each device's records as read from: the link renewed in place, and its remote. */
  readonly #links = new Map<string, { holder: { current: RecordsLink }; remote: RecordRemote }>()
  /** The zstd context the chunks read here are decoded through (`ZstdFrames`). */
  readonly #frames = new ZstdFrames()
  readonly #remote: (link: { current: RecordsLink }) => RecordRemote

  constructor(folder: string, options: { now?: () => number; remote?: (link: { current: RecordsLink }) => RecordRemote; log?: CopyReaderOptions["log"] } = {}) {
    const remote = options.remote ?? ((link) => recordsOverHttp({ id: link.current.id, base: link.current.base, authorization: () => link.current.authorization }))
    this.#remote = remote
    this.#reader = new CopyReader({
      remote: (device) => {
        const held = this.#links.get(device)
        if (!held) throw new Error(`No link to the records of ${device}`)
        return held.remote
      },
      store: new FolderCopyStore(folder),
      decode: (frame) => this.#frames.decompress(frame),
      ...options.now && { now: options.now },
      ...options.log && { log: options.log },
    })
  }

  /** The copy of a Session another device keeps at `link`, as of now; null when it keeps none. */
  async read(link: RecordsLink, harness: string, nativeId: string): Promise<ReadCopy | null> {
    return (await (await this.#copy(link, harness, nativeId))?.read()) ?? null
  }

  /** A page of it, newest first (`ThreadPage`'s paging): entries ending before `before`. */
  async page(link: RecordsLink, harness: string, nativeId: string, before: number | undefined, limit: number): Promise<CopyPage | null> {
    const copy = await this.#copy(link, harness, nativeId)
    if (!copy) return null
    const page = await copy.page(before, limit)
    void copy.fill()
    return page
  }

  close(): void {
    this.#frames.close()
  }

  #copy(link: RecordsLink, harness: string, nativeId: string): Promise<HeldCopy | null> {
    const held = this.#links.get(link.id)
    if (held) held.holder.current = link
    else {
      const holder = { current: link }
      this.#links.set(link.id, { holder, remote: this.#remote(holder) })
    }
    return this.#reader.open(link.id, harness, nativeId)
  }
}

/**
 * What a Mac keeps of the copies it read (`CopyStore`), in a folder: each Session's manifest a JSON file by its key's
 * hash, each chunk's plain bytes a file by its hash. Written to a temporary name and renamed, so a read never meets
 * half a file; one that fails to read is a chunk to fetch again.
 */
export class FolderCopyStore implements CopyStore {
  readonly #folder: string

  constructor(folder: string) {
    this.#folder = folder
  }

  async manifest(key: string): Promise<CopyManifest | undefined> {
    return (await this.#readManifest(this.#manifestFile(key)))?.manifest
  }

  async keepManifest(key: string, manifest: CopyManifest): Promise<void> {
    await this.#write(this.#manifestFile(key), Buffer.from(JSON.stringify({ key, manifest })))
  }

  async manifests(): Promise<Array<[string, CopyManifest]>> {
    const folder = join(this.#folder, "manifests")
    const names = await readdir(folder).catch(() => [])
    const read = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => this.#readManifest(join(folder, name))))
    return read.flatMap((each): Array<[string, CopyManifest]> => (each ? [[each.key, each.manifest]] : []))
  }

  async chunks(hashes: readonly string[]): Promise<Map<string, Uint8Array>> {
    const found = new Map<string, Uint8Array>()
    await Promise.all(
      [...new Set(hashes)].map(async (hash) => {
        const bytes = await readFile(this.#chunkFile(hash)).catch(() => null)
        if (bytes) found.set(hash, bytes)
      })
    )
    return found
  }

  async keepChunks(chunks: ReadonlyMap<string, Uint8Array>): Promise<void> {
    await Promise.all([...chunks].map(([hash, bytes]) => this.#write(this.#chunkFile(hash), bytes)))
  }

  async forget(keys: readonly string[], chunks: readonly string[]): Promise<void> {
    await Promise.all([...keys.map((key) => this.#manifestFile(key)), ...chunks.map((hash) => this.#chunkFile(hash))].map((file) => rm(file, { force: true })))
  }

  #manifestFile(key: string): string {
    return join(this.#folder, "manifests", `${createHash("sha1").update(key).digest("hex")}.json`)
  }

  #chunkFile(hash: string): string {
    return join(this.#folder, "chunks", hash.slice(0, 2), hash)
  }

  async #readManifest(file: string): Promise<{ key: string; manifest: CopyManifest } | undefined> {
    const text = await readFile(file, "utf8").catch(() => null)
    if (!text) return undefined
    try {
      return KeptManifestSchema.parse(JSON.parse(text))
    } catch {
      return undefined
    }
  }

  async #write(file: string, bytes: Uint8Array): Promise<void> {
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, bytes)
    await rename(temporary, file)
  }
}

const KeptManifestSchema = z.object({ key: z.string(), manifest: CopyManifestSchema })

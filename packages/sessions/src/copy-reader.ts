import { z } from "zod"
import type { GatewayCallTrace } from "@mako/protocol/gateway-http"
import { currentVersions, RECORD_ASK_HASHES, versionChunks, type RecordRemote, type RecordUnit } from "@mako/protocol/records"
import { EntrySchema, type Entry } from "./entries.js"

/**
 * Reading another device's copy of a Session (`ReadingCopies` writes them): the one reader a Mac's sync process and a
 * browser both run, so a copy reads the same wherever it's opened. Nothing here touches a disk or Node: what it keeps
 * goes through a `CopyStore` (a Mac's folder, a browser's IndexedDB, memory), and the chunks' zstd through `decode`.
 *
 * A copy is one file in its device's records: a header line, then one entry a line, rewritten whole each time it's
 * written and captured in content-defined chunks, so a new version shares nearly every chunk with the last. A read
 * asks what the Session's records hold now (`RecordRemote.head`, one small answer however many versions there were;
 * a gateway from before it is pulled from instead), fetches only the chunks the store lacks, each checked against its
 * hash, and opens at the newest page: the header's chunk and enough chunks from the end for it, never the whole copy,
 * so a copy of 150 MB opens as fast as one of 50 KB. The rest fills in after, for paging back and for reading offline.
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

/** What a reader last read of one Session's copy: the records' number it read at, its chunks in order, and its size. */
export const CopyManifestSchema = z.object({
  through: z.number().int().nonnegative(),
  /** Its chunks' hashes, in order, laid end to end, as a version names them. */
  chunks: z.string(),
  size: z.number().int().nonnegative(),
  readAt: z.number(),
})
export type CopyManifest = z.infer<typeof CopyManifestSchema>

/**
 * Where a reader keeps what it read, so a copy opened again reads only what changed and one opened offline reads at
 * all: each Session's last manifest, by `copyKey`, and the chunks' plain bytes by hash. Which to let go is the
 * reader's rule (`COPIES_KEPT`, `KEPT_BYTES`), the same in every store.
 */
export interface CopyStore {
  manifest(key: string): Promise<CopyManifest | undefined>
  keepManifest(key: string, manifest: CopyManifest): Promise<void>
  manifests(): Promise<Array<[string, CopyManifest]>>
  chunks(hashes: readonly string[]): Promise<Map<string, Uint8Array>>
  keepChunks(chunks: ReadonlyMap<string, Uint8Array>): Promise<void>
  /** Lets go of these Sessions' manifests and these chunks. */
  forget(keys: readonly string[], chunks: readonly string[]): Promise<void>
}

/** A store in memory: what a reader keeps when it's given none. */
export class MemoryCopyStore implements CopyStore {
  readonly #manifests = new Map<string, CopyManifest>()
  readonly #chunks = new Map<string, Uint8Array>()

  manifest(key: string): Promise<CopyManifest | undefined> {
    return Promise.resolve(this.#manifests.get(key))
  }
  keepManifest(key: string, manifest: CopyManifest): Promise<void> {
    this.#manifests.set(key, manifest)
    return Promise.resolve()
  }
  manifests(): Promise<Array<[string, CopyManifest]>> {
    return Promise.resolve([...this.#manifests])
  }
  chunks(hashes: readonly string[]): Promise<Map<string, Uint8Array>> {
    const found = new Map<string, Uint8Array>()
    for (const hash of hashes) {
      const bytes = this.#chunks.get(hash)
      if (bytes) found.set(hash, bytes)
    }
    return Promise.resolve(found)
  }
  keepChunks(chunks: ReadonlyMap<string, Uint8Array>): Promise<void> {
    for (const [hash, bytes] of chunks) this.#chunks.set(hash, bytes)
    return Promise.resolve()
  }
  forget(keys: readonly string[], chunks: readonly string[]): Promise<void> {
    for (const key of keys) this.#manifests.delete(key)
    for (const hash of chunks) this.#chunks.delete(hash)
    return Promise.resolve()
  }
}

/** One read of a copy, for a log and for Diagnostics: how it was read, what it cost, and how long it took. */
export type CopyRead = {
  device: string
  harness: string
  nativeId: string
  /**
   * `head`: the account's word now; `pull`: a gateway without `head`, pulled from; `kept`: what this store kept, opened
   * before the account's word (`changed` given) or because the account didn't answer (`error` says why).
   */
  via: "head" | "pull" | "kept"
  through: number
  size: number
  chunks: number
  /** Chunks fetched from the account for the newest page, and their stored bytes. */
  fetched: number
  fetchedBytes: number
  ms: number
  at: number
  /** The account's correlation ID for the read of what it holds, which its logs file the read under. */
  correlationId?: string
  error?: string
}

export type CopyReaderOptions = {
  /** Where a device's records are read: its records in the account. */
  remote(device: string): RecordRemote
  store?: CopyStore
  /** A chunk's zstd frame, decoded: a Mac's zlib, a browser's decoder. */
  decode(frame: Uint8Array): Uint8Array | Promise<Uint8Array>
  /** A chunk's SHA-256, as hex; Web Crypto's by default, which Node and every browser have. */
  digest?(bytes: Uint8Array): Promise<string>
  log?(level: "info" | "warn", message: string, fields: Record<string, string | number | boolean>): void
  now?(): number
  /**
   * A copy opened from what the store kept turned out older than the account's: its readers read it again. Given, a
   * copy the store kept opens at once, before the account is asked, and is checked against the account's after.
   */
  changed?(device: string, harness: string, nativeId: string): void
}

/** A copy read again at most this often: a reader paging back through one asks every page. */
export const READ_EVERY_MS = 10_000
/** Copies a store keeps, newest read first, and the most bytes they hold together (the newest is always kept). */
export const COPIES_KEPT = 8
export const KEPT_BYTES = 64 * 1024 * 1024
/** Copies held open in memory: the ones on screen now. */
const HELD_COPIES = 3
/**
 * Bytes read from the end for a copy's newest page at first: a page and more of most Sessions. Counted in chunks by the
 * copy's own average (content-defined, 4 to 64 KiB), so a copy of large chunks isn't read half through for one page.
 */
export const TAIL_BYTES = 512 * 1024
/** A copy filled in after its newest page only up to this size; past it, earlier pages are read as they're asked. */
const FILL_BYTES = 32 * 1024 * 1024
/** Chunks one fill asks for at a time. */
const FILL_CHUNKS = 512

/** Where a reader names a Session's copy: its device, its harness and its native session. */
export function copyKey(device: string, harness: string, nativeId: string): string {
  return `${device}\n${harness}\n${nativeId}`
}

async function sha256(bytes: Uint8Array): Promise<string> {
  // SAFETY: a view over an ArrayBuffer, never a SharedArrayBuffer: each is a decoder's output or a response's body.
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))
  let hex = ""
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0")
  return hex
}

/** The copy among a Session's units: its one file, a `.copy`. */
function copyUnit(units: readonly RecordUnit[]): RecordUnit | undefined {
  return units.find((unit) => unit.key.endsWith(".copy")) ?? (units.length === 1 ? units[0] : undefined)
}

type Held = { copy: HeldCopy | null; readAt: number; used: number }

export class CopyReader {
  readonly #options: CopyReaderOptions
  readonly #store: CopyStore
  readonly #now: () => number
  readonly #digest: (bytes: Uint8Array) => Promise<string>
  readonly #held = new Map<string, Held>()
  readonly #reading = new Map<string, Promise<HeldCopy | null>>()
  readonly #reads = new Map<string, CopyRead>()

  constructor(options: CopyReaderOptions) {
    this.#options = options
    this.#store = options.store ?? new MemoryCopyStore()
    this.#now = options.now ?? Date.now
    this.#digest = options.digest ?? sha256
  }

  /**
   * The copy of a Session another device keeps, as the account holds it now, or as last read within `READ_EVERY_MS`;
   * null when it keeps none. `fresh` reads the account's word again whatever the last read's age. Unreachable, the
   * copy this store kept answers, said so in its read (`via: "kept"`); with none kept the failure is thrown. Where the
   * reader can say a copy changed (`changed`), one this store kept answers first, and the account's is read after.
   */
  open(device: string, harness: string, nativeId: string, how: { fresh?: boolean } = {}): Promise<HeldCopy | null> {
    const key = copyKey(device, harness, nativeId)
    const held = this.#held.get(key)
    if (held && !how.fresh && this.#now() - held.readAt < READ_EVERY_MS) {
      held.used = this.#now()
      return Promise.resolve(held.copy)
    }
    let reading = this.#reading.get(key)
    if (!reading) {
      reading = this.#read(key, device, harness, nativeId, how.fresh ?? false).finally(() => this.#reading.delete(key))
      this.#reading.set(key, reading)
    }
    return reading
  }

  /** How the last read of each copy went, newest first: what Diagnostics says. */
  reads(): CopyRead[] {
    return [...this.#reads.values()].sort((left, right) => right.at - left.at)
  }

  async #read(key: string, device: string, harness: string, nativeId: string, fresh: boolean): Promise<HeldCopy | null> {
    const began = this.#now()
    const held = this.#held.get(key)?.copy
    const kept = held?.manifest ?? (await this.#store.manifest(key))
    // Opened from the store at once, where a newer one can be said once the account's word comes: a phone opening a
    // Thread it read before paints it from its own storage, with no round trip first.
    if (!held && kept && !fresh && this.#options.changed) {
      const opened = await this.#opened(key, device, harness, nativeId, kept, began).catch((error: Error) => {
        this.#log("info", "a kept copy couldn't be opened from this device's storage; the account is asked", { device, harness, nativeId, error: error.message })
        return undefined
      })
      if (opened) {
        void this.#fromAccount(key, device, harness, nativeId, kept, this.#now())
          .then((copy) => {
            if (copy?.manifest.chunks !== opened.manifest.chunks) this.#options.changed?.(device, harness, nativeId)
          })
          .catch((error: Error) => this.#log("warn", "a kept copy couldn't be checked against the account's", { device, harness, nativeId, error: error.message }))
        return opened
      }
    }
    return this.#fromAccount(key, device, harness, nativeId, kept, began)
  }

  /** A copy as this store kept it, its newest page held from the store's chunks: what the account says is checked after. */
  async #opened(key: string, device: string, harness: string, nativeId: string, kept: CopyManifest, began: number): Promise<HeldCopy> {
    const fields = { device, harness, nativeId }
    const remote = this.#options.remote(device)
    const copy = new HeldCopy(kept, (hashes) => this.#chunks(remote, hashes), (level, message, more) => this.#log(level, message, { ...fields, ...more }))
    const fetched = { chunks: 0, bytes: 0 }
    copy.counting(fetched)
    await copy.ready()
    copy.counting(undefined)
    this.#remember(key, copy)
    const read: CopyRead = { ...fields, via: "kept", through: kept.through, size: kept.size, chunks: copy.chunkCount, fetched: fetched.chunks, fetchedBytes: fetched.bytes, ms: this.#now() - began, at: this.#now() }
    this.#reads.set(key, read)
    this.#log("info", "a copy was opened from what this device kept; the account's is read after", { ...read })
    return copy
  }

  /** The copy as the account holds it now; `kept`, what this store last read, answers when the account doesn't. */
  async #fromAccount(key: string, device: string, harness: string, nativeId: string, kept: CopyManifest | undefined, began: number): Promise<HeldCopy | null> {
    let manifest: CopyManifest | null
    let via: CopyRead["via"]
    let error: string | undefined
    const remote = this.#options.remote(device)
    const trace: GatewayCallTrace = { tries: 0, failures: [] }
    try {
      const head = await remote.head?.(harness, nativeId, trace)
      if (head === undefined) {
        manifest = await this.#pulled(remote, harness, nativeId, kept)
        via = "pull"
      } else {
        const unit = head && copyUnit(head.units)
        manifest = head && unit ? this.#manifestOf(head.through, currentVersions(unit.versions)) : null
        via = "head"
      }
    } catch (failure) {
      if (!kept) throw failure
      manifest = kept
      via = "kept"
      error = failure instanceof Error ? failure.message : String(failure)
    }
    if (!manifest) {
      this.#remember(key, null)
      this.#log("info", "a copy was asked for that the account doesn't hold", { device, harness, nativeId, via })
      return null
    }
    const held = this.#held.get(key)?.copy
    const copy = held && held.manifest.chunks === manifest.chunks ? held : new HeldCopy(manifest, (hashes) => this.#chunks(remote, hashes), (level, message, fields) => this.#log(level, message, { device, harness, nativeId, ...fields }))
    const fetched = { chunks: 0, bytes: 0 }
    copy.counting(fetched)
    await copy.ready()
    copy.counting(undefined)
    this.#remember(key, copy)
    await this.#keep(key, { ...manifest, readAt: this.#now() })
    const read: CopyRead = { device, harness, nativeId, via, through: manifest.through, size: manifest.size, chunks: copy.chunkCount, fetched: fetched.chunks, fetchedBytes: fetched.bytes, ms: this.#now() - began, at: this.#now(), ...trace.correlationId && { correlationId: trace.correlationId }, ...error && { error } }
    this.#reads.set(key, read)
    this.#log(via === "kept" ? "warn" : "info", via === "kept" ? "a copy was read from what this device kept: the account didn't answer" : "a copy was read", { ...read })
    return copy
  }

  #manifestOf(through: number, versions: ReturnType<typeof currentVersions>): CopyManifest {
    return { through, chunks: versions.map((version) => version.chunks).join(""), size: versions.at(-1)?.size ?? 0, readAt: this.#now() }
  }

  /**
   * A copy's manifest from a gateway without `head`: its versions pulled past the last read's number, so only what's
   * new crosses. A copy is rewritten whole each time (`replace`), so the newest version is all of it; an append after
   * the last read's adds to what it held.
   */
  async #pulled(remote: RecordRemote, harness: string, nativeId: string, kept: CopyManifest | undefined): Promise<CopyManifest | null> {
    let after = kept?.through ?? 0
    let chunks = kept?.chunks ?? ""
    let size = kept?.size ?? 0
    for (;;) {
      const pulled = await remote.pull(harness, nativeId, after)
      if (!pulled) return null
      const unit = copyUnit(pulled.bundle.units)
      for (const version of unit?.versions ?? []) {
        if (version.kind === "delete") chunks = ""
        else chunks = version.kind === "replace" ? version.chunks : chunks + version.chunks
        size = version.kind === "delete" ? 0 : version.size
      }
      after = pulled.through
      if (!pulled.more) break
    }
    return chunks ? { through: after, chunks, size, readAt: this.#now() } : null
  }

  #remember(key: string, copy: HeldCopy | null): void {
    this.#held.set(key, { copy, readAt: this.#now(), used: this.#now() })
    for (const [other] of [...this.#held].sort((left, right) => right[1].used - left[1].used).slice(HELD_COPIES)) if (other !== key) this.#held.delete(other)
  }

  /** Keeps the manifest, and lets go of the copies past `COPIES_KEPT` or `KEPT_BYTES`, with the chunks only they named. */
  async #keep(key: string, manifest: CopyManifest): Promise<void> {
    await this.#store.keepManifest(key, manifest)
    const all = (await this.#store.manifests()).sort((left, right) => right[1].readAt - left[1].readAt)
    let bytes = 0
    const staying: CopyManifest[] = []
    const going: string[] = []
    for (const [each, kept] of all) {
      bytes += kept.size
      if (each === key || (staying.length < COPIES_KEPT && bytes <= KEPT_BYTES)) staying.push(kept)
      else going.push(each)
    }
    if (!going.length) return
    const named = new Set(staying.flatMap((kept) => versionChunks(kept)))
    const dropped = new Set(all.filter(([each]) => going.includes(each)).flatMap(([, kept]) => versionChunks(kept)).filter((hash) => !named.has(hash)))
    await this.#store.forget(going, [...dropped])
  }

  /**
   * The plain bytes of `hashes`, from the store or else the account: each fetched one checked against its hash and
   * kept. The account answers as many as fit one pack, in the order asked, and is asked again for the rest; a chunk it
   * doesn't hold fails the read, saying which.
   */
  async #chunks(remote: RecordRemote, hashes: readonly string[]): Promise<{ chunks: Map<string, Uint8Array>; fetched: number; bytes: number }> {
    const found = await this.#store.chunks(hashes)
    let lacking = [...new Set(hashes.filter((hash) => !found.has(hash)))]
    let fetched = 0
    let bytes = 0
    while (lacking.length) {
      const packed = await remote.readChunks(lacking.slice(0, RECORD_ASK_HASHES))
      if (!packed.length) throw new Error(`The account holds no chunk ${lacking[0]!.slice(0, 12)} of this copy`)
      const fresh = new Map<string, Uint8Array>()
      await Promise.all(
        packed.map(async (chunk) => {
          // A plain chunk's body is a view of the whole response: copied, so a chunk kept keeps only itself.
          const plain = chunk.codec === 1 ? await this.#options.decode(chunk.body) : chunk.body.slice()
          if (plain.length !== chunk.size || (await this.#digest(plain)) !== chunk.hash) throw new Error(`The chunk ${chunk.hash.slice(0, 12)} of this copy isn't the one its hash names`)
          fresh.set(chunk.hash, plain)
          bytes += chunk.body.length
        })
      )
      await this.#store.keepChunks(fresh)
      for (const [hash, plain] of fresh) found.set(hash, plain)
      fetched += fresh.size
      lacking = lacking.filter((hash) => !fresh.has(hash))
    }
    return { chunks: found, fetched, bytes }
  }

  #log(level: "info" | "warn", message: string, fields: Record<string, string | number | boolean>): void {
    this.#options.log?.(level, message, fields)
  }
}

const NEWLINE = 0x0a
const decoder = new TextDecoder()

type CopyLog = (level: "info" | "warn", message: string, fields: Record<string, string | number | boolean>) => void
type CopyChunks = (hashes: readonly string[]) => Promise<{ chunks: Map<string, Uint8Array>; fetched: number; bytes: number }>

/**
 * One version of a copy, read as far as it's been asked: its header, and the run of chunks it holds to the end, with
 * where each whole line in them starts. A page is the lines it names, parsed then; nothing is parsed before. Each
 * version is its own and never changes: a reader paging through one pages through the same entries however the copy
 * moved on meanwhile.
 */
export class HeldCopy {
  readonly manifest: CopyManifest
  readonly #hashes: string[]
  readonly #bodies: Array<Uint8Array | undefined>
  readonly #load: CopyChunks
  readonly #log: CopyLog
  #header: CopyHeader | undefined
  #total = 0
  /** The run held to the end: the chunk it starts at, its bytes, and where each whole line in it starts. */
  #tail: { from: number; bytes: Uint8Array; starts: number[]; text?: string } | undefined
  #counted: { chunks: number; bytes: number } | undefined
  #filling: Promise<void> | undefined

  constructor(manifest: CopyManifest, load: CopyChunks, log: CopyLog) {
    this.manifest = manifest
    this.#hashes = versionChunks(manifest)
    this.#bodies = this.#hashes.map(() => undefined)
    this.#load = load
    this.#log = log
  }

  get header(): CopyHeader {
    if (!this.#header) throw new Error("This copy hasn't been read yet")
    return this.#header
  }

  /** Its entries: the header's count, checked against its lines once they're all held. */
  get total(): number {
    return this.#total
  }

  get chunkCount(): number {
    return this.#hashes.length
  }

  /** The chunks from the end its newest page is read from at first: about `TAIL_BYTES` of them, at least two. */
  get tailChunks(): number {
    const average = this.manifest.size / Math.max(1, this.#hashes.length)
    return Math.max(2, Math.ceil(TAIL_BYTES / Math.max(1, average)))
  }

  /** Whether every chunk is held: all paging back and reading offline need. */
  get whole(): boolean {
    return this.#tail?.from === 0
  }

  /** Counts what the reads from now fetch, into `into`; undefined stops. */
  counting(into: { chunks: number; bytes: number } | undefined): void {
    this.#counted = into
  }

  /** Its header and its newest page held: the header's chunk from the start, and `tailChunks` from the end, in one read. */
  async ready(): Promise<void> {
    if (this.#header) return
    const last = this.#hashes.length
    await this.#hold([0, ...range(Math.max(0, last - this.tailChunks), last)])
    // A header longer than its first chunk (a long title): the chunks after it until its line ends.
    let through = 0
    while (!this.#bodies[through]!.includes(NEWLINE) && through + 1 < last) await this.#hold([++through])
    const head = concat(this.#bodies.slice(0, through + 1).map((body) => body!))
    const end = head.indexOf(NEWLINE)
    this.#header = CopyHeaderSchema.parse(JSON.parse(decoder.decode(end < 0 ? head : head.subarray(0, end))))
    this.#total = this.#header.total
    this.#retail()
  }

  /** The entries ending before `before` (the newest when it isn't given), at most `limit`: chunks read back as far as it reaches. */
  async page(before: number | undefined, limit: number): Promise<CopyPage> {
    await this.ready()
    const end = Math.min(before ?? this.#total, this.#total)
    const start = Math.max(0, end - limit)
    await this.#reach(start, this.tailChunks)
    const entries: Entry[] = []
    for (let index = start; index < end; index++) entries.push(this.#entryAt(index))
    return { header: this.header, entries, start, total: this.#total }
  }

  /** One entry by its ID, the newest with it; null when none has it. */
  async entry(id: string): Promise<Entry | null> {
    await this.ready()
    const found = this.#find(id)
    if (found || this.whole) return found ?? null
    await this.#reach(0, FILL_CHUNKS)
    return this.#find(id) ?? null
  }

  /** All of it, parsed. */
  async read(): Promise<ReadCopy> {
    await this.ready()
    await this.#reach(0, FILL_CHUNKS)
    const entries: Entry[] = []
    for (let index = 0; index < this.#total; index++) entries.push(this.#entryAt(index))
    return { header: this.header, entries }
  }

  /**
   * The rest of it held, from the end back, up to `FILL_BYTES`: what paging back, or opening it offline later, reads.
   * Started once its newest page is drawn, so it never stands between an open and that page; it says, never throws.
   */
  fill(): Promise<void> {
    this.#filling ??= (async () => {
      if (this.manifest.size > FILL_BYTES) return
      try {
        await this.#reach(0, FILL_CHUNKS)
      } catch (error) {
        this.#log("warn", "a copy's earlier chunks weren't read; they're read as they're asked", { chunks: this.#hashes.length, error: error instanceof Error ? error.message : String(error) })
      }
    })()
    return this.#filling
  }

  async #hold(indexes: readonly number[]): Promise<void> {
    const wanted = [...new Set(indexes)].filter((index) => !this.#bodies[index])
    if (!wanted.length) return
    const { chunks, fetched, bytes } = await this.#load(wanted.map((index) => this.#hashes[index]!))
    if (this.#counted) {
      this.#counted.chunks += fetched
      this.#counted.bytes += bytes
    }
    // A hash named twice in a copy (a run of identical lines) is one chunk, held at each place it's named.
    for (let index = 0; index < this.#hashes.length; index++) this.#bodies[index] ??= chunks.get(this.#hashes[index]!)
  }

  /** Holds chunks back from the end until entry `index` is a whole line among them, `step` more at first, twice as many each time after. */
  async #reach(index: number, step: number): Promise<void> {
    while (this.#firstHeld() > index) {
      const from = this.#tail!.from
      const to = Math.max(0, from - step)
      for (let at = to; at < from; at += RECORD_ASK_HASHES) await this.#hold(range(at, Math.min(from, at + RECORD_ASK_HASHES)))
      this.#retail()
      step *= 2
    }
  }

  /**
   * The run held to the end read again: from the lowest chunk with every one after it held, whichever read held them
   * (a page read back and the fill after an open may hold chunks at once). Its line starts found by its newlines.
   */
  #retail(): void {
    let from = this.#tail?.from ?? this.#hashes.length
    while (from > 0 && this.#bodies[from - 1]) from--
    if (this.#tail?.from === from) return
    const bytes = concat(this.#bodies.slice(from).map((body) => body!))
    const starts: number[] = []
    // From the middle of the copy the run begins inside a line: its first whole line starts after its first newline.
    let at = from === 0 ? 0 : bytes.indexOf(NEWLINE) + 1 || bytes.length
    while (at < bytes.length) {
      starts.push(at)
      const next = bytes.indexOf(NEWLINE, at)
      if (next < 0) break
      at = next + 1
    }
    this.#tail = { from, bytes, starts }
    // From the start, the first line is the header and every other an entry, which the header counted.
    if (from === 0 && starts.length - 1 !== this.#total) {
      this.#log("warn", "a copy's entries aren't the number its header says; its lines are counted instead", { header: this.#total, lines: starts.length - 1 })
      this.#total = Math.max(0, starts.length - 1)
    }
  }

  /** The first entry whose whole line is held. */
  #firstHeld(): number {
    const tail = this.#tail!
    return tail.from === 0 ? 0 : this.#total - tail.starts.length
  }

  #entryAt(index: number): Entry {
    const tail = this.#tail!
    const start = tail.starts[tail.from === 0 ? index + 1 : index - (this.#total - tail.starts.length)]
    if (start === undefined) throw new Error(`The copy's entry ${index} isn't held`)
    const end = tail.bytes.indexOf(NEWLINE, start)
    return EntrySchema.parse(JSON.parse(decoder.decode(tail.bytes.subarray(start, end < 0 ? undefined : end))))
  }

  /** The newest held entry with ID `id`: its line found by its ID's JSON, then parsed and checked. */
  #find(id: string): Entry | undefined {
    const tail = this.#tail!
    tail.text ??= decoder.decode(tail.bytes)
    const text = tail.text
    const named = JSON.stringify(id)
    let at = text.lastIndexOf(named)
    while (at >= 0) {
      const start = text.lastIndexOf("\n", at) + 1
      const end = text.indexOf("\n", at)
      // A line cut off where the run starts isn't one to read; the header parses, but isn't an entry.
      if (start > 0 || tail.from === 0) {
        const parsed = EntrySchema.safeParse(JSON.parse(text.slice(start, end < 0 ? undefined : end)))
        if (parsed.success && parsed.data.id === id) return parsed.data
      }
      at = start > 1 ? text.lastIndexOf(named, start - 2) : -1
    }
    return undefined
  }
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, n) => from + n)
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    bytes.set(part, at)
    at += part.length
  }
  return bytes
}

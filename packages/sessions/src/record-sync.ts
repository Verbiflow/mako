import { CHUNK_HEADER_BYTES, RECORD_ASK_HASHES, RECORD_PACK_BYTES, RECORD_PUSH_WITH_BYTES, RecordConflictError, recordChunks, type PackedChunk, type RecordBundle, type RecordHoldings, type RecordPushAnswer, type RecordRemote, type RecordUnit } from "@mako/protocol/records"
import { z } from "zod"
import { KeptRestoreSchema } from "./kept-restore.js"
import type { StoredChunk } from "./record-chunks.js"
import type { ExportPage, RecordStore } from "./record-store.js"

export type { RecordRemote } from "@mako/protocol/records"

/**
 * A record store kept in step with a remote one (the gateway's, for a Thread): what's captured here goes up as it's
 * written, and what's there comes down past the last pull. Both ways go by the protocol's one rule, so records that
 * went on in two places are refused on whichever side finds it, never stitched, and the refusal is said.
 *
 * A push sends only what the remote isn't known to hold (`RecordStore.exportFor`), its chunks first (only those the
 * remote lacks, in packs), then the versions; a pull asks only past its cursor (`pulledThrough`) and fetches only the
 * chunks this store lacks. A push the remote refuses for a gap means what was known of it is wrong (it was reset, or
 * another store pushed for it): its own holdings replace what's known, and the push goes again, once.
 */

/** Records that went on in two places: the remote's stand, and this side's aren't sent or taken. */
export class RecordSyncConflictError extends Error {
  constructor(
    readonly harness: string,
    readonly nativeId: string,
    readonly key: string,
    readonly seq: number,
    message: string
  ) {
    super(message)
  }
}

/** The calls of one kind an exchange made (`pull`, `read`, `push`…): how many, and the time spent waiting on them. */
export const SyncCallsSchema = z.object({ count: z.number(), ms: z.number() })
export const SyncReportSchema = z.object({
  versions: z.number(), held: z.number(), chunks: z.number(), bytes: z.number(), requests: z.number(), ms: z.number(),
  /** Each kind of call to the remote, with its time; with `queuedMs`, what says where an exchange's time went. */
  calls: z.record(z.string(), SyncCallsSchema).optional(),
  /** Time a pull waited for this store's turn before importing (`RecordStore.importSession`). */
  queuedMs: z.number().optional(),
})
export type SyncReport = z.infer<typeof SyncReportSchema>

/**
 * Where an exchange's time went, for a log line: "6 versions, 30316 bytes in 2225 ms: pull 2× 310 ms, read 3× 1620 ms,
 * queued 0 ms".
 */
export function describeSync(report: SyncReport): string {
  const calls = Object.entries(report.calls ?? {}).map(([kind, { count, ms }]) => `${kind} ${count}× ${Math.round(ms)} ms`)
  if (report.queuedMs !== undefined) calls.push(`queued ${Math.round(report.queuedMs)} ms`)
  return `${report.versions} versions, ${report.bytes} bytes in ${Math.round(report.ms)} ms${calls.length ? `: ${calls.join(", ")}` : ""}`
}

/** Times one call to the remote into `report.calls[kind]`, whether it answers or throws. */
async function timed<Value>(report: SyncReport, kind: string, call: () => Promise<Value>): Promise<Value> {
  const started = performance.now()
  try {
    return await call()
  } finally {
    const calls = (report.calls ??= {})
    const tally = (calls[kind] ??= { count: 0, ms: 0 })
    tally.count += 1
    tally.ms += performance.now() - started
  }
}

/** Each unit of a session by its key, at its head version: what a store holds of it (`RecordStore.holdings`). */
export const RecordHoldingsSchema = z.record(z.string(), z.number().int())

/**
 * One session sent to a remote store (`SessionCatalog.sendRecords`). `holdings`: what went, each unit at its head, for
 * whoever takes it from the remote to check it took all of it.
 */
export const SentRecordsSchema = SyncReportSchema.extend({ harness: z.string(), nativeId: z.string(), holdings: RecordHoldingsSchema })
export type SentRecords = z.infer<typeof SentRecordsSchema>

/** A session to take from a remote store (`SessionCatalog.receiveRecords`), with what its sender pushed of it when known. */
export const ReceivingSessionSchema = z.object({ harness: z.string().min(1), nativeId: z.string().min(1), holdings: RecordHoldingsSchema.optional() })
export type ReceivingSession = z.infer<typeof ReceivingSessionSchema>

/**
 * One session's records pulled from a remote store into this one ahead of time, not written into its harness's store
 * (`SessionCatalog.stageRecords`): a move's machine stages what was sent ahead, so the hand-over pulls only what's new.
 */
export const StagedRecordsSchema = SyncReportSchema.extend({ harness: z.string(), nativeId: z.string() })
export type StagedRecords = z.infer<typeof StagedRecordsSchema>

/** One session taken from a remote store and written into its harness's store here (`SessionCatalog.receiveRecords`). */
export const ReceivedRecordsSchema = z.object({ harness: z.string(), nativeId: z.string(), pulled: SyncReportSchema, restored: KeptRestoreSchema })
export type ReceivedRecords = z.infer<typeof ReceivedRecordsSchema>

/** The most versions, and chunk hashes, one push carries: a bundle well under a request's size. */
const PUSH_VERSIONS = 10_000
const PUSH_HASHES = 65_536
/** Packs going up at once. */
const UPLOADS = 4

export class RecordSync {
  readonly #store: RecordStore
  readonly #remote: RecordRemote
  readonly #turns = new Map<string, Promise<unknown>>()
  readonly #describesStore: ((harness: string, key: string) => boolean) | undefined

  /**
   * `describesStore`: whether a unit of a harness's records describes its store rather than any session (a database's
   * schema, its migration list), which a pull keeps as this store's own where another store's history of it differs.
   */
  constructor(store: RecordStore, remote: RecordRemote, options: { describesStore?: (harness: string, key: string) => boolean } = {}) {
    this.#store = store
    this.#remote = remote
    this.#describesStore = options.describesStore
  }

  /** Sends what the remote lacks of the session; one push of a session at a time, a later one waiting for the last. */
  push(harness: string, nativeId: string): Promise<SyncReport> {
    return this.#turn(`push ${harness} ${nativeId}`, () => this.#push(harness, nativeId, true))
  }

  /** Takes what the remote has of the session past the last pull. */
  pull(harness: string, nativeId: string): Promise<SyncReport> {
    return this.#turn(`pull ${harness} ${nativeId}`, () => this.#pull(harness, nativeId))
  }

  async #push(harness: string, nativeId: string, retry: boolean): Promise<SyncReport> {
    const started = performance.now()
    const report: SyncReport = { versions: 0, held: 0, chunks: 0, bytes: 0, requests: 0, ms: 0 }
    let cursor: number | undefined
    for (;;) {
      // A batch at a time, so a long session is never held whole: the remote's mirror moves with each part pushed.
      const batch: ExportPage = { limit: PUSH_VERSIONS }
      if (cursor !== undefined) batch.cursor = cursor
      const page = this.#store.exportFor(this.#remote.id, harness, nativeId, batch)
      if (!page?.bundle.units.length) break
      for (const part of splitBundle(page.bundle)) {
        const answer = await this.#pushPart(part, report)
        if (!answer.ok) {
          if (answer.conflict === "gap" && retry) {
            await this.#store.remoteHolds(this.#remote.id, harness, nativeId, { holdings: await this.#holdings(harness, nativeId, report) })
            const again = await this.#push(harness, nativeId, false)
            return sumReports(report, again, started)
          }
          throw new RecordSyncConflictError(harness, nativeId, answer.key, answer.seq, answer.message)
        }
        report.versions += answer.versions
        report.held += answer.held
        await this.#store.remoteHolds(this.#remote.id, harness, nativeId, part)
      }
      if (page.cursor === null) break
      cursor = page.cursor
    }
    return { ...report, ms: performance.now() - started }
  }

  /** One part up: with its chunks in one request when they're a turn's worth, else the chunks the remote lacks first. */
  async #pushPart(part: RecordBundle, report: SyncReport): Promise<RecordPushAnswer> {
    const hashes = recordChunks(part.units.flatMap((unit) => unit.versions))
    const small = await this.#small(hashes)
    if (small) {
      const sent = await timed(report, "push", () => this.#remote.pushWith(part, small.chunks))
      report.requests += 1
      report.chunks += small.chunks.length
      report.bytes += small.bytes
      if ("ok" in sent) return sent
      const resent = await this.#upload(sent.missing, report)
      report.chunks += resent.chunks
      report.bytes += resent.bytes
      report.requests += resent.requests
    }
    return this.#pushAsking(part, hashes, report)
  }

  /** The chunks named, read, if they come to no more than one push carries; undefined past that. */
  async #small(hashes: readonly string[]): Promise<{ chunks: PackedChunk[]; bytes: number } | undefined> {
    const chunks: PackedChunk[] = []
    let bytes = 0
    for (const hash of hashes) {
      const stored = await this.#store.readChunk(hash)
      if (!stored) throw new Error(`The chunk ${hash} this store's versions name isn't in it`)
      bytes += CHUNK_HEADER_BYTES + stored.body.length
      if (bytes > RECORD_PUSH_WITH_BYTES) return undefined
      chunks.push(packed(hash, stored))
    }
    return { chunks, bytes }
  }

  /** A push too big to carry its chunks: which the remote lacks, those in packs, then the bundle. */
  async #pushAsking(part: RecordBundle, hashes: string[], report: SyncReport): Promise<RecordPushAnswer> {
    const lacking: string[] = []
    for (let at = 0; at < hashes.length; at += RECORD_ASK_HASHES) {
      lacking.push(...(await timed(report, "missing", () => this.#remote.missing(hashes.slice(at, at + RECORD_ASK_HASHES)))))
      report.requests += 1
    }
    const sent = await this.#upload(lacking, report)
    report.chunks += sent.chunks
    report.bytes += sent.bytes
    report.requests += sent.requests + 1
    return timed(report, "push", () => this.#remote.push(part))
  }

  async #holdings(harness: string, nativeId: string, report: SyncReport): Promise<RecordHoldings> {
    const holdings: RecordHoldings = {}
    let after = ""
    for (;;) {
      const page = await timed(report, "holdings", () => this.#remote.holdings(harness, nativeId, after))
      report.requests += 1
      Object.assign(holdings, page.holdings)
      if (page.next === null) return holdings
      after = page.next
    }
  }

  /** The chunks named, read from this store and sent in packs, a few at once; the first failure stops it and is thrown. */
  async #upload(hashes: string[], report: SyncReport): Promise<{ chunks: number; bytes: number; requests: number }> {
    const sent = { chunks: 0, bytes: 0, requests: 0 }
    const flights = new Set<Promise<void>>()
    let failed: Error | undefined
    const send = (chunks: PackedChunk[]) => {
      const flight: Promise<void> = timed(report, "upload", () => this.#put(chunks)).then((error) => {
        flights.delete(flight)
        if (error) failed ??= error
        else sent.requests += 1
      })
      flights.add(flight)
    }
    let pack: PackedChunk[] = []
    let packBytes = 0
    for (const hash of hashes) {
      if (failed) break
      const stored = await this.#store.readChunk(hash)
      if (!stored) throw new Error(`The chunk ${hash} this store's versions name isn't in it`)
      const chunk = packed(hash, stored)
      if (pack.length && packBytes + CHUNK_HEADER_BYTES + chunk.body.length > RECORD_PACK_BYTES) {
        while (flights.size >= UPLOADS) await Promise.race(flights)
        send(pack)
        pack = []
        packBytes = 0
      }
      pack.push(chunk)
      packBytes += CHUNK_HEADER_BYTES + chunk.body.length
      sent.chunks += 1
      sent.bytes += chunk.body.length
    }
    if (pack.length && !failed) send(pack)
    await Promise.all(flights)
    if (failed) throw failed
    return sent
  }

  /** One pack up; what went wrong, rather than a rejection, so a pack in flight never goes unheard. */
  async #put(chunks: PackedChunk[]): Promise<Error | undefined> {
    try {
      await this.#remote.putChunks(chunks)
      return undefined
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error))
    }
  }

  async #pull(harness: string, nativeId: string): Promise<SyncReport> {
    const started = performance.now()
    const report: SyncReport = { versions: 0, held: 0, chunks: 0, bytes: 0, requests: 0, ms: 0 }
    let after = this.#store.pulledThrough(this.#remote.id, harness, nativeId)
    for (;;) {
      const pulled = await timed(report, "pull", () => this.#remote.pull(harness, nativeId, after))
      report.requests += 1
      if (!pulled) break
      if (pulled.bundle.units.length) {
        // The chunks this store lacks, read before the import takes the store's turn, so pulls of several sessions
        // overlap on the network and the store is held only to write. The import still writes each under its own
        // intent, and asks the remote for any it lacks then (a chunk a repack dropped meanwhile).
        const ahead = new Map<string, StoredChunk>()
        for await (const { hash, chunk } of this.#fetch(this.#store.missingChunks(recordChunks(pulled.bundle.units.flatMap((unit) => unit.versions))), report)) ahead.set(hash, chunk)
        const fetch = (hashes: string[]) => this.#fetchAhead(ahead, hashes, report)
        try {
          const describes = this.#describesStore
          const taken = await this.#store.importSession(pulled.bundle, fetch, { remote: this.#remote.id, through: pulled.through }, describes && ((unit) => describes(harness, unit.key)))
          report.versions += taken.versions
          report.held += taken.held
          report.queuedMs = (report.queuedMs ?? 0) + (taken.queuedMs ?? 0)
        } catch (error) {
          if (error instanceof RecordConflictError) throw new RecordSyncConflictError(harness, nativeId, error.key, error.seq, error.message)
          throw error
        }
      }
      after = pulled.through
      if (!pulled.more) break
    }
    return { ...report, ms: performance.now() - started }
  }

  /** The chunks an import asks for: those read ahead, then the rest from the remote. */
  async *#fetchAhead(ahead: ReadonlyMap<string, StoredChunk>, hashes: string[], report: SyncReport): AsyncGenerator<{ hash: string; chunk: StoredChunk }> {
    const rest: string[] = []
    for (const hash of hashes) {
      const chunk = ahead.get(hash)
      if (chunk) yield { hash, chunk }
      else rest.push(hash)
    }
    if (rest.length) yield* this.#fetch(rest, report)
  }

  /** The chunks a pull needs, asked for in packs until each came; one the remote never sends ends the import short. */
  async *#fetch(hashes: string[], report: SyncReport): AsyncGenerator<{ hash: string; chunk: StoredChunk }> {
    for (let at = 0; at < hashes.length; at += RECORD_ASK_HASHES) {
      let asking = hashes.slice(at, at + RECORD_ASK_HASHES)
      while (asking.length) {
        const came = await timed(report, "read", () => this.#remote.readChunks(asking))
        report.requests += 1
        if (!came.length) return
        const got = new Set<string>()
        for (const chunk of came) {
          got.add(chunk.hash)
          report.chunks += 1
          report.bytes += chunk.body.length
          yield { hash: chunk.hash, chunk: { codec: chunk.codec, size: chunk.size, body: Buffer.from(chunk.body.buffer, chunk.body.byteOffset, chunk.body.byteLength) } }
        }
        asking = asking.filter((hash) => !got.has(hash))
      }
    }
  }

  #turn<T>(key: string, work: () => Promise<T>): Promise<T> {
    const before = this.#turns.get(key)
    const run = (before ? before.catch(() => undefined) : Promise.resolve()).then(work)
    this.#turns.set(key, run)
    const settled = () => {
      if (this.#turns.get(key) === run) this.#turns.delete(key)
    }
    run.then(settled, settled)
    return run
  }
}

function packed(hash: string, stored: StoredChunk): PackedChunk {
  return { hash, codec: stored.codec, size: stored.size, body: new Uint8Array(stored.body.buffer, stored.body.byteOffset, stored.body.byteLength) }
}

/** A bundle in parts no larger than one push: whole units where they fit, a long unit's versions split in order. */
export function splitBundle(bundle: RecordBundle): RecordBundle[] {
  const parts: RecordBundle[] = []
  let units: RecordUnit[] = []
  let versions = 0
  let hashes = 0
  const flush = () => {
    if (units.length) parts.push({ ...bundle, units })
    units = []
    versions = 0
    hashes = 0
  }
  for (const unit of bundle.units) {
    let current: RecordUnit | undefined
    for (const version of unit.versions) {
      const named = version.chunks.length / 64
      if (versions && (versions + 1 > PUSH_VERSIONS || hashes + named > PUSH_HASHES)) {
        flush()
        current = undefined
      }
      if (!current) units.push((current = { ...unit, versions: [] }))
      current.versions.push(version)
      versions += 1
      hashes += named
    }
  }
  flush()
  return parts
}

function sumReports(first: SyncReport, second: SyncReport, started: number): SyncReport {
  return {
    versions: first.versions + second.versions,
    held: first.held + second.held,
    chunks: first.chunks + second.chunks,
    bytes: first.bytes + second.bytes,
    requests: first.requests + second.requests,
    ms: performance.now() - started,
    ...(first.calls || second.calls) && { calls: sumCalls(first.calls ?? {}, second.calls ?? {}) },
  }
}

function sumCalls(first: NonNullable<SyncReport["calls"]>, second: NonNullable<SyncReport["calls"]>): NonNullable<SyncReport["calls"]> {
  const sum = structuredClone(first)
  for (const [kind, { count, ms }] of Object.entries(second)) {
    const tally = (sum[kind] ??= { count: 0, ms: 0 })
    tally.count += count
    tally.ms += ms
  }
  return sum
}

/** Where a store's records go: a remote's routes and the header its calls carry. */
export const RecordsLinkSchema = z.object({ id: z.string().min(1).max(2_048), base: z.url(), authorization: z.string().min(1).max(4_096) })
export type RecordsLink = z.infer<typeof RecordsLinkSchema>

/**
 * How a send or receive over a link says the remote refused its credential, which lapses: a link carries a
 * short-lived token, and records can take longer to go than it lives. Only the message crosses a catalog's process,
 * so it's what callers read (`linkRefused`).
 */
export const RECORDS_LINK_REFUSED = "The cloud refused the records link's credential"

export class RecordsLinkRefusedError extends Error {
  constructor(detail: string) {
    super(`${RECORDS_LINK_REFUSED}: ${detail}`)
    this.name = "RecordsLinkRefusedError"
  }
}

export function linkRefused(error: Error): boolean {
  return error.message.startsWith(RECORDS_LINK_REFUSED)
}

/** Sends or receives under a fresh link each time the last one's credential lapsed: records go on from where they stopped. */
export async function withFreshLink<Value>(link: () => Promise<RecordsLink> | RecordsLink, work: (link: RecordsLink) => Promise<Value>, attempts = 4): Promise<Value> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work(await link())
    } catch (error) {
      if (!(error instanceof Error) || !linkRefused(error) || attempt >= attempts) throw error
    }
  }
}

/**
 * Which of the store's sessions go to a remote, most wanted first, and whether catching up on the rest waits: a device
 * keeps the sessions its account lists in step (the ones at work first, then the newest), and waits while it runs on a
 * low battery. A session in scope is pushed as each capture lands, waiting or not; one out of scope isn't pushed. No
 * scope (a cloud machine's): every session the store holds, in the store's order.
 */
export const RecordScopeSchema = z.object({
  sessions: z.array(z.object({ harness: z.string().min(1), nativeId: z.string().min(1) })).max(10_000),
  paused: z.boolean(),
})
export type RecordScope = z.infer<typeof RecordScopeSchema>

/** How pushing has gone: for the machine's state and its log. */
export type PushStatus = {
  link: string | null
  pushes: number
  versions: number
  bytes: number
  failures: number
  /** Sessions waiting for a push, or with one in flight. */
  waiting: number
  /** In scope and not yet caught up on this link, and whether catching up waits. */
  behind?: number
  paused?: boolean
  last?: { harness: string; nativeId: string; at: number; ms: number; versions: number; error?: string }
}

type PushEntry = { harness: string; nativeId: string; again: boolean; failures: number; flight?: Promise<void>; timer?: ReturnType<typeof setTimeout>; queued?: true }

/**
 * Pushes in flight at once on a link with a scope (a device's): the rest wait, and the most wanted of them goes next, so
 * a Session at work isn't left sharing a slow connection with everything a first catch-up has.
 */
const SCOPED_FLIGHTS = 2

/** The first wait after a failed push, doubling to the most. */
const RETRY_MS = 2_000
const RETRY_MOST_MS = 60_000

/**
 * Every capture pushed as it lands: a session whose capture finishes is pushed, one push of it at a time, and one
 * captured again meanwhile is pushed once more after. A push that fails is tried again later, waiting longer each
 * time, and at once on the next capture; records that went on in two places aren't tried again until something new
 * is captured. Sessions captured before there was a remote are pushed when one is given (`catchUp`).
 */
export class RecordPushes {
  readonly #sync: RecordSync
  readonly #link: string
  readonly #state = new Map<string, PushEntry>()
  readonly #status: PushStatus
  #stopped = false
  /** Each session in scope by its rank, the most wanted first; null, every session. */
  #scope: Map<string, number> | null = null
  #paused = false
  /** In scope and not yet caught up on this link, by key. */
  readonly #behind = new Map<string, { harness: string; nativeId: string }>()
  #draining: Promise<void> | undefined

  constructor(store: RecordStore, remote: RecordRemote, private readonly log: (level: "info" | "warn", message: string, fields: Record<string, string | number>) => void) {
    this.#sync = new RecordSync(store, remote)
    this.#link = remote.id
    this.#status = { link: remote.id, pushes: 0, versions: 0, bytes: 0, failures: 0, waiting: 0 }
  }

  /**
   * Keeps only the sessions `scope` names in step, catching up on the ones this link hasn't caught up on yet, the most
   * wanted first, one at a time, unless it waits. Said again as the list changes: a session new to it is caught up in
   * its place, one gone from it is pushed no more.
   */
  scoped(scope: RecordScope): void {
    if (this.#stopped) return
    const before = this.#scope
    this.#scope = new Map(scope.sessions.map((session, rank) => [`${session.harness}\n${session.nativeId}`, rank]))
    this.#paused = scope.paused
    for (const key of this.#behind.keys()) if (!this.#scope.has(key)) this.#behind.delete(key)
    for (const session of scope.sessions) {
      const key = `${session.harness}\n${session.nativeId}`
      if (!before?.has(key)) this.#behind.set(key, session)
    }
    this.#drain()
  }

  /** A capture of the session finished. */
  captured(harness: string, nativeId: string): void {
    if (this.#stopped) return
    const key = `${harness}\n${nativeId}`
    if (this.#scope && !this.#scope.has(key)) return
    let entry = this.#state.get(key)
    if (!entry) this.#state.set(key, (entry = { harness, nativeId, again: false, failures: 0 }))
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined
    if (entry.flight) {
      entry.again = true
      return
    }
    if (this.#scope && [...this.#state.values()].filter((other) => other.flight).length >= SCOPED_FLIGHTS) {
      entry.queued = true
      return
    }
    delete entry.queued
    entry.flight = this.#run(entry)
  }

  /** The most wanted push waiting for a flight, started. */
  #next(): void {
    let next: PushEntry | undefined
    const rank = (entry: PushEntry) => this.#scope?.get(`${entry.harness}\n${entry.nativeId}`) ?? Number.MAX_SAFE_INTEGER
    for (const entry of this.#state.values()) if (entry.queued && (!next || rank(entry) < rank(next))) next = entry
    if (!next || this.#stopped) return
    delete next.queued
    next.flight = this.#run(next)
  }

  /** Every session the store holds, pushed in turn: what was captured before this remote was given. */
  async catchUp(sessions: ReadonlyArray<{ harness: string; nativeId: string }>): Promise<void> {
    for (const session of sessions) {
      if (this.#stopped) return
      this.captured(session.harness, session.nativeId)
      // One at a time, so a machine's first link doesn't send every session at once.
      await this.#state.get(`${session.harness}\n${session.nativeId}`)?.flight
    }
  }

  status(): PushStatus {
    const status: PushStatus = { ...this.#status, waiting: [...this.#state.values()].filter((entry) => entry.flight || entry.timer || entry.queued).length }
    if (this.#scope) {
      status.behind = this.#behind.size
      status.paused = this.#paused
    }
    return status
  }

  /** Once every push in flight has settled, and catching up has gone as far as it goes now. */
  async settled(): Promise<void> {
    for (;;) {
      const flights = [...this.#state.values()].flatMap((entry) => entry.flight ?? [])
      if (this.#draining) flights.push(this.#draining)
      if (!flights.length) return
      await Promise.all(flights)
    }
  }

  /** Catches up on the sessions in scope this link is behind on, the most wanted first, one at a time, until it waits. */
  #drain(): void {
    if (this.#draining || this.#paused || this.#stopped || !this.#behind.size) return
    this.#draining = (async () => {
      while (!this.#paused && !this.#stopped && this.#behind.size) {
        let next: [string, { harness: string; nativeId: string }] | undefined
        for (const entry of this.#behind) if (!next || (this.#scope?.get(entry[0]) ?? 0) < (this.#scope?.get(next[0]) ?? 0)) next = entry
        if (!next) break
        const [key, session] = next
        this.#behind.delete(key)
        this.captured(session.harness, session.nativeId)
        await this.#state.get(key)?.flight
      }
    })().finally(() => {
      this.#draining = undefined
      // A list said again while the last session went may have more for it.
      if (!this.#paused && !this.#stopped && this.#behind.size) this.#drain()
    })
  }

  stop(): void {
    this.#stopped = true
    for (const entry of this.#state.values()) if (entry.timer) clearTimeout(entry.timer)
  }

  /** Pushes the session, and again while captures came meanwhile; settles once it's caught up or failed. */
  async #run(entry: PushEntry): Promise<void> {
    do {
      entry.again = false
      await this.#once(entry)
    } while (entry.again && !this.#stopped)
    entry.flight = undefined
    this.#next()
  }

  async #once(entry: PushEntry): Promise<void> {
    const started = Date.now()
    try {
      const report = await this.#sync.push(entry.harness, entry.nativeId)
      entry.failures = 0
      if (report.versions || report.chunks) {
        this.#status.pushes += 1
        this.#status.versions += report.versions
        this.#status.bytes += report.bytes
        this.#status.last = { harness: entry.harness, nativeId: entry.nativeId, at: started, ms: Math.round(report.ms), versions: report.versions }
        if (report.ms >= 1_000) this.log("info", "records pushed slowly", { link: this.#link, harness: entry.harness, nativeId: entry.nativeId, versions: report.versions, bytes: report.bytes, requests: report.requests, ms: Math.round(report.ms) })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      entry.failures += 1
      this.#status.failures += 1
      this.#status.last = { harness: entry.harness, nativeId: entry.nativeId, at: started, ms: Date.now() - started, versions: 0, error: message }
      const conflict = error instanceof RecordSyncConflictError
      this.log("warn", conflict ? "records went on in two places; the remote's stand" : "records push failed", { link: this.#link, harness: entry.harness, nativeId: entry.nativeId, failures: entry.failures, error: message })
      // Two lines of one session wait for something new; anything else is tried again, later each time.
      if (!conflict && !this.#stopped && !entry.again) {
        const wait = Math.min(RETRY_MOST_MS, RETRY_MS * 2 ** (entry.failures - 1))
        entry.timer = setTimeout(() => {
          entry.timer = undefined
          this.captured(entry.harness, entry.nativeId)
        }, wait)
        entry.timer.unref?.()
      }
    }
  }
}

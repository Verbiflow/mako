import { GatewayHttpError, type GatewayCallTrace } from "@mako/protocol/gateway-http"
import { CHUNK_HEADER_BYTES, RECORD_ASK_HASHES, RECORD_PACK_BYTES, RECORD_PUSH_WITH_BYTES, RecordConflictError, recordChunks, type PackedChunk, type RecordBundle, type RecordHoldings, type RecordPushAnswer, type RecordRemote, type RecordUnit } from "@mako/protocol/records"
import { z } from "zod"
import { KeptRestoreSchema } from "./kept-restore.js"
import type { StoredChunk } from "./record-chunks.js"
import type { ExportPage, RecordStore } from "./record-store.js"
import { UploadBudget, type UploadReservation } from "./upload-budget.js"

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

/**
 * Chunks the remote refused one by one, though it took every other chunk of the push: what their versions name, and
 * all of their units after them, wait; everything else went. A refusal, as its first pack's was, so it's tried again
 * by a refusal's pace, and it names the chunks, so whoever reads it knows which.
 */
export class RecordChunksRefusedError extends GatewayHttpError {
  constructor(
    readonly harness: string,
    readonly nativeId: string,
    readonly chunks: ReadonlyArray<{ hash: string; size: number }>,
    refusal: GatewayHttpError
  ) {
    const [first] = chunks
    const named = first ? `${first.hash.slice(0, 12)}, ${first.size.toLocaleString("en-US")} bytes${chunks.length > 1 ? `, and ${chunks.length - 1} more` : ""}` : ""
    super(refusal.status, `The account refused ${chunks.length === 1 ? "one chunk" : `${chunks.length} chunks`} of this Session (${named}) and took the rest: ${refusal.message}`, refusal.call, refusal.detail)
  }
}

/** Whether the remote heard a call and refused what it carried: sent again unchanged, it gets the same answer. */
export function refusedBy(error: Error): error is GatewayHttpError {
  return error instanceof GatewayHttpError && (error.status === 400 || error.status === 413 || error.status === 422)
}

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

/**
 * The calls of one kind an exchange made (`pull`, `read`, `push`…): how many, and the time spent waiting on them. A
 * call sent more than once counts once, its tries in `tries` and what ended each in `failures`; the slowest names its
 * correlation ID, under which the gateway logged each of its tries.
 */
export const SyncCallsSchema = z.object({
  count: z.number(), ms: z.number(),
  tries: z.number().optional(),
  failures: z.array(z.string()).optional(),
  slowest: z.object({ ms: z.number(), correlationId: z.string() }).optional(),
})
/** A call this slow names its correlation ID where the exchange is described. */
export const SLOW_CALL_MS = 2_000
/** The most failed tries an exchange's report keeps of one kind of call. */
const FAILURES_KEPT = 4
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
 * queued 0 ms". A call sent again says so, and a slow one says where the gateway logged it: "push 1× 60283 ms (2 tries:
 * 503 after 60011 ms; slowest 60283 ms, correlation 5f0c…)".
 */
export function describeSync(report: SyncReport): string {
  const calls = Object.entries(report.calls ?? {}).map(([kind, tally]) => `${kind} ${tally.count}× ${Math.round(tally.ms)} ms${callNotes(tally)}`)
  if (report.queuedMs !== undefined) calls.push(`queued ${Math.round(report.queuedMs)} ms`)
  return `${report.versions} versions, ${report.bytes} bytes in ${Math.round(report.ms)} ms${calls.length ? `: ${calls.join(", ")}` : ""}`
}

function callNotes({ count, tries, failures, slowest }: SyncCalls): string {
  const notes: string[] = []
  if (tries !== undefined && tries > count) notes.push(`${tries} tries${failures?.length ? `: ${failures.join(", ")}` : ""}`)
  if (slowest && slowest.ms >= SLOW_CALL_MS) notes.push(`slowest ${Math.round(slowest.ms)} ms, correlation ${slowest.correlationId}`)
  return notes.length ? ` (${notes.join("; ")})` : ""
}

/**
 * Times one call to the remote into `report.calls[kind]`, whether it answers or throws, with the tries the remote says
 * it took (`GatewayCallTrace`).
 */
async function timed<Value>(report: SyncReport, kind: string, call: (trace: GatewayCallTrace) => Promise<Value>): Promise<Value> {
  const started = performance.now()
  const trace: GatewayCallTrace = { tries: 0, failures: [] }
  try {
    return await call(trace)
  } finally {
    const ms = performance.now() - started
    const calls = (report.calls ??= {})
    const tally = (calls[kind] ??= { count: 0, ms: 0 })
    tally.count += 1
    tally.ms += ms
    tallyTries(tally, 1, Math.max(1, trace.tries), trace.failures)
    if (trace.correlationId && ms > (tally.slowest?.ms ?? -1)) tally.slowest = { ms, correlationId: trace.correlationId }
  }
}

type SyncCalls = z.infer<typeof SyncCallsSchema>

/** Adds the tries of `calls` calls, already counted in `tally.count`; `tries` is kept only once a call took more than one. */
function tallyTries(tally: SyncCalls, calls: number, tries: number, failures: readonly string[]): void {
  const before = tally.tries ?? tally.count - calls
  if (tries > calls || tally.tries !== undefined) tally.tries = before + tries
  if (failures.length) tally.failures = [...(tally.failures ?? []), ...failures].slice(0, FAILURES_KEPT)
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
/** Packs going up at once, within the budget's bytes. */
const UPLOADS = 4
/**
 * A pack the remote refuses is sent again as this many smaller ones, and each of those it refuses the same way, down
 * to the chunks it refuses alone: about three rounds for a pack of 4,000 chunks. One refused chunk once kept a
 * Session's 202,198 others from the account for a day and a half.
 */
const REFUSED_SPLIT = 16

export class RecordSync {
  readonly #store: RecordStore
  readonly #remote: RecordRemote
  readonly #turns = new Map<string, Promise<unknown>>()
  readonly #describesStore: ((harness: string, key: string) => boolean) | undefined
  readonly #uploads: number
  /** Chunks the remote refused alone, by hash: tried alone first at each push, in case it takes them now. */
  readonly #refused = new Map<string, { size: number; refusal: GatewayHttpError }>()
  readonly #budget: UploadBudget

  /**
   * `describesStore`: whether a unit of a harness's records describes its store rather than any session (a database's
   * schema, its migration list), which a pull keeps as this store's own where another store's history of it differs.
   * `uploads`: packs in flight at once (four by default); a paced remote needs one, as more would only be held waiting.
   * `budget`: the bytes the process's uploads hold at once, shared with its other syncs (`UploadBudget`); one of its
   * own by default.
   */
  constructor(store: RecordStore, remote: RecordRemote, options: { describesStore?: (harness: string, key: string) => boolean; uploads?: number; budget?: UploadBudget } = {}) {
    this.#store = store
    this.#remote = remote
    this.#describesStore = options.describesStore
    this.#uploads = options.uploads ?? UPLOADS
    this.#budget = options.budget ?? new UploadBudget()
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
    // Units held back by a chunk the remote refused: their versions from that chunk's on wait, the rest go.
    const heldBack = new Set<string>()
    let cursor: number | undefined
    for (;;) {
      // A batch at a time, so a long session is never held whole: the remote's mirror moves with each part pushed.
      const batch: ExportPage = { limit: PUSH_VERSIONS }
      if (cursor !== undefined) batch.cursor = cursor
      const page = this.#store.exportFor(this.#remote.id, harness, nativeId, batch)
      if (!page?.bundle.units.length) break
      let moved = false
      for (const whole of splitBundle(page.bundle)) {
        const part = withoutUnits(whole, heldBack)
        if (!part) continue
        const { answer, sent } = await this.#pushPart(part, report, heldBack)
        if (!answer || !sent) continue
        if (!answer.ok) {
          if (answer.conflict === "gap" && retry) {
            await this.#store.remoteHolds(this.#remote.id, harness, nativeId, { holdings: await this.#holdings(harness, nativeId, report) })
            const again = await this.#push(harness, nativeId, false)
            return sumReports(report, again, started)
          }
          throw new RecordSyncConflictError(harness, nativeId, answer.key, answer.seq, answer.message)
        }
        moved = true
        report.versions += answer.versions
        report.held += answer.held
        await this.#store.remoteHolds(this.#remote.id, harness, nativeId, sent)
      }
      // A batch whose every version waits on a refused chunk, and whose cursor stands, would come back the same.
      if (page.cursor === null || (!moved && page.cursor === (cursor ?? 0))) break
      cursor = page.cursor
    }
    if (heldBack.size) {
      const refused = [...this.#refused].map(([hash, { size, refusal }]) => ({ hash, size, refusal }))
      const [first] = refused
      if (first) throw new RecordChunksRefusedError(harness, nativeId, refused.map(({ hash, size }) => ({ hash, size })), first.refusal)
    }
    return { ...report, ms: performance.now() - started }
  }

  /**
   * One part up: with its chunks in one request when they're a turn's worth, else the chunks the remote lacks first.
   * What went (`sent`) is the part but for the versions that name a chunk the remote refused, and their units' after
   * them, whose keys join `heldBack`; nothing went when every version waits.
   */
  async #pushPart(part: RecordBundle, report: SyncReport, heldBack: Set<string>): Promise<{ answer?: RecordPushAnswer; sent?: RecordBundle }> {
    const hashes = recordChunks(part.units.flatMap((unit) => unit.versions))
    let small: { chunks: PackedChunk[]; bytes: number } | undefined
    let sent: RecordPushAnswer | { missing: string[] } | undefined
    if (!hashes.some((hash) => this.#refused.has(hash))) {
      // A turn's worth, reserved as one: it never waits behind packs for room (`UploadBudget.take`).
      const reservation = await this.#budget.take(RECORD_PUSH_WITH_BYTES, { turn: true })
      try {
        small = await this.#small(hashes)
        reservation.trim(small?.bytes ?? 0)
        const carried = small
        if (carried)
          sent = await timed(report, "push", (trace) => this.#remote.pushWith(part, carried.chunks, trace)).catch((error: Error) => {
            // A chunk it refuses, carried with the bundle: found below, a pack at a time.
            if (refusedBy(error)) return undefined
            throw error
          })
      } finally {
        reservation.release()
      }
    }
    if (small) {
      if (sent) {
        report.requests += 1
        report.chunks += small.chunks.length
        report.bytes += small.bytes
        if ("ok" in sent) return { answer: sent, sent: part }
        const resent = await this.#upload(sent.missing, report)
        report.chunks += resent.chunks
        report.bytes += resent.bytes
        report.requests += resent.requests
      }
    }
    return this.#pushAsking(part, hashes, report, heldBack)
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

  /**
   * A push too big to carry its chunks: which the remote lacks, those in packs, then the bundle, but for the versions
   * that wait on a chunk it refused.
   */
  async #pushAsking(part: RecordBundle, hashes: string[], report: SyncReport, heldBack: Set<string>): Promise<{ answer?: RecordPushAnswer; sent?: RecordBundle }> {
    const lacking: string[] = []
    for (let at = 0; at < hashes.length; at += RECORD_ASK_HASHES) {
      lacking.push(...(await timed(report, "missing", (trace) => this.#remote.missing(hashes.slice(at, at + RECORD_ASK_HASHES), trace))))
      report.requests += 1
    }
    const sent = await this.#upload(lacking, report)
    report.chunks += sent.chunks
    report.bytes += sent.bytes
    report.requests += sent.requests
    const refused = new Set(lacking.filter((hash) => this.#refused.has(hash)))
    const going = refused.size ? holdingBack(part, refused, heldBack) : part
    if (!going) return {}
    report.requests += 1
    return { answer: await timed(report, "push", (trace) => this.#remote.push(going, trace)), sent: going }
  }

  async #holdings(harness: string, nativeId: string, report: SyncReport): Promise<RecordHoldings> {
    const holdings: RecordHoldings = {}
    let after = ""
    for (;;) {
      const page = await timed(report, "holdings", (trace) => this.#remote.holdings(harness, nativeId, after, trace))
      report.requests += 1
      Object.assign(holdings, page.holdings)
      if (page.next === null) return holdings
      after = page.next
    }
  }

  /**
   * The chunks named, read from this store and sent in packs, a few at once, each pack's bytes reserved of the budget
   * before its chunks are read and given back once its request ends; the first failure stops it and is thrown.
   * A pack the remote refuses is sent again in smaller ones until what it refuses is single chunks, which wait
   * (`#refused`) while every other chunk goes. One it refused before goes alone first, in case it takes it now.
   */
  async #upload(hashes: string[], report: SyncReport): Promise<{ chunks: number; bytes: number; requests: number }> {
    const sent = { chunks: 0, bytes: 0, requests: 0 }
    for (const hash of hashes) {
      const before = this.#refused.get(hash)
      if (!before) continue
      const stored = await this.#store.readChunk(hash)
      if (!stored) throw new Error(`The chunk ${hash} this store's versions name isn't in it`)
      const error = await timed(report, "upload", (trace) => this.#put([packed(hash, stored)], trace))
      if (error && !refusedBy(error)) throw error
      if (error) this.#refused.set(hash, { size: before.size, refusal: error })
      else {
        this.#refused.delete(hash)
        sent.chunks += 1
        sent.bytes += stored.body.length
        sent.requests += 1
      }
    }
    const flights = new Set<Promise<void>>()
    let failed: Error | undefined
    // Each pack's bytes held of the budget until its request, and any split of it the remote refused, has ended.
    const send = (chunks: PackedChunk[], reservation: UploadReservation) => {
      const flight: Promise<void> = timed(report, "upload", (trace) => this.#put(chunks, trace))
        .then((error) => (error && refusedBy(error) ? this.#isolate(chunks, report) : error))
        .then((error) => {
          reservation.release()
          flights.delete(flight)
          if (error) failed ??= error
          else sent.requests += 1
        })
      flights.add(flight)
    }
    const packLimit = Math.min(RECORD_PACK_BYTES, this.#budget.packBytes)
    // A chunk read that didn't fit the pack before it: the next pack's first.
    let carried: PackedChunk | undefined
    let at = 0
    while ((carried || at < hashes.length) && !failed) {
      while (flights.size >= this.#uploads) await Promise.race(flights)
      if (failed) break
      // Reserved before the chunks are read, so what a pack holds is in the budget from its first chunk.
      const reservation = await this.#budget.take(packLimit)
      const pack: PackedChunk[] = []
      let packBytes = 0
      try {
        for (;;) {
          let chunk = carried
          carried = undefined
          if (!chunk) {
            const hash = hashes[at]
            if (hash === undefined) break
            at += 1
            if (this.#refused.has(hash)) continue
            const stored = await this.#store.readChunk(hash)
            if (!stored) throw new Error(`The chunk ${hash} this store's versions name isn't in it`)
            chunk = packed(hash, stored)
          }
          const bytes = CHUNK_HEADER_BYTES + chunk.body.length
          if (pack.length && packBytes + bytes > packLimit) {
            carried = chunk
            break
          }
          pack.push(chunk)
          packBytes += bytes
          sent.chunks += 1
          sent.bytes += chunk.body.length
        }
      } catch (error) {
        reservation.release()
        await Promise.all(flights)
        throw error
      }
      reservation.trim(packBytes)
      if (pack.length) send(pack, reservation)
      else reservation.release()
    }
    await Promise.all(flights)
    if (failed) throw failed
    return sent
  }

  /**
   * The chunks of a pack the remote refused, sent again in `REFUSED_SPLIT` smaller packs, and each of those it refuses
   * likewise, down to the chunks it refuses alone, which are kept in `#refused`. What went wrong otherwise, or nothing.
   */
  async #isolate(chunks: PackedChunk[], report: SyncReport): Promise<Error | undefined> {
    const size = Math.max(1, Math.ceil(chunks.length / REFUSED_SPLIT))
    for (let at = 0; at < chunks.length; at += size) {
      const group = chunks.slice(at, at + size)
      const error = await timed(report, "upload", (trace) => this.#put(group, trace))
      if (!error) continue
      if (!refusedBy(error)) return error
      const [only] = group
      if (group.length === 1 && only) this.#refused.set(only.hash, { size: only.size, refusal: error })
      else {
        const deeper = await this.#isolate(group, report)
        if (deeper) return deeper
      }
    }
    return undefined
  }

  /** One pack up; what went wrong, rather than a rejection, so a pack in flight never goes unheard. */
  async #put(chunks: PackedChunk[], trace: GatewayCallTrace): Promise<Error | undefined> {
    try {
      await this.#remote.putChunks(chunks, trace)
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
      const pulled = await timed(report, "pull", (trace) => this.#remote.pull(harness, nativeId, after, trace))
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
        const came = await timed(report, "read", (trace) => this.#remote.readChunks(asking, trace))
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

/** The bundle without the units named, or undefined when none is left. */
function withoutUnits(bundle: RecordBundle, held: ReadonlySet<string>): RecordBundle | undefined {
  if (!held.size) return bundle
  const units = bundle.units.filter((unit) => !held.has(unit.key))
  return units.length ? { ...bundle, units } : undefined
}

/**
 * The bundle up to each unit's first version naming a `refused` chunk: a unit's versions go in order, so none after
 * that one can go either, and the unit joins `heldBack` for the rest of the push. Undefined when nothing is left.
 */
function holdingBack(bundle: RecordBundle, refused: ReadonlySet<string>, heldBack: Set<string>): RecordBundle | undefined {
  const units: RecordUnit[] = []
  for (const unit of bundle.units) {
    const waits = unit.versions.findIndex((version) => recordChunks([version]).some((hash) => refused.has(hash)))
    if (waits < 0) {
      units.push(unit)
      continue
    }
    heldBack.add(unit.key)
    if (waits > 0) units.push({ ...unit, versions: unit.versions.slice(0, waits) })
  }
  return units.length ? { ...bundle, units } : undefined
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
  for (const [kind, added] of Object.entries(second)) {
    const tally = (sum[kind] ??= { count: 0, ms: 0 })
    tally.count += added.count
    tally.ms += added.ms
    tallyTries(tally, added.count, added.tries ?? added.count, added.failures ?? [])
    if (added.slowest && added.slowest.ms > (tally.slowest?.ms ?? -1)) tally.slowest = added.slowest
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

/** How pushing has gone: for the machine's state and its log. */
export type PushStatus = {
  link: string | null
  pushes: number
  versions: number
  bytes: number
  failures: number
  /** Sessions waiting for a push, or with one in flight. */
  waiting: number
  last?: { harness: string; nativeId: string; at: number; ms: number; versions: number; error?: string }
}

type PushEntry = { harness: string; nativeId: string; again: boolean; failures: number; flight?: Promise<void>; timer?: ReturnType<typeof setTimeout> }

/** The first wait after a failed push, doubling to the most. */
const RETRY_MS = 2_000
const RETRY_MOST_MS = 60_000

/**
 * Every capture pushed as it lands: a session whose capture finishes is pushed, one push of it at a time, and one
 * captured again meanwhile is pushed once more after. A push that fails is tried again later, waiting longer each
 * time, and at once on the next capture; records that went on in two places aren't tried again until something new
 * is captured. Sessions captured before there was a remote are pushed when one is given (`catchUp`). Every session
 * the store holds goes, in the store's order: a cloud machine's. A device keeps a scope of its sessions in step, the
 * most wanted first, with `ScopedUploads`.
 */
export class RecordPushes {
  readonly #sync: RecordSync
  readonly #link: string
  readonly #state = new Map<string, PushEntry>()
  readonly #status: PushStatus
  #stopped = false

  constructor(store: RecordStore, remote: RecordRemote, private readonly log: (level: "info" | "warn", message: string, fields: Record<string, string | number>) => void) {
    this.#sync = new RecordSync(store, remote)
    this.#link = remote.id
    this.#status = { link: remote.id, pushes: 0, versions: 0, bytes: 0, failures: 0, waiting: 0 }
  }

  /** A capture of the session finished. */
  captured(harness: string, nativeId: string): void {
    if (this.#stopped) return
    const key = `${harness}\n${nativeId}`
    let entry = this.#state.get(key)
    if (!entry) this.#state.set(key, (entry = { harness, nativeId, again: false, failures: 0 }))
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined
    if (entry.flight) {
      entry.again = true
      return
    }
    entry.flight = this.#run(entry)
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
    return { ...this.#status, waiting: [...this.#state.values()].filter((entry) => entry.flight || entry.timer).length }
  }

  /** Once every push in flight has settled. */
  async settled(): Promise<void> {
    for (;;) {
      const flights = [...this.#state.values()].flatMap((entry) => entry.flight ?? [])
      if (!flights.length) return
      await Promise.all(flights)
    }
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
        if (report.ms >= 1_000) this.log("info", "records pushed slowly", { link: this.#link, harness: entry.harness, nativeId: entry.nativeId, versions: report.versions, bytes: report.bytes, requests: report.requests, ms: Math.round(report.ms), calls: describeSync(report) })
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

import { GatewayHttpError, describeGatewayFailure } from "@mako/protocol/gateway-http"
import { CHUNK_HEADER_BYTES, type PackedChunk, type RecordRemote } from "@mako/protocol/records"
import { z } from "zod"
import type { RecordStore } from "./record-store.js"
import { RecordSync, RecordSyncConflictError, describeSync } from "./record-sync.js"

/**
 * How recently a Session's Thread was worked in, which sets when its turn comes: `now` while it works or waits, then
 * the last day, the last week, and the rest of the sync window. The device's host decides it (`syncTier`); here it
 * only orders and counts.
 */
export const SyncTierSchema = z.enum(["now", "day", "week", "month"])
export type SyncTier = z.infer<typeof SyncTierSchema>
export const SYNC_TIERS = SyncTierSchema.options

/**
 * The Sessions a device keeps in the account, the most wanted first, each by its native session, where the catalog
 * reads it, and its tier; and whether catching up waits (a low battery, Low Power Mode). One scope for both forms a
 * Session goes up in: its reading copy and its records.
 */
export const SyncScopeSchema = z.object({
  sessions: z.array(z.object({ harness: z.string().min(1), nativeId: z.string().min(1), path: z.string().min(1), thread: z.string().min(1), busy: z.boolean(), tier: SyncTierSchema })).max(10_000),
  /** Catching up waits: only Sessions at work go meanwhile. */
  paused: z.boolean(),
})
export type SyncScope = z.infer<typeof SyncScopeSchema>

/** A push that failed, said as the person and an operator need it: the gateway's words and its correlation ID. */
export const SyncFailureSchema = z.object({
  at: z.number(),
  harness: z.string(),
  nativeId: z.string(),
  message: z.string(),
  correlationId: z.string().optional(),
  /** The account refused it as records that went on in two places: tried again only once something new is captured. */
  conflict: z.boolean().optional(),
})
export type SyncFailure = z.infer<typeof SyncFailureSchema>

/** How one store's uploads go: what's in flight, what went, and what failed and wasn't pushed since. */
export const UploadsStatusSchema = z.object({
  /** In flight now. */
  sending: z.array(z.object({ harness: z.string(), nativeId: z.string() })),
  paused: z.boolean(),
  /** Since this process started: whole pushes, the bytes they sent, and failed tries. */
  pushes: z.number().int().nonnegative(),
  bytes: z.number().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** The last push that ended with the account holding the session whole, ever (`RecordStore.pushed`). */
  lastSuccessAt: z.number().optional(),
  /** The newest failures, newest first, and only those not since pushed. */
  failures: z.array(SyncFailureSchema),
})
export type UploadsStatus = z.infer<typeof UploadsStatusSchema>

/**
 * Of the Sessions in one tier, and their Threads: how many; how many the account can show (`readable`: its copy there
 * and current); how many it holds whole (`whole`: its records there through their last capture, which the backfill
 * must have taken first: `held`); and how many it has both of (`inCloud`). A Thread is in the cloud once each of its
 * Sessions in the tier is.
 */
export const TierCountSchema = z.object({
  sessions: z.number().int().nonnegative(),
  threads: z.number().int().nonnegative(),
  readable: z.number().int().nonnegative(),
  held: z.number().int().nonnegative(),
  whole: z.number().int().nonnegative(),
  inCloud: z.number().int().nonnegative(),
  threadsInCloud: z.number().int().nonnegative(),
})
export type TierCount = z.infer<typeof TierCountSchema>

/**
 * How a device's sync stands, as its catalog keeps it (`SessionCatalog.syncStatus`): each tier's counts, read from the
 * stores' own marks of what the account holds; how each form's uploads go (null for one not kept); and the Sessions
 * whose copy is older than they are, waiting for their turn (`stale`).
 */
export const CatalogSyncStatusSchema = z.object({
  paused: z.boolean(),
  tiers: z.object({ now: TierCountSchema, day: TierCountSchema, week: TierCountSchema, month: TierCountSchema }),
  stale: z.number().int().nonnegative(),
  copies: UploadsStatusSchema.nullable(),
  originals: UploadsStatusSchema.nullable(),
})
export type CatalogSyncStatus = z.infer<typeof CatalogSyncStatusSchema>

/** At most this many pushes at once, and of them at most one catching up: a Session at work never waits behind a backlog. */
const FLIGHTS = 2
/** The first wait after a failed push, doubling to the most. */
const RETRY_MS = 2_000
const RETRY_MOST_MS = 5 * 60_000
/** Failures kept for the status. */
const FAILURES_KEPT = 5

type Wanted = SyncScope["sessions"][number]
type Retry = { failures: number; after: number; conflictAt?: number }

/**
 * One record store kept in step with one remote for a device's scope, the most wanted Session first. What's in the
 * account is the store's own mark (`RecordStore.notePushed`: the capture a whole push took), so it holds across
 * restarts, and a Session is behind exactly when the store has captured it since. Captures are read from the store
 * (`captureHeads`), whichever process made them, so a capture by the backfill's process goes up as one made here does.
 *
 * At most two pushes go at once and only one of them catching up, so a Session at work goes in the seconds after its
 * capture; catching up is paced to `bytesPerSecond` and waits while the scope is paused. A failed push is tried again
 * later, waiting longer each time, and at once on its next capture; records that went on in two places wait for
 * something new. Idempotent: a push sends only what the remote isn't known to hold, by content-addressed chunks.
 */
export class ScopedUploads {
  readonly #store: RecordStore
  readonly #remote: RecordRemote
  readonly #urgent: RecordSync
  readonly #paced: RecordSync
  readonly #log: (level: "info" | "warn", message: string, fields: Record<string, string | number>) => void
  readonly #now: () => number
  #scope: SyncScope = { sessions: [], paused: false }
  #heads: Map<string, number> | null = null
  #through = 0
  #pushed: Map<string, { capture: number; at: number }> | null = null
  readonly #flights = new Map<string, { busy: boolean; done: Promise<void> }>()
  readonly #retries = new Map<string, Retry>()
  readonly #failures: SyncFailure[] = []
  #pushes = 0
  #bytes = 0
  #failed = 0
  #stopped = false
  #wake: ReturnType<typeof setTimeout> | undefined

  constructor(
    store: RecordStore,
    remote: RecordRemote,
    log: (level: "info" | "warn", message: string, fields: Record<string, string | number>) => void,
    options: { now?: () => number; bytesPerSecond?: number } = {}
  ) {
    this.#store = store
    this.#remote = remote
    this.#log = log
    this.#now = options.now ?? Date.now
    this.#urgent = new RecordSync(store, remote)
    // Paced, one pack in flight: more would only be held in memory waiting for the pace.
    this.#paced = options.bytesPerSecond ? new RecordSync(store, pacedRemote(remote, options.bytesPerSecond), { uploads: 1 }) : this.#urgent
  }

  get remote(): string {
    return this.#remote.id
  }

  /** The Sessions to keep in step, most wanted first; said again as they change. */
  scope(scope: SyncScope): void {
    this.#scope = scope
    this.look()
  }

  /** Reads what was captured since the last look, in any process, and starts the pushes due. */
  look(): void {
    if (this.#stopped) return
    try {
      if (!this.#pushed) this.#pushed = this.#store.pushed(this.#remote.id)
      const read = this.#store.captureHeads(this.#heads ? this.#through : 0)
      if (!this.#heads) this.#heads = read.heads
      else
        for (const [key, capture] of read.heads) {
          this.#heads.set(key, capture)
          // Something new is captured: a wait after a failure, or after records that went on in two places, ends.
          this.#retries.delete(key)
        }
      this.#through = Math.max(this.#through, read.through)
    } catch (error) {
      this.#log("warn", "uploads couldn't read the store", { remote: this.#remote.id, error: error instanceof Error ? error.message : String(error) })
      return
    }
    this.#pump()
  }

  /** Whether the store holds the session at all (captured, or for originals taken by the backfill). */
  held(harness: string, nativeId: string): boolean {
    return this.#heads?.has(keyOf({ harness, nativeId })) ?? false
  }

  /** Whether the account holds the session as the store does, through its last capture. */
  inCloud(harness: string, nativeId: string): boolean {
    const key = keyOf({ harness, nativeId })
    return (this.#heads?.has(key) ?? false) && !this.#behind(key)
  }

  status(): UploadsStatus {
    let lastSuccessAt: number | undefined
    for (const pushed of this.#pushed?.values() ?? []) lastSuccessAt = Math.max(lastSuccessAt ?? 0, pushed.at)
    const status: UploadsStatus = {
      sending: [...this.#flights.keys()].map((key) => { const [harness = "", nativeId = ""] = key.split("\n"); return { harness, nativeId } }),
      paused: this.#scope.paused,
      pushes: this.#pushes,
      bytes: this.#bytes,
      failed: this.#failed,
      failures: this.#failures.filter((failure) => this.#behind(`${failure.harness}\n${failure.nativeId}`)),
    }
    if (lastSuccessAt !== undefined) status.lastSuccessAt = lastSuccessAt
    return status
  }

  /** Once the pushes due now have settled, the ones they let start included. */
  async settled(): Promise<void> {
    while (this.#flights.size) await Promise.all([...this.#flights.values()].map((flight) => flight.done))
  }

  stop(): void {
    this.#stopped = true
    if (this.#wake) clearTimeout(this.#wake)
  }

  #behind(key: string): boolean {
    const head = this.#heads?.get(key)
    if (head === undefined) return false
    const pushed = this.#pushed?.get(key)
    return !pushed || pushed.capture < head
  }

  /** Starts the most wanted pushes due, within the flights: a Session at work has a flight of its own. */
  #pump(): void {
    if (this.#stopped || !this.#heads) return
    const now = this.#now()
    let nextRetry = Number.POSITIVE_INFINITY
    for (const session of this.#scope.sessions) {
      if (this.#flights.size >= FLIGHTS) break
      const key = keyOf(session)
      if (this.#flights.has(key) || !this.#behind(key)) continue
      const retry = this.#retries.get(key)
      if (retry?.conflictAt !== undefined) continue
      if (retry && retry.after > now) {
        nextRetry = Math.min(nextRetry, retry.after)
        continue
      }
      const catchingUp = [...this.#flights.values()].some((flight) => !flight.busy)
      if (!session.busy && (this.#scope.paused || catchingUp)) continue
      this.#start(session, key)
    }
    if (this.#wake) clearTimeout(this.#wake)
    this.#wake = undefined
    if (Number.isFinite(nextRetry)) {
      this.#wake = setTimeout(() => this.#pump(), Math.max(0, nextRetry - now))
      this.#wake.unref?.()
    }
  }

  #start(session: Wanted, key: string): void {
    // The capture this push is sure to carry whole: whatever lands while it runs is behind it, and goes next.
    const head = this.#heads?.get(key) ?? 0
    const done = this.#push(session, key, head).finally(() => {
      this.#flights.delete(key)
      this.#pump()
    })
    this.#flights.set(key, { busy: session.busy, done })
  }

  async #push(session: Wanted, key: string, head: number): Promise<void> {
    const started = this.#now()
    try {
      const report = await (session.busy ? this.#urgent : this.#paced).push(session.harness, session.nativeId)
      if (this.#stopped) return
      const at = this.#now()
      await this.#store.notePushed(this.#remote.id, session.harness, session.nativeId, head, at)
      this.#pushed?.set(key, { capture: Math.max(head, this.#pushed.get(key)?.capture ?? 0), at })
      this.#retries.delete(key)
      if (report.versions || report.chunks) {
        this.#pushes += 1
        this.#bytes += report.bytes
        if (report.ms >= 1_000) this.#log("info", "pushed slowly", { remote: this.#remote.id, harness: session.harness, nativeId: session.nativeId, tier: session.tier, versions: report.versions, bytes: report.bytes, ms: Math.round(report.ms), calls: describeSync(report) })
      }
    } catch (error) {
      if (this.#stopped) return
      const failure = failureOf(error instanceof Error ? error : new Error(String(error)), session, started)
      const retry = this.#retries.get(key) ?? { failures: 0, after: 0 }
      retry.failures += 1
      if (failure.conflict) retry.conflictAt = started
      else retry.after = this.#now() + Math.min(RETRY_MOST_MS, RETRY_MS * 2 ** (retry.failures - 1))
      this.#retries.set(key, retry)
      this.#failed += 1
      this.#failures.unshift(failure)
      this.#failures.splice(FAILURES_KEPT)
      this.#log("warn", failure.conflict ? "records went on in two places; the account's stand" : "push failed", {
        remote: this.#remote.id, harness: session.harness, nativeId: session.nativeId, tier: session.tier, failures: retry.failures, error: failure.message,
        ...failure.correlationId && { correlationId: failure.correlationId },
      })
    }
  }
}

const keyOf = (session: { harness: string; nativeId: string }) => `${session.harness}\n${session.nativeId}`

/**
 * Counts a scope by tier from what each form says of each Session (`readable`, `held`, `whole`): one place reads the
 * stores' marks for the status, so the window, the log and the uploads never disagree about a Session.
 */
export function countTiers(scope: SyncScope, forms: { readable(session: Wanted): boolean; held(session: Wanted): boolean; whole(session: Wanted): boolean }): CatalogSyncStatus["tiers"] {
  const tiers = { now: emptyTier(), day: emptyTier(), week: emptyTier(), month: emptyTier() }
  const threads = new Map<string, { tier: SyncTier; whole: boolean }>()
  for (const session of scope.sessions) {
    const tier = tiers[session.tier]
    tier.sessions += 1
    const readable = forms.readable(session)
    const held = forms.held(session)
    const whole = held && forms.whole(session)
    if (readable) tier.readable += 1
    if (held) tier.held += 1
    if (whole) tier.whole += 1
    if (readable && whole) tier.inCloud += 1
    // A Thread counts in the tier of its first Session in the scope's order: the order puts a Thread's Sessions together.
    const thread = threads.get(session.thread)
    if (!thread) threads.set(session.thread, { tier: session.tier, whole: readable && whole })
    else thread.whole &&= readable && whole
  }
  for (const thread of threads.values()) {
    tiers[thread.tier].threads += 1
    if (thread.whole) tiers[thread.tier].threadsInCloud += 1
  }
  return tiers
}

const emptyTier = (): TierCount => ({ sessions: 0, threads: 0, readable: 0, held: 0, whole: 0, inCloud: 0, threadsInCloud: 0 })

function failureOf(error: Error, session: Wanted, at: number): SyncFailure {
  const failure: SyncFailure = { at, harness: session.harness, nativeId: session.nativeId, message: describeGatewayFailure(error) }
  if (error instanceof GatewayHttpError && error.call?.correlationId) failure.correlationId = error.call.correlationId
  if (error instanceof RecordSyncConflictError) failure.conflict = true
  return failure
}

/**
 * A remote whose uploads go at no more than `bytesPerSecond` on average: each one waits until the bytes before it
 * would have gone at that rate. Reads and small calls aren't paced.
 */
export function pacedRemote(remote: RecordRemote, bytesPerSecond: number, now: () => number = Date.now): RecordRemote {
  let freeAt = 0
  const pace = async (chunks: readonly PackedChunk[]) => {
    const bytes = chunks.reduce((total, chunk) => total + CHUNK_HEADER_BYTES + chunk.body.length, 0)
    const start = Math.max(now(), freeAt)
    freeAt = start + (bytes / bytesPerSecond) * 1_000
    const wait = start - now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  }
  return {
    id: remote.id,
    missing: (hashes, trace) => remote.missing(hashes, trace),
    putChunks: async (pack, trace) => {
      await pace(pack)
      return remote.putChunks(pack, trace)
    },
    readChunks: (hashes, trace) => remote.readChunks(hashes, trace),
    push: (bundle, trace) => remote.push(bundle, trace),
    pushWith: async (bundle, chunks, trace) => {
      await pace(chunks)
      return remote.pushWith(bundle, chunks, trace)
    },
    holdings: (harness, nativeId, after, trace) => remote.holdings(harness, nativeId, after, trace),
    pull: (harness, nativeId, after, trace) => remote.pull(harness, nativeId, after, trace),
    sessions: () => remote.sessions(),
  }
}

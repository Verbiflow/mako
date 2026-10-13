import { type Problem, problemType } from "./envelope.js"
import type { Payload } from "./payload.js"
import type { GatewayFrame, RuntimeFrame } from "./runtime-frames.js"

export type ThreadClaim = { threadId: string; generation: number }

/**
 * How far a runtime has numbered each Thread's events, kept where a restart finds it. A Thread that changes hands
 * keeps its generation when its runtime comes back, so a runtime that restarted and numbered from 1 again would
 * have its new events taken for repeats of old ones. Numbers are reserved ahead in blocks: a stream costs one
 * write per block, and a restart skips what was reserved and not used.
 */
export interface LocalSeqStore {
  /** The highest number reserved for the Thread under this generation; 0 for one never numbered. */
  reserved(threadId: string, generation: number): number
  /** Nothing numbered above the last reservation is sent until this settles. */
  reserve(threadId: string, generation: number, upTo: number): Promise<void>
}

export type RuntimeThreadsOptions = {
  claims?: ThreadClaim[]
  /** Without one, numbers live as long as the process, which suits a runtime whose Threads move when it restarts. */
  numbers?: LocalSeqStore
  /** What may wait for acknowledgement, across every Thread, before the oldest is given up. */
  maxBytes?: number
  /** The largest event sent; a larger one is refused as it's emitted, since the gateway can't take it. */
  maxEventBytes?: number
  /** Events given up unsent: too many waited too long, so the Thread's readers miss them. */
  onLost?: (threadId: string, count: number) => void
  log?: (message: string, fields: Record<string, string | number | boolean | undefined>) => void
  now?: () => number
}

/** What a runtime's Thread shows to someone working out why its events aren't arriving. */
export type ThreadOutboxStats = {
  threadId: string
  generation: number
  /** The last number given to an event. */
  localSeq: number
  /** Events not yet acknowledged, and their size. */
  waiting: number
  bytes: number
  /** How long the oldest of them has waited. */
  oldestMs: number | undefined
  /** Numbered ahead of what's reserved on disk, so not sent yet. */
  unreserved: number
  sent: number
  acked: number
  resent: number
  lost: number
  /** The Thread's last sequence number, from the newest acknowledgement. */
  seq: number | undefined
}

type Waiting = { localSeq: number; event: Payload; correlationId: string | undefined; bytes: number; at: number; sent: boolean }

type Run = {
  generation: number
  next: number
  reserved: number
  reserving: boolean
  waiting: Waiting[]
  /** After a rejection asked for it, what's at and after this was sent again; rejections of later ones that were already on their way are ignored until this one is answered. */
  resentFrom: number | undefined
  sent: number
  acked: number
  resent: number
  lost: number
  seq: number | undefined
}

const RESERVE_BLOCK = 1_000
const RESERVE_RETRY_MS = 1_000
const MAX_BYTES = 64 * 1024 * 1024
/** Below the 1 MiB a Cloudflare WebSocket message may carry, with room for the frame around it. */
export const MAX_EVENT_BYTES = 768 * 1024

/**
 * The Threads a runtime runs and the events it owes each: what it claims when it enrols, the generation each runs
 * under, and every event numbered by `localSeq` and kept until its Thread acknowledges it. It outlives any one link:
 * `serveRuntime` attaches it to each link as it enrols, which resends what's waiting, in order; events emitted while
 * no link is up wait for the next.
 *
 * - An acknowledgement drops its event. A rejection the gateway may recover from (its Thread's object didn't take
 *   the batch) sends that event and everything after it again, once.
 * - A fence, or a rejection as fenced, drops the Thread and what it was owed: nothing it sends under that
 *   generation would be recorded.
 * - Memory is bounded: past `maxBytes` the oldest events are given up and counted as lost, rather than the runtime
 *   running out of memory while its link is down.
 */
export class RuntimeThreads {
  readonly #runs = new Map<string, Run>()
  readonly #numbers: LocalSeqStore | undefined
  readonly #maxBytes: number
  readonly #maxEventBytes: number
  readonly #options: RuntimeThreadsOptions
  readonly #now: () => number
  #send: ((frame: RuntimeFrame) => void) | undefined
  #bytes = 0

  constructor(options: RuntimeThreadsOptions = {}) {
    this.#options = options
    this.#numbers = options.numbers
    this.#maxBytes = options.maxBytes ?? MAX_BYTES
    this.#maxEventBytes = options.maxEventBytes ?? MAX_EVENT_BYTES
    this.#now = options.now ?? Date.now
    for (const claim of options.claims ?? []) this.assign(claim.threadId, claim.generation)
  }

  claims(): ThreadClaim[] {
    return [...this.#runs].map(([threadId, run]) => ({ threadId, generation: run.generation }))
  }

  generation(threadId: string): number | undefined {
    return this.#runs.get(threadId)?.generation
  }

  /** Runs the Thread under `generation` from now on. The same generation again keeps what it's owed. */
  assign(threadId: string, generation: number): void {
    const held = this.#runs.get(threadId)
    if (held?.generation === generation) return
    if (held) this.#forget(threadId, held)
    const reserved = this.#numbers ? this.#numbers.reserved(threadId, generation) : Number.MAX_SAFE_INTEGER
    this.#runs.set(threadId, { generation, next: (this.#numbers ? reserved : 0) + 1, reserved, reserving: false, waiting: [], resentFrom: undefined, sent: 0, acked: 0, resent: 0, lost: 0, seq: undefined })
  }

  /** Stops running the Thread under any generation below `generation`. */
  fence(threadId: string, generation: number): void {
    const held = this.#runs.get(threadId)
    if (held && held.generation < generation) this.#forget(threadId, held)
  }

  /**
   * Numbers an event of the Thread and sends it, or keeps it for the next link. Undefined when the runtime doesn't
   * run the Thread: an event for it would be refused. Throws for an event larger than the gateway takes.
   */
  emit(threadId: string, event: Payload, correlationId?: string): number | undefined {
    const run = this.#runs.get(threadId)
    if (!run) return undefined
    const bytes = event.text.length
    // A character is at most three bytes in UTF-8, so only a long event is measured.
    if (bytes * 3 > this.#maxEventBytes) {
      const size = new TextEncoder().encode(event.text).byteLength
      if (size > this.#maxEventBytes) throw new RangeError(`An event of ${size} bytes is over the ${this.#maxEventBytes} a runtime may send`)
    }
    const waiting: Waiting = { localSeq: run.next++, event, correlationId, bytes, at: this.#now(), sent: false }
    run.waiting.push(waiting)
    this.#bytes += bytes
    this.#bound()
    if (waiting.localSeq > run.reserved) this.#reserve(threadId, run)
    else this.#sendOne(threadId, run, waiting)
    return waiting.localSeq
  }

  /** Every Thread's outbox, for a runtime's state page. */
  stats(): ThreadOutboxStats[] {
    const now = this.#now()
    return [...this.#runs].map(([threadId, run]) => ({
      threadId,
      generation: run.generation,
      localSeq: run.next - 1,
      waiting: run.waiting.length,
      bytes: run.waiting.reduce((total, waiting) => total + waiting.bytes, 0),
      oldestMs: run.waiting[0] ? now - run.waiting[0].at : undefined,
      unreserved: run.waiting.filter((waiting) => waiting.localSeq > run.reserved).length,
      sent: run.sent,
      acked: run.acked,
      resent: run.resent,
      lost: run.lost,
      seq: run.seq,
    }))
  }

  /** A link enrolled: everything waiting goes on it, in order. */
  attach(send: (frame: RuntimeFrame) => void): void {
    this.#send = send
    for (const [threadId, run] of this.#runs) {
      run.resentFrom = undefined
      for (const waiting of run.waiting) waiting.sent = false
      this.#flush(threadId, run)
    }
  }

  detach(send: (frame: RuntimeFrame) => void): void {
    if (this.#send === send) this.#send = undefined
  }

  /** A gateway frame about the Threads: an assignment, a fence, an acknowledgement or a rejection. */
  receive(frame: GatewayFrame): void {
    if (frame.type === "assign") return this.assign(frame.threadId, frame.generation)
    if (frame.type === "fence") return this.fence(frame.threadId, frame.generation)
    if (frame.type === "ack") return this.#acked(frame)
    if (frame.type === "rejected") return this.#rejected(frame)
  }

  #acked(frame: Extract<GatewayFrame, { type: "ack" }>): void {
    const run = this.#runs.get(frame.threadId)
    if (!run || run.generation !== frame.generation) return
    if (run.resentFrom === frame.localSeq) run.resentFrom = undefined
    run.seq = Math.max(run.seq ?? 0, frame.seq)
    const index = run.waiting.findIndex((waiting) => waiting.localSeq === frame.localSeq)
    if (index === -1) return
    const [done] = run.waiting.splice(index, 1)
    this.#bytes -= done!.bytes
    run.acked += 1
  }

  #rejected(frame: Extract<GatewayFrame, { type: "rejected" }>): void {
    const run = this.#runs.get(frame.threadId)
    if (!run || run.generation !== frame.generation) return
    if (problemType(frame.problem) === "fenced") {
      this.#options.log?.("a Thread refused this runtime's events as fenced; it no longer runs it", { threadId: frame.threadId, generation: run.generation, localSeq: frame.localSeq })
      return this.#forget(frame.threadId, run)
    }
    // Later events sent before the resend was asked for are rejected too; the resend already carries them.
    if (run.resentFrom !== undefined && frame.localSeq > run.resentFrom) return
    run.resentFrom = frame.localSeq
    let count = 0
    for (const waiting of run.waiting)
      if (waiting.localSeq >= frame.localSeq) {
        waiting.sent = false
        count += 1
      }
    run.resent += count
    this.#options.log?.("a Thread didn't take this runtime's events; sending them again", { threadId: frame.threadId, from: frame.localSeq, events: count, problem: describe(frame.problem) })
    this.#flush(frame.threadId, run)
  }

  #flush(threadId: string, run: Run): void {
    for (const waiting of run.waiting) {
      if (waiting.localSeq > run.reserved) return
      if (!waiting.sent) this.#sendOne(threadId, run, waiting)
    }
  }

  #sendOne(threadId: string, run: Run, waiting: Waiting): void {
    const send = this.#send
    if (!send) return
    waiting.sent = true
    run.sent += 1
    const frame: Extract<RuntimeFrame, { type: "event" }> = { type: "event", threadId, generation: run.generation, localSeq: waiting.localSeq, event: waiting.event }
    if (waiting.correlationId) frame.correlationId = waiting.correlationId
    send(frame)
  }

  #reserve(threadId: string, run: Run): void {
    const numbers = this.#numbers
    if (!numbers || run.reserving) return
    run.reserving = true
    // A block from the newest number, which is the first unreserved one unless more came while a write was out.
    const upTo = run.next - 2 + RESERVE_BLOCK
    numbers.reserve(threadId, run.generation, upTo).then(
      () => {
        run.reserving = false
        if (this.#runs.get(threadId) !== run) return
        run.reserved = Math.max(run.reserved, upTo)
        this.#flush(threadId, run)
        if (run.next - 1 > run.reserved) this.#reserve(threadId, run)
      },
      (error: Error) => {
        run.reserving = false
        this.#options.log?.("numbers for a Thread's events couldn't be reserved; trying again", { threadId, upTo, error: error.message })
        const retry = setTimeout(() => {
          if (this.#runs.get(threadId) === run) this.#reserve(threadId, run)
        }, RESERVE_RETRY_MS)
        retry.unref?.()
      }
    )
  }

  /** Past the bound, the oldest events of any Thread are given up, oldest first. */
  #bound(): void {
    while (this.#bytes > this.#maxBytes) {
      let oldest: [string, Run] | undefined
      for (const entry of this.#runs) {
        const first = entry[1].waiting[0]
        if (first && (!oldest || first.at < oldest[1].waiting[0]!.at)) oldest = entry
      }
      if (!oldest) return
      const [threadId, run] = oldest
      let lost = 0
      while (this.#bytes > this.#maxBytes && run.waiting.length) {
        this.#bytes -= run.waiting.shift()!.bytes
        lost += 1
      }
      run.lost += lost
      this.#options.log?.("a Thread's events waited past the outbox's bound; the oldest were given up", { threadId, lost, maxBytes: this.#maxBytes })
      this.#options.onLost?.(threadId, lost)
    }
  }

  #forget(threadId: string, run: Run): void {
    for (const waiting of run.waiting) this.#bytes -= waiting.bytes
    this.#runs.delete(threadId)
  }
}

function describe(reason: Problem): string {
  return reason.detail ? `${problemType(reason)}: ${reason.detail}` : problemType(reason)
}

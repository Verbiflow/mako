import { z } from "zod"
import { type EventFrame, nextStep } from "./events.js"

/**
 * A watched conversation's live stream (`session:<runtime>:<conversation>`), numbered and briefly kept by the gateway, so
 * a watcher whose link dropped picks up where it was rather than reading the whole conversation again.
 *
 * The gateway gives each update the next number on its stream (from a base above any number it gave before, so numbers
 * only rise, across restarts too) and keeps the last few in memory (`LiveTail`), never on disk. A watcher that subscribes
 * hears a notice first (`streamNotice`): `head`, the last number given, after which come the updates after the number it
 * asked for, then live ones; or `reread` when the tail doesn't reach back that far (or the stream started over), which
 * it answers by reading the conversation as a snapshot. A watcher on a gateway that sends no notice reads the stream as
 * before: updates relayed, numbered by the clock, a missed one found from its batches' revisions.
 *
 * A notice is a line no runtime writes, so a reader that doesn't know it passes it over.
 */
export const StreamNoticeSchema = z
  .object({ streamNotice: z.enum(["head", "reread"]), head: z.number().int().nonnegative() })
  .strict()
export type StreamNotice = z.infer<typeof StreamNoticeSchema>

const NOTICE_START = '{"streamNotice":'

export function streamNoticeText(notice: StreamNotice): string {
  return JSON.stringify(StreamNoticeSchema.parse(notice))
}

/** The notice a line is, or undefined for any other line: told apart by its first characters, so an update is never parsed. */
export function readStreamNotice(text: string): StreamNotice | undefined {
  if (!text.startsWith(NOTICE_START)) return undefined
  try {
    return StreamNoticeSchema.safeParse(JSON.parse(text)).data
  } catch {
    return undefined
  }
}

/**
 * A sampled live update's trace, carried as its correlation ID (a cloud Thread's `event`, a conversation's `live`) and
 * logged at each hop that carries it, begins so; any other correlation ID is an operation's.
 */
export const TRACE_PREFIX = "st-"

/** At most this many updates are kept of one stream, and this many bytes: about ten seconds of a fast answer. */
export const TAIL_FRAMES = 512
export const TAIL_BYTES = 256 * 1024
/**
 * A stream nobody watches any more keeps its numbering and tail this long, and its runtime keeps sending, so a watcher
 * whose link dropped finds what went by meanwhile when it's back.
 */
export const LINGER_MS = 30_000

/** One update as the gateway kept it: its number, when it relayed it, its line, and its trace, if it carried one. */
export type TailFrame = { seq: number; at: string; text: string; correlationId?: string }

/** What the tail did, for the gateway's `inspect` and for logs. */
export type TailView = {
  base: number
  head: number
  kept: { first: number | undefined; frames: number; bytes: number }
  relayed: number
  duplicates: number
  replayed: number
  rereads: number
  /** The runtime's number (`n`) of the last update relayed, which a new link's `watch` says. */
  runtime: number | undefined
}

/**
 * One stream's numbering and its last few updates, held by whoever relays it (a gateway's runtime object, the fake
 * gateway). A runtime that numbers its updates (`n`, link version 9) and sends some again on a new link has each relayed
 * once.
 */
export class LiveTail {
  readonly base: number
  #head: number
  readonly #frames: TailFrame[] = []
  #bytes = 0
  #runtime: number | undefined
  readonly #maxFrames: number
  readonly #maxBytes: number
  readonly #stats = { relayed: 0, duplicates: 0, replayed: 0, rereads: 0 }

  /** `base` is above every number given to this stream before: its first update is `base + 1`. */
  constructor(base: number, limits: { frames?: number; bytes?: number } = {}) {
    this.base = Math.max(1, Math.floor(base))
    this.#head = this.base
    this.#maxFrames = limits.frames ?? TAIL_FRAMES
    this.#maxBytes = limits.bytes ?? TAIL_BYTES
  }

  /** The last number given, or the base before any. */
  get head(): number {
    return this.#head
  }

  /** The runtime's number of the last update relayed. */
  get runtime(): number | undefined {
    return this.#runtime
  }

  /**
   * A runtime's update: numbered, kept, and returned to be sent to the stream's watchers; undefined when its number says
   * it was relayed already (a runtime sending again what its old link may have carried).
   */
  take(text: string, at: Date, from: { n?: number; correlationId?: string } = {}): TailFrame | undefined {
    if (from.n !== undefined) {
      if (this.#runtime !== undefined && from.n <= this.#runtime) {
        this.#stats.duplicates += 1
        return undefined
      }
      this.#runtime = from.n
    }
    this.#head += 1
    const frame: TailFrame = { seq: this.#head, at: at.toISOString(), text, ...(from.correlationId && { correlationId: from.correlationId }) }
    this.#frames.push(frame)
    this.#bytes += text.length
    while (this.#frames.length > this.#maxFrames || (this.#bytes > this.#maxBytes && this.#frames.length > 1)) this.#bytes -= this.#frames.shift()!.text.length
    this.#stats.relayed += 1
    return frame
  }

  /**
   * What a watcher that holds everything up to `after` is sent: the kept updates after it (none when it's current), or
   * undefined when the tail no longer reaches back to it, or `after` is from before this stream began.
   */
  since(after: number): TailFrame[] | undefined {
    const first = this.#frames[0]?.seq ?? this.#head + 1
    if (after < this.base || after > this.#head || after < first - 1) {
      this.#stats.rereads += 1
      return undefined
    }
    const frames = this.#frames.slice(after - first + 1)
    this.#stats.replayed += frames.length
    return frames
  }

  /**
   * The frames a subscription opens with: the `head` notice and the updates after `after` (0 for a new watcher: live
   * ones only), or the `reread` notice alone when the tail can't serve it.
   */
  opening(after: number): Array<{ seq: number; text: string; at?: string; correlationId?: string }> {
    const head = Math.max(1, this.#head)
    if (after === 0) return [{ seq: head, text: streamNoticeText({ streamNotice: "head", head: this.#head }) }]
    const frames = this.since(after)
    if (!frames) return [{ seq: head, text: streamNoticeText({ streamNotice: "reread", head: this.#head }) }]
    return [{ seq: head, text: streamNoticeText({ streamNotice: "head", head: this.#head }) }, ...frames]
  }

  view(): TailView {
    return {
      base: this.base,
      head: this.#head,
      kept: { first: this.#frames[0]?.seq, frames: this.#frames.length, bytes: this.#bytes },
      ...this.#stats,
      runtime: this.#runtime,
    }
  }
}

/**
 * What a follower does with one frame of a stream it follows:
 * - `apply` it;
 * - drop a `duplicate`;
 * - `gap`: something between went missing; subscribe again after `after`, which the gateway answers from what it kept;
 * - `reread`: what went by can't be had; read the conversation again as a snapshot;
 * - `notice`: the gateway's word on the stream, nothing to show.
 */
export type CursorVerdict =
  | { kind: "apply" }
  | { kind: "duplicate" }
  | { kind: "gap"; after: number }
  | { kind: "reread" }
  | { kind: "notice" }

/**
 * A follower's place in one stream. A log (`thread:`, `account:`) is numbered with no gaps from the start. A live
 * conversation's stream is numbered so only once its gateway says so (`streamNotice`); until then, on an older gateway,
 * every update is applied and a missed one is found from its batch's revision, as before.
 */
export class StreamCursor {
  #numbered: boolean
  #last: number | undefined
  /**
   * A gap was found and the stream asked for again: updates of the old subscription still on their way are dropped
   * until what was asked for begins (the notice of a live stream, the next number of a log), since it brings them.
   */
  #awaiting = false

  constructor(kind: "log" | "live", last?: number) {
    this.#numbered = kind === "log"
    this.#last = last
  }

  /** The last number applied, if any. */
  get last(): number | undefined {
    return this.#last
  }

  /** Whether the stream's numbers are its own and gap-free, so a gap can be told. */
  get numbered(): boolean {
    return this.#numbered
  }

  /** What to subscribe after for a live stream: where it left off, once the gateway numbers it; otherwise from now. */
  resumeAfter(): number {
    return this.#numbered && this.#last !== undefined ? this.#last : 0
  }

  heard(frame: Pick<EventFrame, "seq"> & { text: string }): CursorVerdict {
    const notice = readStreamNotice(frame.text)
    if (notice) {
      const resuming = this.#numbered && this.#last !== undefined
      this.#numbered = true
      this.#awaiting = false
      if (notice.streamNotice === "reread" || (resuming && notice.head < this.#last!)) {
        this.#last = notice.head
        return { kind: "reread" }
      }
      // A new watcher starts at the head; one resuming keeps its place, and what it missed follows.
      if (!resuming) this.#last = notice.head
      return { kind: "notice" }
    }
    if (!this.#numbered) return { kind: "apply" }
    if (this.#last === undefined) {
      this.#last = frame.seq
      return { kind: "apply" }
    }
    const step = nextStep(this.#last, frame)
    if (step.kind === "apply") {
      this.#awaiting = false
      this.#last = frame.seq
      return step
    }
    if (step.kind === "duplicate" || this.#awaiting) return { kind: "duplicate" }
    this.#awaiting = true
    return step
  }

  /** After a snapshot read the stream again from scratch: whatever it numbered before no longer counts. */
  restart(head?: number): void {
    this.#last = head
    this.#awaiting = false
  }
}

/**
 * How long a follower waits before following again after its stream ended: at once the first time (with a little
 * jitter, so every device of an account doesn't come back in the same millisecond after a gateway restart), then backing
 * off while it keeps failing.
 */
export function followAgainInMs(failures: number, random: () => number = Math.random): number {
  if (failures <= 0) return Math.round(random() * 100)
  return FOLLOW_BACKOFF_MS[Math.min(failures - 1, FOLLOW_BACKOFF_MS.length - 1)]!
}
const FOLLOW_BACKOFF_MS = [250, 1_000, 2_000, 5_000, 10_000, 30_000] as const

/**
 * A follower of a conversation at work that hears nothing for this long asks its connection whether it's alive
 * (`probe`): a stalled link is found in seconds, not at the next missed heartbeat.
 */
export const SILENT_WHILE_WORKING_MS = 3_000
/** How long a probed connection has to answer before it's replaced. */
export const PROBE_ANSWER_MS = 1_500

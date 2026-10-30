import type { ListedMove } from "@mako/protocol/thread-listing"
import type { ThreadMoveStep } from "../contracts/cloud-threads.js"

/**
 * The Threads this host is moving to the cloud now, by Thread, as the account's list says them (`ListedMove`): from a
 * move's first step to its last, so every device sees the move from where it starts, not only once the Thread is in
 * transit. The steps are the move's own (`CloudMoves`); this keeps only the latest of each Thread, with when it began.
 */
export class MovesUnderWay {
  readonly #moving = new Map<string, { move: string; listed: ListedMove }>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /**
   * A step of `move`, which moves `thread`: kept while it goes, gone at its end (moved, or kept here). Whether what a
   * list shows of the Thread changed: a step's progress alone (its bytes) doesn't.
   */
  stepped(thread: string | undefined, move: string, step: ThreadMoveStep): boolean {
    if (!thread) return false
    if (step.kind === "moved" || step.kind === "kept-here") return this.#moving.delete(thread)
    const held = this.#moving.get(thread)
    if (held?.move === move && held.listed.step === step.kind) return false
    this.#moving.set(thread, { move, listed: { to: "cloud", step: step.kind, since: new Date(this.#now()).toISOString() } })
    return true
  }

  /** The move of `thread` under way, as its rows say it, if one is. */
  of(thread: string): ListedMove | undefined {
    return this.#moving.get(thread)?.listed
  }
}

/**
 * How fast streamed text is revealed. The page holds a streaming answer's text as it arrives, in lumps: a paint every
 * frame or a few (`StreamFrames`), each with whatever came since. Shown as it lands, the answer jumps a phrase at a
 * time. Revealed at a steady pace it reads as written: each lump is spread over about the time the lumps come apart
 * (a smoothed gap between arrivals), so the reveal finishes one as the next lands.
 *
 * The pace never holds text back for long: a lump is fully shown within `REVEAL_MAX_MS` of landing, whatever the gaps
 * were, and once the stream ends what's left is shown within `REVEAL_DRAIN_MS`. Lengths are in characters of the text
 * on the page; time is whatever clock the caller steps it with.
 */
export const REVEAL_MIN_MS = 40
/** Past the longest gap between two paints of a streaming answer (`STREAM_FRAME_MAX_MS`, 90 ms, for a very long piece). */
export const REVEAL_MAX_MS = 120
export const REVEAL_DRAIN_MS = 160
/** How much of the smoothed gap each new arrival's gap replaces. */
const GAP_WEIGHT = 0.3

export class RevealPace {
  /** Characters shown, as a fraction while a step is under way. */
  #shown = 0
  #target = 0
  /** Characters per millisecond. */
  #rate = 0
  #gap = REVEAL_MIN_MS
  #arrivedAt: number | undefined
  #steppedAt = 0

  /** Everything on the page is shown: where a reveal starts from, and what a hidden tab or reduced motion asks. */
  showAll(length: number, now: number): void {
    this.#shown = this.#target = length
    this.#rate = 0
    this.#steppedAt = now
  }

  /** The page now holds `length` characters. */
  arrived(length: number, now: number): void {
    // Text rewritten shorter (Markdown closing a structure) hides nothing that was shown.
    if (length <= this.#target) {
      this.#target = length
      this.#shown = Math.min(this.#shown, length)
      return
    }
    this.step(now)
    if (this.#arrivedAt !== undefined) {
      const gap = Math.min(REVEAL_MAX_MS, Math.max(REVEAL_MIN_MS, now - this.#arrivedAt))
      this.#gap += (gap - this.#gap) * GAP_WEIGHT
    }
    this.#arrivedAt = now
    this.#target = length
    this.#rate = (length - this.#shown) / Math.min(REVEAL_MAX_MS, Math.max(REVEAL_MIN_MS, this.#gap))
  }

  /** The stream ended: what's left is shown within `REVEAL_DRAIN_MS`, or sooner at the pace it had. */
  drain(now: number): void {
    this.step(now)
    this.#rate = Math.max(this.#rate, (this.#target - this.#shown) / REVEAL_DRAIN_MS)
  }

  /** Characters shown at `now`. */
  step(now: number): number {
    this.#shown = Math.min(this.#target, this.#shown + this.#rate * Math.max(0, now - this.#steppedAt))
    this.#steppedAt = now
    return Math.floor(this.#shown)
  }

  /** Whether everything that arrived is shown. */
  get caughtUp(): boolean {
    return this.#shown >= this.#target
  }
}

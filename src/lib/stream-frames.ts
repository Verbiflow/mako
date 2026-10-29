/**
 * How often a streaming answer repaints. The piece being written is parsed again on each paint; on 2026-10-28 that
 * cost about 1.2 ms per 1,000 characters (1.2 ms at 500, 9 ms at 8,000, 19 ms at 16,000, where the parse moves to a
 * worker). So a paint comes at most every `STREAM_FRAME_MS`, and a long piece waits longer, up to
 * `STREAM_FRAME_MAX_MS`, so its parse never takes more than about a fifth of the renderer's time.
 */
export const STREAM_FRAME_MS = 50
export const STREAM_FRAME_MAX_MS = 90
/** Characters per millisecond of frame past `STREAM_FRAME_MS`: 9,000 characters paint every 50 ms, 16,000 every 89. */
const CHARS_PER_FRAME_MS = 180

/** The shortest time between two paints of `chars` characters of streaming text. */
export function streamFrameMs(chars: number): number {
  return Math.min(STREAM_FRAME_MAX_MS, Math.max(STREAM_FRAME_MS, chars / CHARS_PER_FRAME_MS))
}

/** The time, and a run after `ms` that the function it returns cancels. */
export interface StreamClock {
  now(): number
  schedule(run: () => void, ms: number): () => void
}

const browserClock: StreamClock = {
  now: () => performance.now(),
  schedule: (run, ms) => {
    const timer = setTimeout(run, ms)
    return () => clearTimeout(timer)
  },
}

/**
 * Paints the latest of a streaming text, throttled with a leading edge: the first change of a burst, after a frame
 * without a paint, paints at once (on the next turn of the event loop); later ones wait for the frame to pass, and the
 * paint then shows the latest text. A pending paint outlives later changes on purpose: cancelling it on each token
 * would make it a debounce, which never fires under a steady stream.
 *
 * `stop` clears the pending paint and forgets it was pending. It once didn't (`useThrottled`): StrictMode's simulated
 * remount ran the cleanup, and the next change saw a paint still pending that never came, so every streamed answer
 * sat on its first character until its turn ended.
 */
export class StreamFrames {
  readonly #paint: (text: string) => void
  readonly #clock: StreamClock
  /** Cancels the paint pending, while one is. */
  #pending: (() => void) | undefined
  #latest = ""
  #paintedAt = Number.NEGATIVE_INFINITY

  constructor(paint: (text: string) => void, clock: StreamClock = browserClock) {
    this.#paint = paint
    this.#clock = clock
  }

  /** The text changed while it streams. */
  next(text: string): void {
    this.#latest = text
    if (this.#pending) return
    const wait = Math.max(0, this.#paintedAt + streamFrameMs(text.length) - this.#clock.now())
    this.#pending = this.#clock.schedule(() => {
      this.#pending = undefined
      this.#paintedAt = this.#clock.now()
      this.#paint(this.#latest)
    }, wait)
  }

  /** Nothing more is painted: the component went, or StrictMode is remounting it. */
  stop(): void {
    this.#pending?.()
    this.#pending = undefined
  }
}

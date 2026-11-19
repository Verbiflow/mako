import { LIVE_AHEAD_MS, LIVE_FRAME_MS } from "@mako/host/contracts/live-conversations"

/**
 * How often a streaming answer repaints. The piece being written is parsed again on each paint; on 2026-10-28 that
 * cost about 1.2 ms per 1,000 characters (1.2 ms at 500, 9 ms at 8,000, 19 ms at 16,000, where the parse moves to a
 * worker). So a paint waits by the size of what it parses (`streamFrameMs`): a paragraph paints every other frame of
 * the display (`STREAM_FRAME_MIN_MS`, two of the frames a window on the host's machine hears text ahead of its batch
 * on), so a word is on the page a frame or two after the window has it; a long piece (a code block, a table) waits longer, up to
 * `STREAM_FRAME_MAX_MS`, so its parse stays a small share of the renderer's time. `STREAM_FRAME_MS` is the frame the
 * host sends a stream's batches on.
 */
export const STREAM_FRAME_MS = LIVE_FRAME_MS
export const STREAM_FRAME_MAX_MS = 90
/**
 * The least between two paints: two of the frames the host says text ahead on (`LIVE_AHEAD_MS`). What a paint parses
 * is the piece being written, not the answer (`streamPieces`), and a paragraph is a few hundred characters: painted
 * every 50 ms whatever its size, a word waited three or four frames for nothing. Not every frame: a paint is also a
 * commit, a style pass and a layout, about 1.4 ms on the development build, and on each of a long answer's 1,000
 * frames that was a fifth more main-thread time than the answer took before (`npm run bench:window`), for words
 * 8 ms sooner than every other frame gives.
 */
export const STREAM_FRAME_MIN_MS = 2 * LIVE_AHEAD_MS
/**
 * Characters parsed per millisecond of frame: up to 960 characters paint every 32 ms, 1,500 every 50, 2,700 and more
 * every 90. At 1.2 ms a thousand characters that keeps the parse a few hundredths of the renderer's time, and what a
 * paint lays out again grows with the piece too: a paragraph of 1,500 characters painted every 32 ms cost a long
 * answer a quarter more main-thread time than it took drawn every 400 ms (`npm run bench:window`).
 */
const CHARS_PER_FRAME_MS = 30

/** The shortest time between two paints that each parse `chars` characters of streaming text. */
export function streamFrameMs(chars: number): number {
  return Math.min(STREAM_FRAME_MAX_MS, Math.max(STREAM_FRAME_MIN_MS, chars / CHARS_PER_FRAME_MS))
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
 * `stop` clears the pending paint and forgets it was pending. It once didn't (in the prose's hook): StrictMode's simulated
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

  /** Whether a paint waits: what's handed to `next` meanwhile is shown by it, whatever its size. */
  get pending(): boolean {
    return this.#pending !== undefined
  }

  /** The text changed while it streams. `parsed` is how much of it a paint parses, when that's less than all of it. */
  next(text: string, parsed = text.length): void {
    this.#latest = text
    if (this.#pending) return
    const wait = Math.max(0, this.#paintedAt + streamFrameMs(parsed) - this.#clock.now())
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

import type { Exchange } from "@/lib/exchanges"
import type { StreamClock } from "@/lib/stream-frames"

/**
 * How often a streaming answer's turn is drawn again. Every batch the host sends (one a frame, `LIVE_FRAME_MS`) used to
 * draw the transcript again: the timeline, the turn and its answer. That is most of the renderer's time while an
 * answer streams, and none of it is the answer's words: those reach the page by themselves, a frame after the window
 * hears them (`useStreamedText`, the prose reading its own text from the conversation). So:
 * - the first words of an answer draw at once, which is what mounts that prose;
 * - after them the turn is drawn again at most every `STREAM_PACE_MS` while only the answer grows, whatever its
 *   length: what the turn holds besides the words doesn't change with them, and a second is soon enough for
 *   anything that reads the turns as drawn (the navigator, the reading report).
 * Anything but an answer growing (a tool call, a status, its end) draws at once, with what it held.
 *
 * A short answer once drew its turn every frame and a long one every 400 ms or at a paragraph's end, because the turn's
 * draw was also how the words arrived: a long answer's words then waited for it, 69 ms at the median and 400 at worst
 * after the window had them.
 */
export const STREAM_PACE_MS = 1_000

/** The answer being written in a turn: the text of its newest block, where that's text. */
function growing(exchange: Exchange): string | undefined {
  const message = exchange.response.at(-1)
  const block = message?.blocks.at(-1)
  return message?.role === "assistant" && block?.type === "text" ? block.text : undefined
}

/**
 * Whether `after` differs from `before` only by the newest turn's answer having grown: the same turns, each but the
 * newest the very same, and in the newest only its last text block longer, starting with what it held. Then it's the
 * answer's two texts; otherwise undefined, and `after` is drawn at once.
 */
export function answerGrew(before: readonly Exchange[], after: readonly Exchange[]): { drawn: string; now: string } | undefined {
  if (before === after || before.length !== after.length || !after.length) return undefined
  for (let index = 0; index < after.length - 1; index++) if (before[index] !== after[index]) return undefined
  const was = before.at(-1)!
  const is = after.at(-1)!
  if (was.id !== is.id || was.prompt !== is.prompt || was.opener !== is.opener || was.system.length !== is.system.length) return undefined
  if (was.response.length !== is.response.length) return undefined
  for (let index = 0; index < is.response.length - 1; index++) if (was.response[index] !== is.response[index]) return undefined
  const message = was.response.at(-1)
  const next = is.response.at(-1)
  if (!message || !next || message.id !== next.id || message.blocks.length !== next.blocks.length) return undefined
  for (let index = 0; index < next.blocks.length - 1; index++) if (message.blocks[index] !== next.blocks[index]) return undefined
  const drawn = growing(was)
  const now = growing(is)
  if (drawn === undefined || now === undefined || now.length <= drawn.length || !now.startsWith(drawn)) return undefined
  return { drawn, now }
}

/** How long after `paintedAt` the turn may next be drawn, now that its answer was last drawn as `drawn` and has grown. */
export function answerPaceMs(drawn: string): number {
  return drawn.trim() ? STREAM_PACE_MS : 0
}

/**
 * The turns a transcript draws, paced while an answer streams (`answerPaceMs`). `take` hears every change of the turns
 * the store holds; `shown` is what to draw, the same value between two calls of `notify`. A change other than the answer
 * growing is drawn at once, and so is what was held with it.
 */
export class ExchangePacer<Turns extends { exchanges: readonly Exchange[] }> {
  readonly #clock: StreamClock
  /** What was drawn last, while a draw waits; undefined when nothing waits, and the store's value is drawn. */
  #held: Turns | undefined
  #seen: Turns | undefined
  #paintedAt = Number.NEGATIVE_INFINITY
  #cancel: (() => void) | undefined
  /** When the waiting draw comes. */
  #due = Number.POSITIVE_INFINITY

  constructor(clock: StreamClock) {
    this.#clock = clock
  }

  /** What to draw: what's held while a draw waits, else the store's own. */
  shown(latest: Turns | undefined): Turns | undefined {
    if (this.#held) return this.#held
    if (latest !== this.#seen) {
      this.#seen = latest
      this.#paintedAt = this.#clock.now()
    }
    return latest
  }

  /** The store changed to `latest`: draw it now, or once its pace allows. */
  take(latest: Turns | undefined, notify: () => void): void {
    const drawn = this.#held ?? this.#seen
    const grew = drawn && latest ? answerGrew(drawn.exchanges, latest.exchanges) : undefined
    if (!grew || !drawn) {
      this.#release()
      notify()
      return
    }
    const now = this.#clock.now()
    const due = this.#paintedAt + answerPaceMs(grew.drawn)
    // A draw already waits for as soon or sooner: it shows this too.
    if (this.#held && due >= this.#due) return
    if (due <= now) {
      this.#release()
      notify()
      return
    }
    this.#cancel?.()
    this.#held = drawn
    this.#due = due
    this.#cancel = this.#clock.schedule(() => {
      this.#cancel = undefined
      this.#held = undefined
      this.#due = Number.POSITIVE_INFINITY
      notify()
    }, due - now)
  }

  /** Nothing waits any more: the next `shown` is the store's own. */
  #release(): void {
    this.#cancel?.()
    this.#cancel = undefined
    this.#held = undefined
    this.#due = Number.POSITIVE_INFINITY
  }

  stop(): void {
    this.#release()
  }
}

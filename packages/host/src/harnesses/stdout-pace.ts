interface StdoutPaceOptions<Source> {
  /** How much of one turn of the loop goes to output before the rest waits. */
  turnMs: number
  take(source: Source, chunk: Buffer): void
  pause(source: Source): void
  resume(source: Source): void
  /**
   * What must be done off the thread before a chunk is taken (a file its handling reads, read ahead); undefined when
   * nothing must. The chunk, and what its process says meanwhile, wait for it in their order.
   */
  before?(source: Source, chunk: Buffer): Promise<void> | undefined
}

interface Waiting {
  chunks: Buffer[]
  /** Whether the first of `chunks` is ready to take: `before` is done for it, or asked for nothing. */
  ready: boolean
  /** Whether a `before` is under way for the first of `chunks`. */
  preparing: boolean
}

/**
 * One turn of the loop takes every process's output that is ready, and nothing else of the host's runs between
 * them: thirty turns that ended together were 170 ms of handling in one stretch. Past `turnMs` of a turn the rest
 * waits for the next, each process's own output in its order and its pipe paused meanwhile, so the windows'
 * requests and the timers run in between. The processes waiting are taken a chunk each in turn.
 *
 * A chunk whose handling needs something read first (`before`) waits for that too, off the thread, with the same
 * order kept for its process: what must precede a message's handling still does, and the loop is free meanwhile.
 */
export class StdoutPace<Source> {
  private spentMs = 0
  private armed = false
  /** Each process with output waiting, the longest-waiting first. */
  private readonly waiting = new Map<Source, Waiting>()

  private readonly options: StdoutPaceOptions<Source>

  constructor(options: StdoutPaceOptions<Source>) {
    this.options = options
  }

  read(source: Source, chunk: Buffer): void {
    const held = this.waiting.get(source)
    if (held) {
      held.chunks.push(chunk)
      return
    }
    const before = this.options.before?.(source, chunk)
    if (!before && this.spentMs < this.options.turnMs) {
      this.take(source, chunk)
      return
    }
    const waiting: Waiting = { chunks: [chunk], ready: !before, preparing: false }
    this.waiting.set(source, waiting)
    this.options.pause(source)
    if (before) this.prepare(source, waiting, before)
    else this.arm()
  }

  /** What waited of a process's output, taken now: its end is handled after all it said. */
  flush(source: Source): void {
    const held = this.waiting.get(source)
    if (!held) return
    this.waiting.delete(source)
    for (const chunk of held.chunks) this.options.take(source, chunk)
    this.options.resume(source)
  }

  /** `before` for a process's first waiting chunk; once done the chunk is ready, and the turn's time decides when it's taken. */
  private prepare(source: Source, waiting: Waiting, before: Promise<void>): void {
    waiting.preparing = true
    const done = () => {
      waiting.preparing = false
      if (this.waiting.get(source) !== waiting) return
      waiting.ready = true
      this.pump()
    }
    void before.then(done, done)
  }

  private take(source: Source, chunk: Buffer): void {
    const at = performance.now()
    try {
      this.options.take(source, chunk)
    } finally {
      this.spentMs += performance.now() - at
      this.arm()
    }
  }

  /** The turn's time starts again once the loop has turned: an immediate runs after everything the turn had ready. */
  private arm(): void {
    if (this.armed) return
    this.armed = true
    setImmediate(() => {
      this.armed = false
      this.spentMs = 0
      this.pump()
    })
  }

  /** Takes a ready chunk of each waiting process in turn while the turn has time, and asks `before` for what isn't ready. */
  private pump(): void {
    for (let took = true; took;) {
      took = false
      for (const [source, waiting] of this.waiting) {
        if (!waiting.ready) {
          if (waiting.preparing) continue
          const chunk = waiting.chunks[0]
          if (!chunk) {
            this.waiting.delete(source)
            this.options.resume(source)
            continue
          }
          const before = this.options.before?.(source, chunk)
          if (before) {
            this.prepare(source, waiting, before)
            continue
          }
          waiting.ready = true
        }
        if (this.spentMs >= this.options.turnMs) {
          this.arm()
          return
        }
        const chunk = waiting.chunks.shift()
        waiting.ready = false
        if (chunk) this.take(source, chunk)
        took = true
      }
    }
  }
}

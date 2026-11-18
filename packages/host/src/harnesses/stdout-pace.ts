interface StdoutPaceOptions<Source> {
  /** How much of one turn of the loop goes to output before the rest waits. */
  turnMs: number
  take(source: Source, chunk: Buffer): void
  pause(source: Source): void
  resume(source: Source): void
}

/**
 * One turn of the loop takes every process's output that is ready, and nothing else of the host's runs between
 * them: thirty turns that ended together were 170 ms of handling in one stretch. Past `turnMs` of a turn the rest
 * waits for the next, each process's own output in its order and its pipe paused meanwhile, so the windows'
 * requests and the timers run in between.
 */
export class StdoutPace<Source> {
  private spentMs = 0
  private armed = false
  /** Each process with output waiting, the longest-waiting first. */
  private readonly waiting = new Map<Source, Buffer[]>()

  private readonly options: StdoutPaceOptions<Source>

  constructor(options: StdoutPaceOptions<Source>) {
    this.options = options
  }

  read(source: Source, chunk: Buffer): void {
    const held = this.waiting.get(source)
    if (held) {
      held.push(chunk)
      return
    }
    if (this.spentMs < this.options.turnMs) {
      this.take(source, chunk)
      return
    }
    this.waiting.set(source, [chunk])
    this.options.pause(source)
    this.arm()
  }

  /** What waited of a process's output, taken now: its end is handled after all it said. */
  flush(source: Source): void {
    const held = this.waiting.get(source)
    if (!held) return
    this.waiting.delete(source)
    for (const chunk of held) this.options.take(source, chunk)
    this.options.resume(source)
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
      for (const [source, held] of this.waiting) {
        while (held.length && this.spentMs < this.options.turnMs) this.take(source, held.shift()!)
        if (held.length) return
        this.waiting.delete(source)
        this.options.resume(source)
      }
    })
  }
}

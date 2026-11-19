/**
 * Results that are costly to make and cheap to keep, by a string key: made once however many ask, read back at once
 * by whoever mounts later, and the least recently made let go past a count or a weight. What makes them is given, so
 * the work can be a worker's: the transcript's highlighted code and the prose parsed ahead of a turn's mounting.
 */
export class KeptResults<Value> {
  private readonly made = new Map<string, Value>()
  private readonly making = new Map<string, Promise<Value | null>>()
  private weight = 0
  private readonly make: (key: string) => Promise<Value | null>
  private readonly limits: { entries: number; weight: number }
  private readonly weigh: (key: string) => number

  constructor(
    make: (key: string) => Promise<Value | null>,
    limits: { entries: number; weight: number },
    weigh: (key: string) => number = (key) => key.length
  ) {
    this.make = make
    this.limits = limits
    this.weigh = weigh
  }

  /** What was made for `key`, if it's still kept. Reads only: safe while rendering. */
  get(key: string): Value | undefined {
    return this.made.get(key)
  }

  /** Whether `key` is kept or being made: nothing more to ask for. */
  has(key: string): boolean {
    return this.made.has(key) || this.making.has(key)
  }

  /** How many are being made now. */
  get pending(): number {
    return this.making.size
  }

  /**
   * The result for `key`: the one kept, the one already being made, or one made now. Null when it couldn't be made,
   * which isn't kept: the next to ask tries again.
   */
  want(key: string): Promise<Value | null> {
    const kept = this.made.get(key)
    if (kept !== undefined) {
      // Asked for again, it's the newest: the oldest is what goes.
      this.made.delete(key)
      this.made.set(key, kept)
      return Promise.resolve(kept)
    }
    const underway = this.making.get(key)
    if (underway) return underway
    const work = this.make(key).then(
      (value) => {
        this.making.delete(key)
        if (value !== null) this.keep(key, value)
        return value
      },
      () => {
        this.making.delete(key)
        return null
      }
    )
    this.making.set(key, work)
    return work
  }

  /** Lets `key` go, when what read it keeps its own copy from here on. */
  drop(key: string): void {
    if (this.made.delete(key)) this.weight -= this.weigh(key)
  }

  private keep(key: string, value: Value): void {
    if (this.made.has(key)) this.weight -= this.weigh(key)
    this.made.delete(key)
    this.made.set(key, value)
    this.weight += this.weigh(key)
    while (this.made.size > 1 && (this.made.size > this.limits.entries || this.weight > this.limits.weight)) {
      const oldest = this.made.keys().next().value
      if (oldest === undefined) break
      this.made.delete(oldest)
      this.weight -= this.weigh(oldest)
    }
  }
}

/**
 * The bytes a process's uploads may hold at once, shared by every store and link that uploads from it: the one limit
 * on what goes up in parallel. A pack reserves its bytes before its chunks are read and gives them back once its
 * request has ended, so the chunks read, the pack they're encoded into and the copy `fetch` sends from are what the
 * budget bounds (about three times its bytes in memory). Before it, each link sent four 16 MiB packs at once, and a
 * catch-up held some 200 MB of them per link: the sync daemon's memory guard retired it mid-upload.
 *
 * While it sheds (`shed`), no new pack starts: those in flight finish and give their bytes back, and the pushes they
 * belong to wait at their next pack, where the remote's mirror already records what went. That's how the sync daemon
 * lowers its memory before it would ever retire.
 */
export class UploadBudget {
  #held = 0
  #shedding = false
  readonly #waiting: Array<{ bytes: number; go: () => void }> = []
  readonly #resumed = new Set<() => void>()
  /** Turns waiting for shedding to end. */
  #turns: Array<() => void> = []

  /**
   * `bytes`: the most held at once. `packBytes`: the most one pack carries, a quarter of it by default, so four packs
   * go at once.
   */
  constructor(
    readonly bytes = UPLOAD_BUDGET_BYTES,
    readonly packBytes = Math.max(1, Math.floor(bytes / 4))
  ) {}

  /** Bytes reserved now, by packs in flight or being read. */
  get held(): number {
    return this.#held
  }

  get shedding(): boolean {
    return this.#shedding
  }

  /**
   * Reserves `bytes` (at most `this.bytes`) once they fit and the budget isn't shedding, first come first served; the
   * reservation gives back what it holds once, however often it's released. `turn`: a push of a turn's worth (a
   * Session at work's), which never waits behind packs for room, only while the budget sheds: counted, and over the
   * budget by at most a few of them.
   */
  async take(bytes: number, options: { turn?: boolean } = {}): Promise<UploadReservation> {
    const want = Math.min(Math.max(0, bytes), this.bytes)
    if (options.turn) {
      while (this.#shedding) await new Promise<void>((go) => this.#turns.push(go))
      this.#held += want
    } else if (this.#shedding || this.#waiting.length || this.#held + want > this.bytes) await new Promise<void>((go) => this.#waiting.push({ bytes: want, go }))
    else this.#held += want
    return new UploadReservation(want, (back) => {
      this.#held = Math.max(0, this.#held - back)
      this.#admit()
    })
  }

  /** Stops new packs while `on`; what waits goes once it's off. */
  shed(on: boolean): void {
    if (this.#shedding === on) return
    this.#shedding = on
    if (on) return
    const turns = this.#turns
    this.#turns = []
    for (const go of turns) go()
    this.#admit()
    for (const listener of this.#resumed) listener()
  }

  /** `listener` hears each time shedding ends; the return stops it. */
  onResumed(listener: () => void): () => void {
    this.#resumed.add(listener)
    return () => void this.#resumed.delete(listener)
  }

  /** Lets in the reservations waiting, in order, while they fit: each counted before its taker runs. */
  #admit(): void {
    while (!this.#shedding) {
      const next = this.#waiting[0]
      if (!next || this.#held + next.bytes > this.bytes) return
      this.#waiting.shift()
      this.#held += next.bytes
      next.go()
    }
  }
}

/** Bytes held of an `UploadBudget`: trimmed to what a pack came to, and given back when its request ends. */
export class UploadReservation {
  #bytes: number

  constructor(
    bytes: number,
    private readonly giveBack: (bytes: number) => void
  ) {
    this.#bytes = bytes
  }

  get bytes(): number {
    return this.#bytes
  }

  /** Gives back all but `bytes`: a pack that came to less than it reserved. */
  trim(bytes: number): void {
    const keep = Math.max(0, Math.min(this.#bytes, bytes))
    const back = this.#bytes - keep
    this.#bytes = keep
    if (back) this.giveBack(back)
  }

  release(): void {
    this.trim(0)
  }
}

/**
 * What a process's uploads hold at once by default: 32 MiB, four packs of 8 MiB, across every link. The packs, encoded
 * and copied for their requests, come to about 110 MB at most. Against a gateway that answers slowly, this is also
 * what sets the pace: the bytes in flight over its answer's time.
 */
export const UPLOAD_BUDGET_BYTES = 32 * 1024 * 1024

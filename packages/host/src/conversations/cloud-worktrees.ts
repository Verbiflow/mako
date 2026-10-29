/**
 * The one owner of the worktree here of a Thread that moved to the cloud. Two things write it: the follow, laying the
 * machine's checkout at each cloud turn's end (`CloudFollow`), and the way back, making it ready, keeping it, laying the
 * machine's over it, merging the person's changes in, and putting it back on a failure (`CloudReturns`). Every one of
 * those writes runs through here, one at a time per cloud Thread in the order asked, so two never overlap: no follow
 * lays a checkout between the way back's keeping the worktree and laying the machine's, and no two `git checkout`s
 * meet in one worktree.
 *
 * A follow asks the machine and downloads outside its turn here, so a way back can begin meanwhile. Each of the way
 * back's writes is counted as it's asked (`returnWrite`), and a follow holds to the count it read as it started
 * (`returnWrites`): when its turn comes and the way back wrote, or asked to, since, it writes nothing.
 */
export class CloudWorktrees {
  /** By cloud Thread, the last write asked, settled however it went. */
  readonly #tails = new Map<string, Promise<void>>()
  /** By cloud Thread, how many of the way back's writes were asked here. */
  readonly #returnWrites = new Map<string, number>()

  /** Runs `work` once every write of `cloudThread` asked before it has settled; none asked after starts until it does. */
  write<Value>(cloudThread: string, work: () => Promise<Value>): Promise<Value> {
    const before = this.#tails.get(cloudThread) ?? Promise.resolve()
    const run = before.then(work)
    const tail = run.then(() => undefined, () => undefined)
    this.#tails.set(cloudThread, tail)
    void tail.then(() => {
      if (this.#tails.get(cloudThread) === tail) this.#tails.delete(cloudThread)
    })
    return run
  }

  /** A write of the way back's: counted at once, so a follow that started before it writes nothing from now. */
  returnWrite<Value>(cloudThread: string, work: () => Promise<Value>): Promise<Value> {
    this.#returnWrites.set(cloudThread, this.returnWrites(cloudThread) + 1)
    return this.write(cloudThread, work)
  }

  /** How many of the way back's writes of `cloudThread` were asked here, which a follow reads as it starts. */
  returnWrites(cloudThread: string): number {
    return this.#returnWrites.get(cloudThread) ?? 0
  }
}

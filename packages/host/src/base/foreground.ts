import { hostLog } from "./host-log.js"

/**
 * Work a person is waiting on now, such as a harness starting. The host's routine work (its scheduled jobs, a
 * refresh of every harness's profile) waits until none is held, so a start never shares the machine's CPU with work
 * nobody waits for: on a cloud machine's two cores, a start once ran beside 5 to 7 s of version reads and Cursor's
 * model listing, and took twice as long. Every hold ends by itself at its cap, so routine work is only ever delayed.
 */
export class Foreground {
  readonly #holds = new Map<symbol, { name: string; since: number }>()
  #waiters: Array<() => void> = []
  #firstStart: (() => void) | undefined

  /** Holds the foreground for `name` until the returned function is called, or `capMs` has passed. */
  hold(name: string, capMs = 60_000): () => void {
    const key = Symbol(name)
    this.#holds.set(key, { name, since: performance.now() })
    const timer = setTimeout(() => release(true), capMs)
    timer.unref()
    const release = (capped = false) => {
      if (!this.#holds.delete(key)) return
      clearTimeout(timer)
      if (capped) hostLog("foreground", "a hold reached its cap; routine work goes on", { name, capMs })
      if (!this.#holds.size) {
        const waiters = this.#waiters
        this.#waiters = []
        for (const resume of waiters) resume()
      }
    }
    return () => release()
  }

  /**
   * A cloud machine is made for its Thread's first start, which comes once the machine is linked: held from the
   * host's start until a harness has started (`started`), or `capMs`.
   */
  awaitFirstStart(capMs: number): void {
    this.#firstStart ??= this.hold("the machine's first start", capMs)
  }

  /** A harness finished starting, or failed to: the first start, if awaited, is over. */
  started(): void {
    this.#firstStart?.()
  }

  get busy(): boolean {
    return this.#holds.size > 0
  }

  /** What holds it now, for the host's state. */
  holding(): string[] {
    return [...this.#holds.values()].map((hold) => hold.name)
  }

  /** Resolves once nothing holds it: at once when nothing does. */
  idle(): Promise<void> {
    return this.busy ? new Promise((resolve) => this.#waiters.push(resolve)) : Promise.resolve()
  }
}

import { HostStopping, HostStoppingError } from "../base/host-stopping.js"

/** Stop admission before draining callers, while their backing stores remain open. */
export class HostCallLifetime {
  private closing = false
  private readonly pending = new Set<Promise<unknown>>()

  readonly stopping: HostStopping

  constructor(stopping = new HostStopping()) { this.stopping = stopping }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new HostStoppingError())
    const work = Promise.resolve().then(async () => {
      this.stopping.signal.throwIfAborted()
      const value = await this.stopping.run(operation)
      this.stopping.signal.throwIfAborted()
      return value
    }).catch((error: Error) => {
      if (this.stopping.signal.aborted && !(error instanceof HostStoppingError)) throw this.stopping.signal.reason
      throw error
    })
    this.pending.add(work)
    void work.finally(() => this.pending.delete(work)).catch(() => {})
    return work
  }

  async close(): Promise<void> {
    this.closing = true
    await Promise.allSettled(this.pending)
  }
}

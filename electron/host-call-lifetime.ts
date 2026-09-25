/** Stop admission before draining callers, while their backing stores remain open. */
export class HostCallLifetime {
  private closing = false
  private readonly pending = new Set<Promise<unknown>>()

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Mako's host is shutting down. This request was not started."))
    const work = Promise.resolve().then(operation)
    this.pending.add(work)
    void work.finally(() => this.pending.delete(work)).catch(() => {})
    return work
  }

  async close(): Promise<void> {
    this.closing = true
    await Promise.allSettled(this.pending)
  }
}

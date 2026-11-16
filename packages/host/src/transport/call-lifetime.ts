import { HostStopping, HostStoppingError } from "../base/host-stopping.js"
import { RuntimeDisconnectedError } from "../contracts/host-connection.js"

/** A call the stopping host never started: nothing of it happened, so its caller sends it again to the next host. */
export class HostCallRefusedError extends HostStoppingError {}

/** A call this host's stop ended, heard as a disconnect: no other host's word, and nothing the gateway should keep. */
export class HostStoppedCallError extends RuntimeDisconnectedError {}

/**
 * A call the host's stop ended, as its caller hears it: a disconnect, never a refusal. One it refused before starting
 * didn't happen (`unconfirmed: false`); one it cut may have, and is asked again under its ID, which the next host
 * settles once. Heard as a plain failure, the renderer's outbox took a person's message sent during a quit's drain as
 * refused for good and handed it back (`waitsFor`).
 */
export function stoppedCallError(error: unknown): unknown {
  if (error instanceof HostCallRefusedError) return new HostStoppedCallError(false)
  if (error instanceof HostStoppingError) return new HostStoppedCallError(true)
  return error
}

/** Stop admission before draining callers, while their backing stores remain open. */
export class HostCallLifetime {
  private closing = false
  private readonly pending = new Set<Promise<unknown>>()

  readonly stopping: HostStopping

  constructor(stopping = new HostStopping()) { this.stopping = stopping }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new HostCallRefusedError())
    const work = Promise.resolve().then(async () => {
      if (this.stopping.signal.aborted) throw new HostCallRefusedError()
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

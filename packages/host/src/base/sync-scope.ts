/**
 * A value current only while a synchronous call runs. `AsyncLocalStorage`
 * carries one into the async work a call starts as well, and costs a new
 * async context on every call. A decode starts no work that reads it later,
 * and scoping the stream line it decodes under that way cost a sixth to a
 * fifth of the live engine's time per message (`perf-decoders.ts`, the host
 * rows). Nothing outlives the call, so hosts in one process never see each
 * other's (`check-host-module-state.mjs`).
 */
export class SyncScope<T> {
  #current: T | undefined

  /** Runs `call` with `value` current, then restores whatever was current around it. */
  run<R>(value: T, call: () => R): R {
    const outer = this.#current
    this.#current = value
    try {
      return call()
    } finally {
      this.#current = outer
    }
  }

  /** The value of the innermost `run` on the stack; none outside one, including in work a call started that runs later. */
  get(): T | undefined {
    return this.#current
  }
}

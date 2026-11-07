/**
 * The timers that ran out while `work` ran, by what each was set to: a wait as Mako set it, whatever the runner's clock
 * did. A hang guard says a wait ended, and this how long it was. `waits` given, they're kept there as they run out, for a
 * caller to read while `work` still runs.
 */
export async function ranOut<T>(work: () => Promise<T>, waits: number[] = []): Promise<{ result: T; waits: number[] }> {
  const real = globalThis.setTimeout
  const recording = (run: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => real((...given: unknown[]) => {
    waits.push(ms ?? 0)
    run(...given)
  }, ms, ...args)
  // SAFETY: the same function with the same arguments, recording when it fires; `__promisify__` is carried over.
  globalThis.setTimeout = Object.assign(recording, real) as typeof setTimeout
  try {
    return { result: await work(), waits }
  } finally {
    globalThis.setTimeout = real
  }
}

/** What `work` set repeating timers to: a tick as Mako set it. */
export async function ticksSet<T>(work: () => Promise<T>): Promise<{ result: T; ticks: number[] }> {
  const real = globalThis.setInterval
  const ticks: number[] = []
  const recording = (run: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    ticks.push(ms ?? 0)
    return real(run, ms, ...args)
  }
  // SAFETY: the same function with the same arguments, recording what it's set to.
  globalThis.setInterval = Object.assign(recording, real) as typeof setInterval
  try {
    return { result: await work(), ticks }
  } finally {
    globalThis.setInterval = real
  }
}

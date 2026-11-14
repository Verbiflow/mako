export interface Growth {
  /** `largeMs / smallMs`. */
  ratio: number
  smallMs: number
  largeMs: number
}

/**
 * How many times more CPU work takes at `large` than at `small`, in this process: the least of `tries` at each size,
 * taken in turns, the small one run `large / small` times a try so both measure a like stretch. CPU time, not the
 * clock's, so a runner busy with other processes doesn't count against either size. `prepare` builds a size's input
 * unmeasured and returns the work to measure. Linear work grows by about `large / small`, quadratic by its square.
 */
export function growth(prepare: (size: number) => () => void, small: number, large: number, tries = 5): Growth {
  const repeats = Math.max(1, Math.round(large / small))
  let smallMs = Infinity
  let largeMs = Infinity
  for (let round = 0; round < tries; round++) {
    for (const [size, times] of [[small, repeats], [large, 1]] as const) {
      const works = Array.from({ length: times }, () => prepare(size))
      const started = process.cpuUsage()
      for (const work of works) work()
      const { user, system } = process.cpuUsage(started)
      const ms = (user + system) / 1_000 / times
      if (size === small) smallMs = Math.min(smallMs, ms)
      else largeMs = Math.min(largeMs, ms)
    }
  }
  return { ratio: largeMs / smallMs, smallMs, largeMs }
}

/** The geometric middle of linear and quadratic growth from `small` to `large`: linear work stays well under it, quadratic well over. */
export function subquadratic(small: number, large: number): number {
  return (large / small) ** 1.5
}

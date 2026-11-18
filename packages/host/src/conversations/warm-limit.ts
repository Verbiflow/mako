import { reserveOf, type FinHardware } from "./fin-capacity.js"

/**
 * How many idle provider processes a machine keeps warm (`LiveHibernation`). A warm provider answers the next message
 * without the launch a hibernated one repeats, and costs what its processes hold in memory while nothing runs. So the
 * number is a share of the memory nobody else is counted to use, divided by what one provider holds:
 *
 *   spare = memory − the person's reserve − Fins at work × provider
 *   limit = floor(min(spare × WARM_SHARE, WARM_MOST_BYTES) / provider), at least WARM_FLOOR and at most WARM_CEILING
 *
 * and it is the floor while the machine is short of memory, and for `WARM_RELIEF_MS` after it last was. The floor is
 * what every machine kept before this rule. Everything here is pure: the host feeds it a reading and a clock.
 */

/** The fewest idle providers kept warm, on any machine and under any pressure. */
export const WARM_FLOOR = 2
/** The most, however light a provider measures: past eight, the oldest idle one is rarely the next one written to. */
export const WARM_CEILING = 8
/**
 * The most memory idle providers may hold past the floor, however large the machine: 3 GB, counted at a provider's
 * cost. Idle processes on a big machine are still memory the person sees held for nothing running.
 */
export const WARM_MOST_BYTES = 3 * 1024 ** 3
/** The share of spare memory idle providers may hold: an eighth, so a full pool is small beside what Fins and builds take. */
export const WARM_SHARE = 1 / 8
/** How long after memory pressure was last read the pool stays at its floor, so one calm reading doesn't refill it. */
export const WARM_RELIEF_MS = 5 * 60_000

/** What the rule reads of a machine (`FinCapacity.warm`). */
export interface WarmReading {
  hardware: FinHardware
  /**
   * What one provider's processes hold: a Fin's light memory as this machine measured it (`FinCostModel`, the 75th
   * percentile of a Fin's process tree outside builds), or `PRIOR_COST.memoryBytes` before it has measured any. An idle
   * provider holds less than a working one, so this counts each warm one high.
   */
  providerBytes: number
  /** Fins at work here at the last look: their memory isn't spare. */
  working: number
  /** When the machine was last read short of memory (the system's pressure level, or swap nearly gone); never, undefined. */
  pressedAt?: number
}

/** Whether a reading still says the machine is short of memory at `now`. */
export function warmPressed(reading: Pick<WarmReading, "pressedAt">, now: number): boolean {
  return reading.pressedAt !== undefined && now - reading.pressedAt < WARM_RELIEF_MS
}

/** The idle providers this machine keeps warm at `now`. */
export function warmLimit(reading: WarmReading, now: number): number {
  if (warmPressed(reading, now)) return WARM_FLOOR
  const provider = Math.max(1, reading.providerBytes)
  const spare = reading.hardware.memoryBytes - reserveOf(reading.hardware).memoryBytes - Math.max(0, reading.working) * provider
  // A whole provider's worth short by a rounding error still counts: 1.6 GB over 0.8 GB is two, not one.
  const fits = Math.floor(Math.min(spare * WARM_SHARE, WARM_MOST_BYTES) / provider + 1e-9)
  return Math.max(WARM_FLOOR, Math.min(WARM_CEILING, fits))
}

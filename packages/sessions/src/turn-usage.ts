import type { TurnUsage } from "./entries.js"

/** Two readings added field by field; a field neither has stays unset. */
export function addTurnUsage(total: TurnUsage | undefined, more: TurnUsage | undefined): TurnUsage | undefined {
  if (!more) return total
  if (!total) return { ...more }
  const sum: TurnUsage = {}
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "costUsd"] as const) {
    if (total[key] === undefined && more[key] === undefined) continue
    sum[key] = (total[key] ?? 0) + (more[key] ?? 0)
  }
  return sum
}

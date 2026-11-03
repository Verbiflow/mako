const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000

/** Counts by minute over the last hour, so a reading says how much happened lately and not only since the host started. */
export class HourCounts {
  private readonly minutes = new Map<number, number>()

  add(count = 1, at = Date.now()): void {
    const minute = Math.floor(at / MINUTE_MS)
    this.minutes.set(minute, (this.minutes.get(minute) ?? 0) + count)
    for (const key of this.minutes.keys()) if (key <= minute - 60) this.minutes.delete(key)
  }

  lastHour(at = Date.now()): number {
    const from = Math.floor((at - HOUR_MS) / MINUTE_MS)
    let total = 0
    for (const [minute, count] of this.minutes) if (minute > from) total += count
    return total
  }
}

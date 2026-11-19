/**
 * Five-field cron (`minute hour day-of-month month day-of-week`) read in an
 * IANA timezone, small enough to read in one sitting, for an automation's
 * `schedule` trigger. Nothing in the dependency tree parses cron, and what an
 * automation needs is this much:
 *
 *   * `*`, lists (`1,15`), ranges (`1-5`), steps (`*\/15`, `10-50/10`),
 *     month and weekday names (`jan`, `mon`), `7` for Sunday, and the
 *     shorthands `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`.
 *   * Day-of-month and day-of-week both restricted match either, as every cron
 *     has done since Vixie's.
 *   * A day a month doesn't have never matches: `0 0 31 * *` skips April, and
 *     `0 0 29 2 *` waits for a leap year.
 *   * Daylight saving: a wall time the clocks skip (02:30 as they spring
 *     forward) runs at the first minute after the jump, once; a wall time they
 *     repeat (01:30 as they fall back) runs once, at its first instance.
 *
 * Pure, so the editor previews the next runs with the same code the host
 * schedules by.
 */

export interface CronSpec {
  minutes: ReadonlySet<number>
  hours: ReadonlySet<number>
  days: ReadonlySet<number>
  months: ReadonlySet<number>
  weekdays: ReadonlySet<number>
  /** Whether each day field was `*`, which decides how the two combine. */
  anyDay: boolean
  anyWeekday: boolean
}

export type CronParse = { ok: true; spec: CronSpec } | { ok: false; why: string }

const SHORTHANDS = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
} as const

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const

interface Field {
  name: string
  min: number
  max: number
  names?: readonly string[]
  /** The first name's number: months count from 1, weekdays from 0. */
  base?: number
}

const FIELDS: readonly Field[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES, base: 1 },
  { name: "day of week", min: 0, max: 7, names: DAY_NAMES, base: 0 },
]

/** The schedule `expression` says, or why it says none. */
export function parseCron(expression: string): CronParse {
  const shorthand = Object.entries(SHORTHANDS).find(([name]) => name === expression.trim().toLowerCase())?.[1]
  const text = (shorthand ?? expression).trim()
  const parts = text.split(/\s+/)
  if (parts.length !== 5) return { ok: false, why: `A schedule has five fields (minute hour day month weekday); "${expression}" has ${parts.length}.` }
  const sets: Set<number>[] = []
  for (const [index, field] of FIELDS.entries()) {
    const read = readField(parts[index]!, field)
    if ("why" in read) return { ok: false, why: read.why }
    sets.push(read.values)
  }
  // SAFETY: FIELDS has five entries, and each pushed one set or returned.
  const [minutes, hours, days, months, weekdays] = sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>]
  if (weekdays.delete(7)) weekdays.add(0)
  return { ok: true, spec: { minutes, hours, days, months, weekdays, anyDay: parts[2] === "*" || parts[2] === "?", anyWeekday: parts[4] === "*" || parts[4] === "?" } }
}

function readField(text: string, field: Field): { values: Set<number> } | { why: string } {
  const values = new Set<number>()
  for (const item of text.toLowerCase().split(",")) {
    const [range, stepText] = item.split("/")
    if (range === undefined || range === "" || item.split("/").length > 2) return { why: `The ${field.name} field has an empty or doubled part: "${text}".` }
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) return { why: `The ${field.name} field's step must be a whole number above 0: "${item}".` }
    let low: number
    let high: number
    if (range === "*" || range === "?") {
      low = field.min
      high = field.name === "day of week" ? 6 : field.max
    } else {
      const ends = range.split("-")
      if (ends.length > 2) return { why: `The ${field.name} field has a range with more than two ends: "${item}".` }
      const first = valueOf(ends[0]!, field)
      const last = ends.length === 2 ? valueOf(ends[1]!, field) : first
      if (first === undefined || last === undefined) return { why: `The ${field.name} field takes ${field.min} to ${field.max}${field.names ? ` or names like ${field.names[0]}` : ""}: "${item}".` }
      if (last < first) return { why: `The ${field.name} field's range runs backwards: "${item}".` }
      low = first
      // `5/15` means from 5 to the end, stepping 15.
      high = ends.length === 1 && stepText !== undefined ? field.max : last
    }
    for (let value = low; value <= high; value += step) values.add(value)
  }
  return { values }
}

function valueOf(text: string, field: Field): number | undefined {
  const named = field.names?.indexOf(text) ?? -1
  if (named >= 0) return named + (field.base ?? 0)
  if (!/^\d{1,2}$/.test(text)) return undefined
  const value = Number(text)
  return value >= field.min && value <= field.max ? value : undefined
}

/** Whether `zone` is an IANA timezone this runtime knows. */
export function knownTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0)
    return true
  } catch {
    return false
  }
}

interface Wall {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

/** The wall clock in `zone` at `instant`, to the minute. */
export function wallAt(instant: number, zone: string): Wall {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(instant)
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((each) => each.type === type)?.value ?? 0)
  return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour") % 24, minute: part("minute") }
}

const MINUTE = 60_000

function wallKey(wall: Wall): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
}

/**
 * The instant `wall` names in `zone`: its first instance when the clocks repeat it, and the first minute after the jump
 * when they skip it.
 */
export function instantOf(wall: Wall, zone: string): number {
  const naive = wallKey(wall)
  const { offsets, candidates } = instancesOf(wall, zone)
  if (candidates[0] !== undefined) return candidates[0]
  // Skipped: the first instant whose wall clock is past it.
  let low = naive - Math.max(...offsets)
  let high = naive - Math.min(...offsets)
  if (low > high) [low, high] = [high, low]
  while (high - low > MINUTE) {
    const middle = Math.floor((low + high) / 2 / MINUTE) * MINUTE
    if (wallKey(wallAt(middle, zone)) > naive) high = middle
    else low = middle
  }
  return high
}

/** The zone's offsets near a wall time, and the instants the wall time names, in order. */
interface WallInstances {
  offsets: number[]
  candidates: number[]
}

/** Every instant `wall` names in `zone`, in order: none when the clocks skip it, two when they repeat it. */
function instancesOf(wall: Wall, zone: string): WallInstances {
  const naive = wallKey(wall)
  // The zone's offset a day either side brackets any change near this wall time.
  const offsets = [...new Set([naive - 36 * 3_600_000, naive, naive + 36 * 3_600_000].map((at) => wallKey(wallAt(at, zone)) - Math.floor(at / MINUTE) * MINUTE))]
  const candidates = offsets.map((offset) => naive - offset).filter((at) => wallKey(wallAt(at, zone)) === naive).sort((a, b) => a - b)
  return { offsets, candidates }
}

/** Whether the clocks go back during this day in `zone`, so an hour of its wall times happens twice. */
function repeatsAnHour(year: number, month: number, day: number, zone: string): boolean {
  const offsetAt = (at: number) => wallKey(wallAt(at, zone)) - Math.floor(at / MINUTE) * MINUTE
  const start = Date.UTC(year, month - 1, day)
  return offsetAt(start + 36 * 3_600_000) < offsetAt(start - 12 * 3_600_000)
}

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function dayMatches(spec: CronSpec, year: number, month: number, day: number): boolean {
  if (!spec.months.has(month)) return false
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  const byDay = spec.days.has(day)
  const byWeekday = spec.weekdays.has(weekday)
  if (spec.anyDay && spec.anyWeekday) return true
  if (spec.anyDay) return byWeekday
  if (spec.anyWeekday) return byDay
  return byDay || byWeekday
}

/** Leap years come every four years but for three in four centuries: eight years always reaches a 29 February. */
const SEARCH_DAYS = 8 * 366 + 2

/**
 * The first instant after `after` that `spec` names in `zone`, or undefined when none within eight years. A wall time the
 * clocks repeat (01:30 as they fall back) is its first instance for a schedule of particular hours, which runs once a day
 * as written; one that runs every hour or more often runs in the repeated hour too, at both instances, so the hour isn't
 * a gap in it.
 */
export function nextCron(spec: CronSpec, zone: string, after: number): number | undefined {
  const start = wallAt(after, zone)
  const hours = [...spec.hours].sort((a, b) => a - b)
  const minutes = [...spec.minutes].sort((a, b) => a - b)
  const everyHour = hours.length === 24
  let { year, month, day } = start
  for (let index = 0; index < SEARCH_DAYS; index++) {
    if (everyHour && dayMatches(spec, year, month, day) && repeatsAnHour(year, month, day, zone)) {
      // Every instance of every wall time this day, the soonest after `after`: the repeated hour's second ones included.
      let soonest: number | undefined
      for (const hour of hours)
        for (const minute of minutes)
          for (const at of instancesOf({ year, month, day, hour, minute }, zone).candidates) if (at > after && (soonest === undefined || at < soonest)) soonest = at
      if (soonest !== undefined) return soonest
    } else if (dayMatches(spec, year, month, day)) {
      for (const hour of hours) {
        for (const minute of minutes) {
          const wall = { year, month, day, hour, minute }
          if (index === 0 && wallKey(wall) < wallKey(start)) continue
          const at = instantOf(wall, zone)
          if (at > after) return at
        }
      }
    }
    day += 1
    if (day > daysIn(year, month)) {
      day = 1
      month += 1
      if (month > 12) {
        month = 1
        year += 1
      }
    }
  }
  return undefined
}

/** The last instant at or before `at` that `spec` names in `zone`, after `since`; undefined when none. */
export function lastCronAtOrBefore(spec: CronSpec, zone: string, since: number, at: number): number | undefined {
  let found: number | undefined
  let cursor = since
  // Each step finds the next; a run of many missed (a week asleep on an hourly schedule) is walked, bounded.
  for (let steps = 0; steps < 10_000; steps++) {
    const next = nextCron(spec, zone, cursor)
    if (next === undefined || next > at) return found
    found = next
    cursor = next
  }
  return found
}

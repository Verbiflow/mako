/**
 * When a usage limit says it resets, read from the words its harness refused with. Most harnesses put the time in
 * their failure's message and nowhere else: Cursor's `return on 11/8/2026 when your usage resets`, Claude's
 * `resets 1pm (America/Los_Angeles)`, Codex's `Try again at 6:26 PM.` or `Try again in 3 hours.`. The structured reading
 * (`UsageLimit.resetsAt`) goes first wherever a harness has one.
 *
 * Kept free of imports so the renderer and the host share it.
 */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const DAY_MS = 24 * 60 * 60_000
/** Past this a reading is a misread, not a limit: the longest window any harness has is a month. */
const LONGEST_MS = 45 * DAY_MS

const UNIT_MS = new Map([["d", DAY_MS], ["h", 60 * 60_000], ["m", 60_000], ["s", 1_000]])
const SPAN = /(\d+)\s*(d|h|m|s)[a-z]*/gi
const RELATIVE = /(?:try again|resets?|retry|available(?: again)?)\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i
const RETRY_AFTER = /retry[- ]after:?\s*(\d+)\s*(s|sec|secs|seconds)?\b/i
const SLASH_DATE = /(?:return|back|resets?|renews?|until)\s+(?:on\s+)?(\d{1,2})\/(\d{1,2})\/(\d{4})/i
const ISO_TIME = /(?:resets?|until|try again|available)[^.|]*?\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/i
/** Claude's CLI's older line: `Claude AI usage limit reached|1790000000`. */
const EPOCH = /limit reached\|(\d{10})\b/i
const CLOCK = /(?:resets?|try again|available(?: again)?|until)(?:\s+(?:at|on))?\s+(?:([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(?:at\s+)?)?)?(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|(\d{1,2}):(\d{2})\b)?\s*(?:\(([\w/+-]+)\))?/i

/** The epoch ms a limit's words say it resets, or undefined when they name no time that's still to come. */
export function limitReset(message: string | undefined, now: number): number | undefined {
  const text = message ?? ""
  const at = reading(text, now)
  return at !== undefined && at > now && at - now <= LONGEST_MS ? at : undefined
}

function reading(text: string, now: number): number | undefined {
  const relative = RELATIVE.exec(text)
  if (relative) return now + [...relative[1]!.matchAll(SPAN)].reduce((sum, [, count, unit]) => sum + Number(count) * UNIT_MS.get(unit!.toLowerCase())!, 0)
  const after = RETRY_AFTER.exec(text)
  if (after) return now + Number(after[1]) * 1_000
  const slash = SLASH_DATE.exec(text)
  if (slash) return wallClock({ year: Number(slash[3]), month: Number(slash[1]) - 1, day: Number(slash[2]), hour: 0, minute: 0 }, undefined)
  const iso = ISO_TIME.exec(text)
  if (iso) {
    const at = Date.parse(iso[1]!)
    if (!Number.isNaN(at)) return at
  }
  const epoch = EPOCH.exec(text)
  if (epoch) return Number(epoch[1]) * 1_000
  return clockReading(text, now)
}

/** "resets 1pm (America/Los_Angeles)", "Try again at 6:26 PM", "resets Nov 8, 1pm": a time of day, on a date if it names one, in its zone if it names one. */
function clockReading(text: string, now: number): number | undefined {
  const clock = CLOCK.exec(text)
  if (!clock) return undefined
  const [, monthWord, dayWord, hour12, minute12, meridiem, hour24, minute24] = clock
  const month = monthWord ? MONTHS.indexOf(monthWord.slice(0, 3).toLowerCase()) : -1
  const hasDate = month >= 0 && dayWord !== undefined
  const hasClock = hour12 !== undefined || hour24 !== undefined
  if (!hasDate && !hasClock) return undefined
  const hour = hour12 !== undefined ? (Number(hour12) % 12) + (meridiem!.toLowerCase() === "pm" ? 12 : 0) : Number(hour24 ?? 0)
  const minute = Number(minute12 ?? minute24 ?? 0)
  const zone = usableZone(clock[8])
  const today = dateIn(now, zone)
  if (hasDate) {
    const on = (year: number) => wallClock({ year, month, day: Number(dayWord), hour, minute }, zone)
    const at = on(today.year)
    return at > now ? at : on(today.year + 1)
  }
  const at = wallClock({ ...today, hour, minute }, zone)
  if (at > now) return at
  const next = dateIn(at + DAY_MS, zone)
  return wallClock({ ...next, hour, minute }, zone)
}

interface WallClock {
  year: number
  /** From 0, as `Date` counts them. */
  month: number
  day: number
  hour: number
  minute: number
}

function usableZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone })
    return zone
  } catch {
    return undefined
  }
}

function fields(at: number, zone: string | undefined): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", { ...(zone && { timeZone: zone }), hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(at)
  const part = (type: string) => Number(parts.find((each) => each.type === type)?.value)
  return { year: part("year"), month: part("month") - 1, day: part("day"), hour: part("hour"), minute: part("minute") }
}

function dateIn(at: number, zone: string | undefined): Pick<WallClock, "year" | "month" | "day"> {
  const { year, month, day } = fields(at, zone)
  return { year, month, day }
}

/** The instant a wall clock in `zone` (this machine's without one) reads `clock`. */
function wallClock(clock: WallClock, zone: string | undefined): number {
  const asUtc = Date.UTC(clock.year, clock.month, clock.day, clock.hour, clock.minute)
  if (!zone) return new Date(clock.year, clock.month, clock.day, clock.hour, clock.minute).getTime()
  // The zone's offset is read at the guess and once more, so a clock change between them lands on the right side.
  const offset = (at: number) => {
    const shown = fields(at, zone)
    return Date.UTC(shown.year, shown.month, shown.day, shown.hour, shown.minute) - Math.floor(at / 60_000) * 60_000
  }
  const guess = asUtc - offset(asUtc)
  return asUtc - offset(guess)
}

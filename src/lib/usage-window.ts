import type { UsageBalance, UsageResetCredits, UsageWindow } from "@/lib/types"

const HOUR = 60
const DAY = 24 * HOUR

/** "5-hour", "Daily", "Weekly", "Monthly": the name a plan page uses. */
export function usageWindowPeriod(minutes: number): string {
  if (minutes <= 0) return "Current period"
  if (minutes === DAY) return "Daily"
  if (minutes === 7 * DAY) return "Weekly"
  if (minutes >= 28 * DAY && minutes <= 31 * DAY) return "Monthly"
  if (minutes < DAY && minutes % HOUR === 0) return `${minutes / HOUR}-hour`
  if (minutes < HOUR) return `${minutes}-minute`
  if (minutes % DAY === 0) return `${minutes / DAY}-day`
  return `${Math.round(minutes / HOUR)}-hour`
}

/** "5-hour limit", "Weekly Opus limit". */
export function usageWindowName(window: UsageWindow): string {
  const period = usageWindowPeriod(window.windowMinutes)
  return window.scope ? `${period} ${window.scope} limit` : `${period} limit`
}

/** "5-hour", "Weekly", "Opus": the name where a column already says limit. */
export function usageWindowShortName(window: UsageWindow): string {
  return window.scope ?? usageWindowPeriod(window.windowMinutes)
}

export type UsageTone = "neutral" | "caution" | "negative"

export function usageTone(usedPercent: number): UsageTone {
  if (usedPercent >= 90) return "negative"
  if (usedPercent >= 75) return "caution"
  return "neutral"
}

export function usedText(usedPercent: number): string {
  if (usedPercent >= 100) return "Limit reached"
  return `${Math.max(0, Math.round(usedPercent))}% used`
}

/**
 * When a window gives its room back, in the grain that matters at that
 * distance: minutes for a five-hour window, a weekday for a week, a date for
 * a month.
 */
export function resetText(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null
  const minutes = Math.round((resetsAt - now) / 60_000)
  if (minutes <= 0) return "resets now"
  if (minutes < HOUR) return `resets in ${minutes}m`
  if (minutes < DAY) {
    const hours = Math.floor(minutes / HOUR)
    const rest = minutes % HOUR
    return rest === 0 ? `resets in ${hours}h` : `resets in ${hours}h ${rest}m`
  }
  const date = new Date(resetsAt)
  if (minutes < 6 * DAY)
    return `resets ${date.toLocaleDateString(undefined, { weekday: "short" })} ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
  return `resets ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
}

function amount(balance: UsageBalance, value: number): string {
  if (balance.unit === "credits")
    return `${Math.round(value).toLocaleString()} credits`
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 100 ? 0 : 2,
    minimumFractionDigits: value >= 100 || Number.isInteger(value) ? 0 : 2,
  })
}

/** "$3,730 of $5,000 promotional credit left", "62,494 credits left". */
export function balanceText(balance: UsageBalance): string {
  const label = balance.label.toLowerCase()
  const noun = balance.unit === "credits" && label === "credits" ? "" : ` ${label}`
  const remaining = amount(balance, balance.remaining)
  if (balance.total !== undefined && balance.total !== balance.remaining)
    return `${remaining} of ${amount(balance, balance.total)}${noun} left`
  return `${remaining}${noun} left`
}

/** "pro" and "X Premium+" alike read as a plan name. */
export function planText(plan: string): string {
  return plan.length > 0 && plan === plan.toLowerCase()
    ? plan.charAt(0).toUpperCase() + plan.slice(1)
    : plan
}

function shortDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** "2 resets available · first expires Oct 12": early resets the provider granted. */
export function resetCreditsText(credits: UsageResetCredits): string {
  const count = credits.available === 1 ? "1 reset available" : `${credits.available} resets available`
  if (credits.expiresAt === null) return count
  return `${count} · ${credits.available === 1 ? "expires" : "first expires"} ${shortDate(credits.expiresAt)}`
}

/**
 * How old a reading is, once that matters: a refresh failed and the last
 * good reading is standing in. Fresh readings say nothing.
 */
export function readingAgeText(readAt: number | undefined, now: number): string | null {
  if (readAt === undefined) return null
  const minutes = Math.floor((now - readAt) / 60_000)
  if (minutes < 5) return null
  if (minutes < HOUR) return `Read ${minutes}m ago`
  return `Read ${Math.floor(minutes / HOUR)}h ago`
}

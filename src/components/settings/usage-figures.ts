import type { UsageAmount, UsageWindow } from "@mako/host/contracts/automations-usage-updates"
import { formatTokens } from "@/lib/format"

// How Settings › Usage says its figures: the measure, amounts, shares, the chart's scale and its periods' names.

export type UsageMetric = "cost" | "tokens"

/** One stacked series: a source, or the sources too small to draw apart. */
export interface UsageSeries {
  key: string
  label: string
  /** The sources the series sums; one, unless it is the rest. */
  sources: readonly string[]
  /** The swatch class: a step of the text colour, or the dither for the rest. */
  ink: string
}

const TICKS = 4

export function valueOf(amount: UsageAmount | undefined, metric: UsageMetric): number {
  return amount ? (metric === "cost" ? amount.cost : amount.tokens) : 0
}

export function sumOf(amounts: ReadonlyArray<UsageAmount | undefined>): UsageAmount {
  const sum = { cost: 0, estimatedCost: 0, tokens: 0 }
  for (const amount of amounts) {
    if (!amount) continue
    sum.cost += amount.cost
    sum.estimatedCost += amount.estimatedCost
    sum.tokens += amount.tokens
  }
  return sum
}

/** An amount as the readout says it: a cost with an estimate in it carries "≈", tokens carry their noun. */
export function readout(amount: UsageAmount, metric: UsageMetric): string {
  if (metric === "tokens") return `${formatTokens(amount.tokens)} tokens`
  return `${amount.estimatedCost > 0 ? "≈ " : ""}${usageMoney(amount.cost)}`
}

/** Sub-cent amounts still deserve a real number rather than "$0.00". */
export function usageMoney(value: number): string {
  if (value === 0) return "$0"
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 1) return `$${value.toFixed(3)}`
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** An axis tick: as few digits as the step needs. */
export function axisMoney(value: number): string {
  if (value >= 1000) return `$${(value / 1000).toFixed(value % 1000 ? 1 : 0)}k`
  if (value >= 1) return `$${Number.isInteger(value) ? value : value.toFixed(1)}`
  return `$${value.toFixed(value >= 0.1 ? 1 : 2)}`
}

/**
 * A scale whose top is a readable 1, 2 or 5 × 10ⁿ step at or above the
 * peak, so the tallest bar is never drawn past the plot.
 */
/** A chart's vertical scale: its top and the gridlines up to it. */
export interface ChartScale {
  max: number
  ticks: number[]
}

export function niceScale(peak: number): ChartScale {
  if (peak <= 0) return { max: 0, ticks: [0] }
  const raw = peak / TICKS
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const normalized = raw / magnitude
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude
  const max = Math.ceil(peak / step) * step
  const ticks: number[] = []
  for (let tick = 0; tick <= max + step * 1e-6; tick += step) ticks.push(Number(tick.toPrecision(12)))
  return { max, ticks }
}

const HOUR = new Intl.DateTimeFormat(undefined, { hour: "numeric" })
const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" })

export function axisLabel(start: number, window: UsageWindow): string {
  return window.resolution === "hour" ? HOUR.format(start) : DAY.format(start)
}

/** A period as a reader names it: "Mon, Oct 26" or "Oct 26, 3 PM – 4 PM". */
export function periodLabel(start: number, resolution: UsageWindow["resolution"]): string {
  if (resolution === "day") return WEEKDAY.format(start)
  return `${DAY.format(start)}, ${HOUR.format(start)} – ${HOUR.format(start + 3_600_000)}`
}

/** A share as a person reads it: small ones keep a decimal, and a share that isn't zero never reads as 0%. */
export function share(count: number, total: number): string {
  if (!count || !total) return "0%"
  const part = (count / total) * 100
  if (part < 0.1) return "<0.1%"
  return part < 10 && part % 1 ? `${part.toFixed(1)}%` : `${Math.round(part)}%`
}

export function shortPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+/i, "~")
}

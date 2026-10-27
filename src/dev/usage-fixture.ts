// A month of usage for the fixture pages and the mock bridge, in the shape the
// host's summary has: every window's periods, sources, models and projects
// summed from one set of hourly amounts, so the chart, the lists and the
// totals agree as they do on a real host. Deterministic for a given `now`.
import { USAGE_WINDOWS, type UsageAmount, type UsageSummary, type UsageTotals, type UsageWindow } from "@mako/host/contracts/automations-usage-updates"

interface FixtureSource {
  source: string
  harness?: string
  /** Each model's share of the source's tokens. */
  models: Array<[model: string, share: number]>
  /** Dollars per million tokens; absent for a source no table prices. */
  price?: number
  /** The harness priced its own calls; otherwise the cost is Mako's estimate. */
  reported: boolean
  /** How busy the source is against the busiest. */
  weight: number
}

const SOURCES: FixtureSource[] = [
  { source: "Codex", harness: "codex", models: [["gpt-6.1-sol", 0.82], ["gpt-6.1-sol-mini", 0.18]], price: 0.9, reported: false, weight: 1 },
  { source: "Claude Code", harness: "claude", models: [["claude-opus-5-5", 0.7], ["claude-haiku-5-5", 0.3]], price: 1.3, reported: true, weight: 0.8 },
  { source: "Cursor", harness: "cursor", models: [["composer-2", 1]], price: 0.6, reported: true, weight: 0.35 },
  { source: "Devin", harness: "devin", models: [["swe-1.6", 1]], reported: false, weight: 0.18 },
  { source: "Grok", harness: "grok", models: [["grok-build", 1]], price: 0.4, reported: true, weight: 0.12 },
  { source: "OpenCode", harness: "opencode", models: [["anthropic/claude-haiku-4-5", 1]], price: 0.5, reported: false, weight: 0.06 },
  { source: "Mako: Commit messages", models: [["gemini-3.8-flash", 1]], price: 0.2, reported: false, weight: 0.02 },
]

const PROJECTS: Array<[cwd: string, share: number]> = [
  ["/Users/fixture/projects/billing", 0.34],
  ["/Users/fixture/projects/billing-api", 0.21],
  ["/Users/fixture/projects/web", 0.12],
  ["/Users/fixture/notes", 0.08],
  ...Array.from({ length: 12 }, (_, index): [string, number] => [`/Users/fixture/projects/spike-${index + 1}`, 0.25 / 12]),
]

const HOUR = 3_600_000

/** A small seeded generator, so every screenshot draws the same month. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

export function fixtureUsageSummary(now = Date.now()): UsageSummary {
  const top = new Date(now)
  top.setMinutes(0, 0, 0)
  const first = new Date(now)
  first.setHours(0, 0, 0, 0)
  first.setDate(first.getDate() - 29)
  const next = random(20_261_026)
  // Tokens each source spent in each hour of the month: busy in working hours, quiet at night and at weekends.
  const hours: Array<{ start: number; tokens: number[] }> = []
  for (let start = first.getTime(); start <= top.getTime(); start += HOUR) {
    const at = new Date(start)
    const working = at.getHours() >= 9 && at.getHours() < 19 ? 1 : at.getHours() >= 7 && at.getHours() < 23 ? 0.35 : 0.04
    const weekday = at.getDay() === 0 || at.getDay() === 6 ? 0.3 : 1
    const burst = next() < 0.06 ? 3 : 1
    hours.push({ start, tokens: SOURCES.map((source) => Math.round(source.weight * working * weekday * burst * next() * 900_000)) })
  }

  const windows = USAGE_WINDOWS.map((id): UsageWindow => {
    const since = id === "day" ? top.getTime() - 23 * HOUR : localDays(now, id === "week" ? 7 : 30)
    const starts = id === "day"
      ? Array.from({ length: 24 }, (_, index) => since + index * HOUR)
      : Array.from({ length: id === "week" ? 7 : 30 }, (_, index) => {
          const day = new Date(since)
          day.setDate(day.getDate() + index)
          return day.getTime()
        })
    const inWindow = hours.filter((hour) => hour.start >= since)
    const bySource = SOURCES.map((_, index) => inWindow.reduce((sum, hour) => sum + (hour.tokens[index] ?? 0), 0))
    const sources = SOURCES.map((source, index) => ({ source, totals: totalsOf(source, bySource[index] ?? 0) }))
    const total = sumTotals(sources.map(({ totals }) => totals))
    const projectRows = PROJECTS.map(([cwd, share]) => ({ cwd, ...sumTotals(sources.map(({ totals }) => scaled(totals, share))) }))
    return {
      id,
      since,
      until: now,
      resolution: id === "day" ? "hour" : "day",
      total,
      sessions: sources.reduce((sum, { totals }) => sum + Math.ceil(totals.messages / 60), 0),
      periods: starts.map((start, index) => {
        const end = starts[index + 1] ?? Infinity
        const parts = SOURCES.map((source, sourceIndex) => {
          const tokens = inWindow.filter((hour) => hour.start >= start && hour.start < end).reduce((sum, hour) => sum + (hour.tokens[sourceIndex] ?? 0), 0)
          return [source.source, amountOf(source, tokens)] as const
        }).filter(([, amount]) => amount.tokens > 0)
        return {
          start,
          total: parts.reduce((sum, [, amount]) => ({ cost: sum.cost + amount.cost, estimatedCost: sum.estimatedCost + amount.estimatedCost, tokens: sum.tokens + amount.tokens }), { cost: 0, estimatedCost: 0, tokens: 0 }),
          sources: Object.fromEntries(parts),
        }
      }),
      sources: sources
        .filter(({ totals }) => totals.messages > 0)
        .sort((left, right) => right.totals.cost - left.totals.cost)
        .map(({ source, totals }) => ({ source: source.source, ...source.harness && { harness: source.harness }, sessions: source.harness ? Math.ceil(totals.messages / 60) : 0, ...totals })),
      models: sources
        .flatMap(({ source, totals }) => source.models.map(([model, share]) => ({ model, source: source.source, ...scaled(totals, share) })))
        .filter((model) => model.messages > 0)
        .sort((left, right) => right.cost - left.cost),
      projects: projectRows.slice(0, 12),
      otherProjects: { count: projectRows.length - 12, ...sumTotals(projectRows.slice(12)) },
      priceTables: ["2026-10-06"],
    }
  })
  return { windows, truncated: false }
}

function localDays(now: number, days: number): number {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  day.setDate(day.getDate() - (days - 1))
  return day.getTime()
}

function amountOf(source: FixtureSource, tokens: number): UsageAmount {
  const cost = source.price === undefined ? 0 : (tokens / 1_000_000) * source.price
  return { cost, estimatedCost: source.reported ? 0 : cost, tokens }
}

function totalsOf(source: FixtureSource, tokens: number): UsageTotals {
  const { cost, estimatedCost } = amountOf(source, tokens)
  const priced = source.price !== undefined
  return {
    cost,
    reportedCost: cost - estimatedCost,
    estimatedCost,
    input: Math.round(tokens * 0.04),
    cacheRead: Math.round(tokens * 0.9),
    cacheWrite: Math.round(tokens * 0.03),
    output: tokens - Math.round(tokens * 0.04) - Math.round(tokens * 0.9) - Math.round(tokens * 0.03),
    messages: Math.round(tokens / 40_000),
    pricedTokens: priced ? tokens : 0,
    unpricedTokens: priced ? 0 : tokens,
  }
}

const FIELDS = ["cost", "reportedCost", "estimatedCost", "input", "output", "cacheRead", "cacheWrite", "messages", "pricedTokens", "unpricedTokens"] as const

function scaled(totals: UsageTotals, share: number): UsageTotals {
  return combine([totals], (value, key) => (key === "messages" ? Math.round(value * share) : value * share))
}

function sumTotals(rows: readonly UsageTotals[]): UsageTotals {
  return combine(rows, (value) => value)
}

/** Each field summed over `rows`, then mapped. */
function combine(rows: readonly UsageTotals[], map: (value: number, key: (typeof FIELDS)[number]) => number): UsageTotals {
  const field = (key: (typeof FIELDS)[number]) => map(rows.reduce((sum, row) => sum + (row[key] ?? 0), 0), key)
  return {
    cost: field("cost"),
    reportedCost: field("reportedCost"),
    estimatedCost: field("estimatedCost"),
    input: field("input"),
    output: field("output"),
    cacheRead: field("cacheRead"),
    cacheWrite: field("cacheWrite"),
    messages: field("messages"),
    pricedTokens: field("pricedTokens"),
    unpricedTokens: field("unpricedTokens"),
  }
}

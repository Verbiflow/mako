import { RefreshCwIcon } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"
import { usageWindow, type UsageAmount, type UsageSummary, type UsageTotals, type UsageWindow, type UsageWindowId } from "@mako/host/contracts/automations-usage-updates"
import { PRICE_TABLES } from "@mako/host/contracts/usage-ledger"
import { Eyebrow, IconAction, Segmented } from "@/components/ui/kit"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { Skeleton } from "@/components/ui/skeleton"
import { formatTokens } from "@/lib/format"
import { cn } from "@/lib/utils"
import { descriptorFor } from "@/state/descriptors"
import { setPref, usePrefs } from "@/state/prefs"
import { useThreads } from "@/state/threads"
import { loadUsage } from "@/state/usage"
import { UsageChart } from "./usage-chart"
import { periodLabel, share, shortPath, usageMoney, valueOf, type UsageMetric, type UsageSeries } from "./usage-figures"

const METRICS = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
] satisfies Array<{ value: UsageMetric; label: string }>

const WINDOWS = [
  { value: "day", label: "24 hours" },
  { value: "week", label: "7 days" },
  { value: "month", label: "30 days" },
] satisfies Array<{ value: UsageWindowId; label: string }>

const SINCE = { day: "in the last 24 hours", week: "in the last 7 days", month: "in the last 30 days" } satisfies Record<UsageWindowId, string>

/** Sources drawn apart in the chart, largest first, in steps of one ink; the rest share the dither. */
const INK = ["bg-foreground/80", "bg-foreground/58", "bg-foreground/42", "bg-foreground/30", "bg-foreground/20"]
const REST = "usage-dither"

type Breakdown = "model" | "period" | "project"

interface Read {
  summary?: UsageSummary | null
  error?: string
  reading: boolean
}

/**
 * What the harnesses on this machine spent, over the last day, week or
 * month: one number, a chart by source, every source, the token totals, and
 * a breakdown by model, period or project. Every figure is the host's, read
 * once for all three windows, so switching window or measure reads nothing.
 */
export function SpendOverview() {
  const metric = usePrefs((prefs) => prefs.usageMetric)
  const windowId = usePrefs((prefs) => prefs.usageWindow)
  const [read, setRead] = useState<Read>({ reading: true })
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    let current = true
    loadUsage().then(
      (summary) => current && setRead({ summary, reading: false }),
      (reason) => current && setRead((previous) => ({ ...previous, error: reason instanceof Error ? reason.message : String(reason), reading: false }))
    )
    return () => {
      current = false
    }
  }, [generation])

  const window = read.summary ? usageWindow(read.summary, windowId) : undefined
  return (
    <section aria-labelledby="usage-local" className="flex flex-col gap-3" data-usage-spend>
      <div className="flex flex-wrap items-center gap-2">
        <Eyebrow id="usage-local" className="mr-auto px-0">
          Spend on this machine
        </Eyebrow>
        <Segmented label="Measure" value={metric} options={METRICS} onChange={(next) => setPref("usageMetric", next)} />
        <Segmented label="Window" value={windowId} options={WINDOWS} onChange={(next) => setPref("usageWindow", next)} />
        <IconAction label="Read usage again" size="xs" disabled={read.reading} aria-busy={read.reading} onClick={() => {
            setRead((previous) => ({ summary: previous.summary, reading: true }))
            setGeneration((value) => value + 1)
          }}>
          <RefreshCwIcon className={cn("size-3.5", read.reading && read.summary && "animate-spin")} />
        </IconAction>
      </div>
      {read.error && !read.summary ? (
        <p className="rounded-lg bg-surface px-3 py-4 text-ui text-faint ring-1 ring-hairline" data-usage-error>
          {read.error}
        </p>
      ) : read.summary === null ? (
        <Empty>Usage appears here once a supported agent records a turn on this machine.</Empty>
      ) : !window || !read.summary ? (
        <SpendSkeleton />
      ) : (
        <>
          {read.error ? <p className="text-label text-faint" data-usage-error>Couldn&rsquo;t read usage again: {read.error} These are the figures read before.</p> : null}
          <WindowSpend window={window} metric={metric} truncated={read.summary.truncated} />
        </>
      )}
    </section>
  )
}

function WindowSpend({ window, metric, truncated }: { window: UsageWindow; metric: UsageMetric; truncated: boolean }) {
  const [focus, setFocus] = useState<string | null>(null)
  const descriptors = useThreads((state) => state.descriptors)
  if (!window.total.messages) return <Empty>Nothing spent {SINCE[window.id]}. Spend appears here as agents work on this machine.</Empty>

  const sources = [...window.sources].sort((left, right) => valueOf(amountOf(right), metric) - valueOf(amountOf(left), metric))
  const apart = sources.length > INK.length + 1 ? INK.length : sources.length
  const series: UsageSeries[] = sources.slice(0, apart).map((source, index) => ({ key: source.source, label: source.source, sources: [source.source], ink: INK[index] ?? REST }))
  const rest = sources.slice(apart)
  if (rest.length) series.push({ key: "rest", label: `${rest.length} more sources`, sources: rest.map((source) => source.source), ink: REST })
  const inkOf = new Map(series.flatMap((entry) => entry.sources.map((source) => [source, entry] as const)))
  const total = valueOf(amountOf(window.total), metric)
  const estimated = (window.total.estimatedCost ?? 0) > 0

  return (
    <div className="flex flex-col gap-3" data-usage-window={window.id}>
      <div className="flex flex-col gap-5 rounded-lg bg-surface px-4 pt-4 pb-3 ring-1 ring-hairline">
        <div className="flex flex-col gap-0.5">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="tabular-nums text-title font-semibold" data-usage-total>
              {metric === "cost" ? cost(window.total) : `${formatTokens(meteredTokens(window.total))} tokens`}
            </span>
            <span className="text-ui text-faint">
              {metric === "cost" ? "spent" : "processed"} {SINCE[window.id]}
            </span>
          </div>
          <span className="text-label text-faint tabular-nums">
            {plural(window.sessions, "session")} · {metric === "cost" ? `${formatTokens(meteredTokens(window.total))} tokens` : `${cost(window.total)} spent`}
            {estimated && metric === "cost" ? " · partly Mako's estimate" : ""}
          </span>
        </div>
        <UsageChart window={window} metric={metric} series={series} focus={focus} />
        <ul className="-mx-1.5 flex flex-col border-t border-hairline pt-2" onMouseLeave={() => setFocus(null)} data-usage-sources>
          {sources.map((source) => {
            const entry = inkOf.get(source.source)
            const value = valueOf(amountOf(source), metric)
            const outside = source.harness ? descriptorFor({ descriptors }, source.harness)?.usage.outsideMako : undefined
            const unpriced = metric === "cost" && !source.cost && (source.unpricedTokens ?? 0) > 0
            return (
              <li
                key={source.source}
                onMouseEnter={() => setFocus(entry?.key ?? null)}
                title={[outside?.state === "absent" ? outside.reason : undefined, unpriced ? `${formatTokens(source.unpricedTokens ?? 0)} tokens have no known price` : undefined].filter(Boolean).join(" ") || undefined}
                className="flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors duration-100 hover:bg-fill-hover"
              >
                <span aria-hidden className={cn("size-2 shrink-0 rounded-[2px]", entry?.ink)} />
                {source.harness ? <HarnessIcon harness={source.harness} className="size-3.5" /> : <span aria-hidden className="size-3.5 shrink-0" />}
                <span className="min-w-0 truncate text-ui">{source.source}</span>
                <span className="shrink-0 text-label text-faint tabular-nums">
                  {source.sessions ? plural(source.sessions, "session") : plural(source.messages, "call")}
                  {outside?.state === "absent" ? " · only what ran in Mako" : ""}
                </span>
                <span className="flex-1" />
                <span className="w-12 shrink-0 text-right text-label text-faint tabular-nums">{unpriced ? "" : share(value, total)}</span>
                <span className="w-24 shrink-0 text-right text-ui tabular-nums">
                  {unpriced ? <span className="text-label text-faint">Unpriced</span> : metric === "cost" ? cost(source) : formatTokens(value)}
                </span>
              </li>
            )
          })}
        </ul>
      </div>

      <Totals window={window} />
      <Breakdowns window={window} metric={metric} />

      <p className="text-label leading-relaxed text-faint" data-estimate-policy>
        Read only from session files on this machine and Mako&rsquo;s own records, its commit drafts included. No figure here is a bill: a harness&rsquo;s cost is what it priced its tokens at, and where it prices none, Mako estimates from API list prices
        {window.priceTables?.length ? ` read ${window.priceTables.join(", ")}` : ""}, marked ≈. Subscriptions, discounts and billing adjustments are not included. Days start at midnight on this Mac&rsquo;s clock.
        {truncated ? " Some session records could not be read, so these totals may be low; the host log names them." : ""}
        {window.incomplete?.length ? ` ${NAMES.format(window.incomplete)} recorded some of ${window.incomplete.length === 1 ? "its" : "their"} usage as incomplete, so these totals may be low.` : ""}
      </p>
    </div>
  )
}

/** Where the window's tokens went, and how its cost was priced. */
function Totals({ window }: { window: UsageWindow }) {
  const { total } = window
  const input = total.input + total.cacheRead + total.cacheWrite
  return (
    <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg bg-hairline ring-1 ring-hairline" data-usage-totals>
      <Figure label="Tokens processed" value={formatTokens(meteredTokens(total))} detail={plural(total.messages, "model call")} />
      <Figure label="Input from cache" value={formatTokens(total.cacheRead)} detail={input ? `${share(total.cacheRead, input)} of input` : undefined} />
      <Figure label="Output" value={formatTokens(total.output)} />
      <Figure label="Fresh input" value={formatTokens(total.input)} />
      <Figure label="Written to cache" value={formatTokens(total.cacheWrite)} />
      <Figure label="Without a known price" value={`${formatTokens(total.unpricedTokens ?? 0)} tokens`} />
      <Figure label="As harnesses priced it" value={usageMoney(total.reportedCost ?? 0)} />
      <Figure
        label="Mako's estimate at list prices"
        value={(total.estimatedCost ?? 0) > 0 ? `≈ ${usageMoney(total.estimatedCost ?? 0)}` : usageMoney(0)}
        title={(total.estimatedCost ?? 0) > 0 ? estimateSource(window.priceTables ?? []) : undefined}
      />
      <Figure label="Total" value={cost(total)} strong />
    </div>
  )
}

function Figure({ label, value, detail, title, strong }: { label: string; value: string; detail?: string; title?: string; strong?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 bg-surface px-3 py-2.5" title={title}>
      <span className="truncate text-label text-faint">{label}</span>
      <span className={cn("truncate text-ui tabular-nums", strong && "font-medium")}>
        {value}
        {detail ? <span className="text-label text-faint"> · {detail}</span> : null}
      </span>
    </div>
  )
}

/** The window by model, by period (newest first) or by project, sorted by the measure in use. */
function Breakdowns({ window, metric }: { window: UsageWindow; metric: UsageMetric }) {
  const [by, setBy] = useState<Breakdown>("model")
  const harnessOf = new Map(window.sources.map((source) => [source.source, source.harness]))
  const total = valueOf(amountOf(window.total), metric)
  const byMetric = <T extends UsageTotals>(rows: readonly T[]) => [...rows].sort((left, right) => valueOf(amountOf(right), metric) - valueOf(amountOf(left), metric))
  const unit = window.resolution === "hour" ? "Hour" : "Day"
  return (
    <section aria-labelledby="usage-breakdown" className="flex flex-col gap-2" data-usage-breakdown={by}>
      <div className="flex items-center gap-2">
        <Eyebrow id="usage-breakdown" className="mr-auto px-0">
          Breakdown
        </Eyebrow>
        <Segmented
          label="Break down by"
          value={by}
          options={[
            { value: "model", label: "Model" },
            { value: "period", label: unit },
            { value: "project", label: "Project" },
          ]}
          onChange={setBy}
        />
      </div>
      <table className="w-full table-fixed text-ui">
        <colgroup>
          <col />
          <col className="w-24" />
          <col className="w-16" />
          <col className="w-24" />
        </colgroup>
        <thead>
          <tr className="border-b border-hairline text-left text-label text-faint">
            <th className="py-1.5 pl-1.5 font-normal">{by === "model" ? "Model" : by === "period" ? unit : "Project"}</th>
            <th className="py-1.5 text-right font-normal">Cost</th>
            <th className="py-1.5 text-right font-normal">Share</th>
            <th className="py-1.5 pr-1.5 text-right font-normal">Tokens</th>
          </tr>
        </thead>
        <tbody>
          {by === "model"
            ? byMetric(window.models).map((model) => (
                <BreakdownRow key={`${model.source}\u0000${model.model}`} totals={model} metric={metric} total={total} title={`${model.model} through ${model.source}`}>
                  {harnessOf.get(model.source) ? <HarnessIcon harness={harnessOf.get(model.source) ?? ""} className="size-3.5" /> : <span aria-hidden className="size-3.5 shrink-0" />}
                  <span className="min-w-0 truncate">{model.model}</span>
                  <span className="shrink-0 truncate text-label text-faint">{model.source}</span>
                </BreakdownRow>
              ))
            : by === "period"
              ? window.periods.toReversed().map((period) => (
                  <BreakdownRow key={period.start} amount={period.total} metric={metric} total={total}>
                    <span className="min-w-0 truncate">{periodLabel(period.start, window.resolution)}</span>
                  </BreakdownRow>
                ))
              : [
                  ...byMetric(window.projects).map((project) => (
                    <BreakdownRow key={project.cwd} totals={project} metric={metric} total={total} title={project.cwd}>
                      <span className="min-w-0 truncate">{shortPath(project.cwd)}</span>
                    </BreakdownRow>
                  )),
                  window.otherProjects ? (
                    <BreakdownRow key="other" totals={window.otherProjects} metric={metric} total={total} faint>
                      <span className="min-w-0 truncate">{plural(window.otherProjects.count, "more project")}</span>
                    </BreakdownRow>
                  ) : null,
                ]}
        </tbody>
      </table>
    </section>
  )
}

function BreakdownRow({
  totals,
  amount = totals ? amountOf(totals) : undefined,
  metric,
  total,
  title,
  faint,
  children,
}: {
  totals?: UsageTotals
  amount?: UsageAmount
  metric: UsageMetric
  total: number
  title?: string
  faint?: boolean
  children: ReactNode
}) {
  const value = valueOf(amount, metric)
  const unpriced = totals && !totals.cost && (totals.unpricedTokens ?? 0) > 0
  const empty = !amount?.tokens && !amount?.cost
  return (
    <tr className={cn("border-b border-hairline/60 transition-colors duration-100 hover:bg-fill-hover", (faint || empty) && "text-faint")} title={title}>
      <td className="py-1.5 pl-1.5">
        <span className="flex min-w-0 items-center gap-2">{children}</span>
      </td>
      <td className={cn("py-1.5 text-right tabular-nums", metric !== "cost" && "text-muted-foreground")}>
        {empty ? "—" : unpriced ? <span className="text-label text-faint">Unpriced</span> : `${(amount?.estimatedCost ?? 0) > 0 ? "≈ " : ""}${usageMoney(amount?.cost ?? 0)}`}
      </td>
      <td className="py-1.5 text-right text-label text-faint tabular-nums">{empty || (metric === "cost" && unpriced) ? "—" : share(value, total)}</td>
      <td className={cn("py-1.5 pr-1.5 text-right tabular-nums", metric !== "tokens" && "text-muted-foreground")}>{empty ? "—" : formatTokens(amount?.tokens ?? 0)}</td>
    </tr>
  )
}

function SpendSkeleton() {
  return (
    <div aria-busy className="flex flex-col gap-3" data-usage-loading>
      <div className="flex flex-col gap-5 rounded-lg bg-surface px-4 pt-4 pb-3 ring-1 ring-hairline">
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3.5 w-56" />
        </div>
        <Skeleton className="ml-14 h-44" />
        <div className="flex flex-col gap-2 border-t border-hairline pt-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
      <Skeleton className="h-36 w-full rounded-lg" />
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-surface px-3 py-4 text-center text-ui text-faint ring-1 ring-hairline">{children}</p>
}

function amountOf(totals: UsageTotals): UsageAmount {
  return { cost: totals.cost, estimatedCost: totals.estimatedCost ?? 0, tokens: meteredTokens(totals) }
}

/** A total with any estimate in it is one, and says so. */
function cost(totals: UsageTotals): string {
  return `${(totals.estimatedCost ?? 0) > 0 ? "≈ " : ""}${usageMoney(totals.cost)}`
}

function meteredTokens(totals: UsageTotals): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${count === 1 ? noun : `${noun}s`}`
}

/** Where Mako's estimate came from: each table's day and its sources. */
function estimateSource(tables: readonly string[]): string {
  const sources = PRICE_TABLES.filter((entry) => tables.includes(entry.id)).flatMap((entry) => entry.sources)
  return `Estimated from API list prices read ${tables.join(", ") || "recently"}${sources.length ? ` (${sources.join(", ")})` : ""}, for tokens no harness priced.`
}

const NAMES = new Intl.ListFormat("en", { type: "conjunction" })

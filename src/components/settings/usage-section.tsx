import { useEffect, useState } from "react"
import { Eyebrow } from "@/components/ui/kit"
import { loadUsage } from "@/state/usage"
import { formatTokens } from "@/lib/format"
import type { UsageSummary, UsageTotals } from "@/lib/types"
import { Shimmer } from "@/components/ui/shimmer"

export function UsageSection() {
  const [data, setData] = useState<UsageSummary>()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void loadUsage()
      .then((summary) => setData(summary ?? undefined))
      .catch(() => setData(undefined))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p className="text-ui"><Shimmer text="Reading local usage…" /></p>
  if (!data || data.total.messages === 0) {
    return (
      <p className="rounded-lg bg-surface px-3 py-4 text-center text-ui text-faint ring-1 ring-hairline">
        No local usage found yet. Usage appears after a supported agent records a
        turn on this machine.
      </p>
    )
  }

  const totalTokens = meteredTokens(data.total)
  const coveredTokens = data.total.pricedTokens ?? totalTokens
  const coverage =
    totalTokens > 0 ? Math.round((coveredTokens / totalTokens) * 100) : 100
  const peak = Math.max(...data.days.map((day) => day.cost), 0)

  return (
    <div className="flex flex-col gap-1">
      <div className="rounded-lg bg-surface px-3 py-3 ring-1 ring-hairline">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="tabular text-title font-medium">
            {money(data.total.cost)} API equivalent
          </span>
          <span className="text-ui text-faint">
            across {data.sessions} {data.sessions === 1 ? "session" : "sessions"}
          </span>
        </div>
        <p className="mt-1 text-label text-faint">
          {formatTokens(totalTokens)} metered tokens · {coverage}% of tokens have
          known pricing
          {(data.total.unpricedTokens ?? 0) > 0
            ? ` · ${formatTokens(data.total.unpricedTokens ?? 0)} tokens unpriced`
            : ""}
        </p>

        <div className="mt-3 grid grid-cols-2 gap-1">
          <CostReading
            label="Reported by runtimes"
            value={data.total.reportedCost ?? data.total.cost}
          />
          <CostReading
            label="Estimated from list prices"
            value={data.total.estimatedCost ?? 0}
          />
        </div>

        <p className="mt-2 text-label text-faint">
          {formatTokens(data.total.input)} input · {formatTokens(data.total.output)}
          {" output · "}
          {formatTokens(data.total.cacheRead)} cache read ·{" "}
          {formatTokens(data.total.cacheWrite)} cache write
        </p>

        {peak > 0 ? (
          <div className="mt-3" role="img" aria-label={`API-equivalent cost by day: ${data.days.map((day) => `${day.date}: ${money(day.cost)}`).join("; ")}`}>
            <div className="mb-2 flex items-center justify-between gap-2 text-label text-faint">
              <span>Daily API equivalent</span>
              <span className="tabular">{money(peak)} peak daily cost</span>
            </div>
            <div className="flex h-20 items-end gap-[2px]">
              {data.days.map((day) => (
                <div
                  key={day.date}
                  title={`${day.date} · ${money(day.cost)} API equivalent`}
                  className="usage-dither min-w-[3px] flex-1 transition-colors duration-100 hover:bg-foreground/30"
                  style={{ height: `${Math.max(2, (day.cost / peak) * 100)}%` }}
                />
              ))}
            </div>
            <div className="mt-1 flex justify-between text-label text-faint">
              <span>{data.days[0]?.date}</span>
              <span>{data.days.at(-1)?.date}</span>
            </div>
          </div>
        ) : null}
      </div>

      <Breakdown
        title="By source"
        rows={(data.sources ?? []).map((source) => ({
          label: source.source,
          totals: source,
        }))}
        total={data.total.cost}
      />
      <Breakdown
        title="By model"
        rows={data.models.map((model) => ({
          label: model.model,
          totals: model,
        }))}
        total={data.total.cost}
      />
      <Breakdown
        title="By project"
        rows={data.projects.map((project) => ({
          label: shortPath(project.cwd),
          totals: project,
        }))}
        total={data.total.cost}
      />

      <p className="mt-3 text-ui leading-relaxed text-faint">
        Read only from session files on this machine. Reported cost comes from
        runtimes that record it; other cost is an API-equivalent estimate using
        current public model list prices. Subscriptions, discounts, and billing
        adjustments are not included.
        {data.truncated
          ? " Older files or oversized file prefixes were left unread to keep the scan bounded."
          : ""}
      </p>
    </div>
  )
}

function CostReading({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-raised px-2 py-1.5">
      <span className="block text-label text-faint">{label}</span>
      <span className="tabular text-ui">{money(value)} cost</span>
    </div>
  )
}

function Breakdown({
  title,
  rows,
  total,
}: {
  title: string
  rows: Array<{ label: string; totals: UsageTotals }>
  total: number
}) {
  if (rows.length === 0) return null
  return (
    <div className="mt-3">
      <Eyebrow className="px-0 pb-1">{title}</Eyebrow>
      <div className="flex flex-col gap-0.5">
        {rows.map((row) => {
          const width = total > 0 ? Math.round((row.totals.cost / total) * 100) : 0
          const unavailable = (row.totals.unpricedTokens ?? 0) > 0
          return (
            <div
              key={row.label}
              title={
                unavailable
                  ? `${formatTokens(row.totals.unpricedTokens ?? 0)} tokens have no known price`
                  : undefined
              }
              className="flex items-center gap-2 rounded-md px-1.5 py-1"
            >
              <span className="min-w-0 flex-1 truncate text-ui text-foreground/85">
                {row.label}
              </span>
              <span
                aria-hidden
                className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-raised"
              >
                <span
                  className="block h-full rounded-full bg-foreground/35"
                  style={{ width: `${width}%` }}
                />
              </span>
              <span className="tabular w-24 shrink-0 text-right text-label text-faint">
                {row.totals.cost > 0
                  ? `${money(row.totals.cost)} equivalent`
                  : "Price unavailable"}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function meteredTokens(totals: UsageTotals): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite
}

/** Sub-cent amounts still deserve a real number rather than "$0.00". */
function money(value: number): string {
  if (value === 0) return "$0"
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 1) return `$${value.toFixed(3)}`
  return `$${value.toFixed(2)}`
}

function shortPath(path: string): string {
  return path
    .replace(/^\/(?:Users|home)\/[^/]+/, "~")
    .replace(/^[A-Za-z]:\\Users\\[^\\]+/i, "~")
}

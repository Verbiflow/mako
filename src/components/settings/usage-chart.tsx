import { useState, type KeyboardEvent } from "react"
import type { UsageWindow } from "@mako/host/contracts/automations-usage-updates"
import { formatTokens } from "@/lib/format"
import { cn } from "@/lib/utils"
import { axisLabel, axisMoney, niceScale, periodLabel, readout, sumOf, valueOf, type UsageMetric, type UsageSeries } from "./usage-figures"

const PLOT_HEIGHT = "h-44"

/**
 * What a window spent per hour or per day, stacked by source, every bar read
 * from the host's own periods. Hovering or arrowing through the bars reads
 * one period out whole; `focus` dims every series but one.
 */
export function UsageChart({
  window,
  metric,
  series,
  focus,
}: {
  window: UsageWindow
  metric: UsageMetric
  series: readonly UsageSeries[]
  focus: string | null
}) {
  const [active, setActive] = useState<number | null>(null)
  const periods = window.periods
  const columns = periods.map((period) => ({
    period,
    parts: series.map((entry) => ({ entry, amount: sumOf(entry.sources.map((source) => period.sources[source])) })),
  }))
  const peak = Math.max(0, ...periods.map((period) => valueOf(period.total, metric)))
  const scale = niceScale(peak)
  const format = (value: number) => (metric === "cost" ? axisMoney(value) : formatTokens(value))
  const shown = active === null ? undefined : columns[active]
  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = periods.length - 1
    const next =
      event.key === "ArrowLeft" ? Math.max(0, (active ?? last + 1) - 1)
      : event.key === "ArrowRight" ? Math.min(last, (active ?? -1) + 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : event.key === "Escape" ? null
      : undefined
    if (next === undefined) return
    event.preventDefault()
    setActive(next)
  }

  return (
    <div className="flex flex-col gap-1.5" data-usage-chart={window.id}>
      <div className="flex gap-2">
        <div aria-hidden className={cn("relative w-12 shrink-0", PLOT_HEIGHT)}>
          {scale.ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 translate-y-1/2 text-label text-faint tabular-nums"
              style={{ bottom: `${scale.max ? (tick / scale.max) * 100 : 0}%` }}
            >
              {tick === 0 ? "0" : format(tick)}
            </span>
          ))}
        </div>
        <div
          role="group"
          tabIndex={0}
          aria-label={`${window.resolution === "hour" ? "Hourly" : "Daily"} ${metric === "cost" ? "cost" : "tokens"} by source. Use the arrow keys to read each ${window.resolution}.`}
          onKeyDown={step}
          onMouseLeave={() => setActive(null)}
          onBlur={() => setActive(null)}
          className={cn("relative flex-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring", PLOT_HEIGHT)}
        >
          {scale.ticks.map((tick) => (
            <span
              key={tick}
              aria-hidden
              className={cn("absolute inset-x-0 border-t", tick === 0 ? "border-hairline" : "border-dashed border-hairline/70")}
              style={{ bottom: `${scale.max ? (tick / scale.max) * 100 : 0}%` }}
            />
          ))}
          <div className={cn("absolute inset-0 flex items-stretch", periods.length > 24 ? "gap-[2px]" : "gap-1")}>
            {columns.map(({ period, parts }, index) => (
              <div
                key={period.start}
                onMouseEnter={() => setActive(index)}
                className={cn(
                  "relative flex min-w-0 flex-1 flex-col-reverse rounded-t-[2px] transition-colors duration-100",
                  active === index && "bg-fill-hover"
                )}
              >
                {parts.map(({ entry, amount }) => {
                  const value = valueOf(amount, metric)
                  return value > 0 && scale.max ? (
                    <span
                      key={entry.key}
                      className={cn(
                        "w-full shrink-0 transition-opacity duration-150 last:rounded-t-[2px]",
                        entry.ink,
                        focus && focus !== entry.key && "opacity-20"
                      )}
                      style={{ height: `max(1px, ${(value / scale.max) * 100}%)` }}
                    />
                  ) : null
                })}
              </div>
            ))}
          </div>
          {shown ? (
            <div
              role="status"
              className="overlay-panel pointer-events-none absolute top-0 z-10 w-48 rounded-lg px-2.5 py-2 text-label"
              style={readoutPlace(Number(active), periods.length)}
              data-usage-readout
            >
              <div className="mb-1 text-faint">{periodLabel(shown.period.start, window.resolution)}</div>
              {shown.parts.some(({ amount }) => valueOf(amount, metric) > 0) ? (
                <>
                  {shown.parts.map(({ entry, amount }) =>
                    valueOf(amount, metric) > 0 ? (
                      <div key={entry.key} className="flex items-center gap-1.5 tabular-nums">
                        <span aria-hidden className={cn("size-2 shrink-0 rounded-[2px]", entry.ink)} />
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.label}</span>
                        <span>{readout(amount, metric)}</span>
                      </div>
                    ) : null
                  )}
                  <div className="mt-1 flex items-center justify-between gap-2 border-t border-hairline pt-1 tabular-nums">
                    <span className="text-muted-foreground">Total</span>
                    <span className="font-medium">{readout(shown.period.total, metric)}</span>
                  </div>
                </>
              ) : (
                <div className="text-muted-foreground">Nothing spent</div>
              )}
            </div>
          ) : null}
        </div>
      </div>
      <div aria-hidden className="flex justify-between pl-14 text-label text-faint">
        {[0, Math.floor((periods.length - 1) / 2), periods.length - 1].map((index) => {
          const period = periods[index]
          return <span key={index}>{period ? axisLabel(period.start, window) : ""}</span>
        })}
      </div>
    </div>
  )
}

/** Beside the bar it reads, never over it: right of a bar in the first half, left of one in the second. */
function readoutPlace(index: number, count: number) {
  const gap = "0.5rem"
  return index < count / 2
    ? { left: `min(calc(${((index + 1) / count) * 100}% + ${gap}), calc(100% - 12rem))` }
    : { right: `min(calc(${((count - index) / count) * 100}% + ${gap}), calc(100% - 12rem))` }
}

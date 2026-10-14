import { useEffect, useState } from "react"
import type { ChangeUsage } from "@mako/host/contracts/thread-changes"
import { Eyebrow } from "@/components/ui/kit"
import { loadChangeUsage, loadUsage } from "@/state/usage"
import { formatTokens } from "@/lib/format"
import type { UsageSummary, UsageTotals } from "@/lib/types"
import { Shimmer } from "@/components/ui/shimmer"
import { AccountLimits } from "@/components/identity/account-usage"
import { accounts } from "@/state/accounts"
import { descriptorFor } from "@/state/descriptors"
import { useThreads } from "@/state/threads"
import { PRICE_TABLES } from "@mako/host/contracts/usage-ledger"

export function UsageSection() {
  return (
    <div className="flex flex-col gap-8">
      <PlanLimits />
      <section aria-labelledby="usage-local" className="flex flex-col gap-2">
        <Eyebrow id="usage-local" className="px-0">
          Spend on this machine
        </Eyebrow>
        <LocalUsage />
      </section>
      <section aria-labelledby="usage-changes" className="flex flex-col gap-2">
        <Eyebrow id="usage-changes" className="px-0">
          Changes agents made
        </Eyebrow>
        <ChangesMade />
      </section>
    </div>
  )
}

const files = (count: number) => `${count.toLocaleString()} ${count === 1 ? "file" : "files"}`

/** A share as a person reads it: small ones keep a decimal, and a share that isn't zero never reads as 0%. */
function percent(count: number, total: number): string {
  if (!count || !total) return "0%"
  const share = (count / total) * 100
  if (share < 0.1) return "<0.1%"
  return share < 10 && share % 1 ? `${share.toFixed(1)}%` : `${Math.round(share)}%`
}

/**
 * What agents changed on this machine over the journal's window: files and
 * lines, how Mako knew whose each change was, how often the person had to
 * correct a move, and the same by project.
 */
function ChangesMade() {
  const [data, setData] = useState<ChangeUsage | null>()

  useEffect(() => {
    void loadChangeUsage().then(setData, () => setData(null))
  }, [])

  if (data === undefined) return <p className="text-ui"><Shimmer text="Reading Mako's record of changes…" /></p>
  if (!data || !data.total.files) {
    return (
      <p className="rounded-lg bg-surface px-3 py-4 text-center text-ui text-faint ring-1 ring-hairline" data-changes-empty>
        {data
          ? `No agent changes in the last ${data.days} days. They appear here as agents edit files in your projects.`
          : "Mako's record of changes isn't open yet. It opens a few seconds after Mako starts."}
      </p>
    )
  }

  const { total, days, moves } = data
  const peak = Math.max(...data.projects.map((project) => project.added + project.removed), 0)
  return (
    <div className="flex flex-col gap-1">
      <div className="rounded-lg bg-surface px-3 py-3 ring-1 ring-hairline">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="tabular text-title font-medium" data-changes-total>
            {files(total.files)}
          </span>
          <span className="text-ui text-faint">
            by {total.threads} {total.threads === 1 ? "thread" : "threads"} in the last {days} days
          </span>
        </div>
        <p className="mt-1 text-label text-faint tabular">
          +{total.added.toLocaleString()} −{total.removed.toLocaleString()} lines
        </p>
        <Sureness certainty={data.certainty} />
        {moves.moves ? (
          <div className="mt-3" data-changes-moves>
            <p className="mb-1.5 text-label text-faint">
              {moves.moves} {moves.moves === 1 ? "move" : "moves"} to a worktree · {files(moves.came)} came along
            </p>
            <div className="grid grid-cols-2 gap-1">
              <CostReading
                label="Best guesses you put back"
                value={moves.guessed ? `${moves.putBack} of ${moves.guessed}` : "None to check"}
                title="Files that came because only that thread was working when they changed. Each one put back was a wrong guess."
              />
              <CostReading
                label="Left behind, then brought"
                value={moves.offered ? `${moves.brought} of ${moves.offered}` : "None left"}
                title="Files Mako couldn't place, so it left them in the project folder. Each one brought was a miss."
              />
            </div>
          </div>
        ) : null}
      </div>

      {data.projects.length ? (
        <div className="mt-3">
          <Eyebrow className="px-0 pb-1">By project</Eyebrow>
          <div className="flex flex-col gap-0.5">
            {data.projects.map((project) => (
              <div key={project.path} title={project.path} className="flex items-center gap-2 rounded-md px-1.5 py-1">
                <span className="min-w-0 flex-1 truncate text-ui text-foreground/85">{shortPath(project.path)}</span>
                <span aria-hidden className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-raised">
                  <span className="block h-full rounded-full bg-foreground/35" style={{ width: `${peak ? Math.round(((project.added + project.removed) / peak) * 100) : 0}%` }} />
                </span>
                <span className="tabular w-48 shrink-0 whitespace-nowrap text-right text-label text-faint">
                  {files(project.files)} · +{project.added.toLocaleString()} −{project.removed.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <p className="mt-3 text-ui leading-relaxed text-faint">
        Counted from Mako&rsquo;s record of changes on this machine, which it
        keeps for {days} days. Lines are summed over every edit, so a line
        changed twice counts twice. Your own edits aren&rsquo;t included.
      </p>
    </div>
  )
}

/** How Mako knew whose each agent change was, as one bar: what it saw, what a command named, its best guesses, and what it couldn't tell. */
function Sureness({ certainty }: { certainty: ChangeUsage["certainty"] }) {
  const parts = [
    { label: "Seen", count: certainty.exact, tone: "bg-foreground/60", title: "The agent's own edit, as its harness reported it" },
    { label: "Named", count: certainty.named, tone: "bg-foreground/40", title: "A command the agent ran named the file or its folder" },
    { label: "Best guess", count: certainty.window, tone: "bg-foreground/20", title: "Only one thread was working when the file changed" },
    { label: "Couldn't tell", count: certainty.ambiguous, tone: "usage-dither", title: "More than one agent was working, or Mako wasn't watching then. A move leaves these where they are and offers to bring them." },
  ]
  const total = parts.reduce((sum, part) => sum + part.count, 0)
  if (!total) return null
  const sure = certainty.exact + certainty.named
  return (
    <div className="mt-3" data-changes-sureness>
      <div className="mb-1.5 flex items-center justify-between gap-2 text-label text-faint">
        <span>How Mako knew whose they were</span>
        <span className="tabular">{percent(sure, total)} certain</span>
      </div>
      <div
        role="img"
        aria-label={parts.map((part) => `${part.label}: ${percent(part.count, total)}`).join("; ")}
        className="flex h-1.5 gap-px overflow-hidden rounded-full bg-raised"
      >
        {parts.map((part) =>
          part.count ? (
            <span key={part.label} title={`${part.label}: ${part.count.toLocaleString()} · ${part.title}`} className={`min-w-[2px] ${part.tone}`} style={{ width: `${(part.count / total) * 100}%` }} />
          ) : null,
        )}
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-label text-faint">
        {parts.map((part) => (
          <li key={part.label} title={part.title} className="flex items-center gap-1.5">
            <span aria-hidden className={`size-1.5 rounded-full ${part.tone}`} />
            {part.label} <span className="tabular">{percent(part.count, total)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** What each signed-in account has left, as its provider reports it. */
function PlanLimits() {
  useEffect(() => {
    accounts.load()
  }, [])
  return (
    <section aria-labelledby="usage-limits" className="@container flex flex-col gap-2">
      <Eyebrow id="usage-limits" className="px-0">
        Plan limits
      </Eyebrow>
      <p className="text-ui leading-relaxed text-faint">
        Read from each provider for every account Mako can see, refreshed each
        minute you look.
      </p>
      <div className="pt-2">
        <AccountLimits density="page" />
      </div>
    </section>
  )
}

function LocalUsage() {
  const [data, setData] = useState<UsageSummary>()
  const [loading, setLoading] = useState(true)
  const descriptors = useThreads((state) => state.descriptors)

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
  const estimated = (data.total.estimatedCost ?? 0) > 0

  return (
    <div className="flex flex-col gap-1">
      <div className="rounded-lg bg-surface px-3 py-3 ring-1 ring-hairline">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="tabular text-title font-medium" data-usage-total>
            {cost(data.total)}
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
            label="As harnesses priced it"
            value={money(data.total.reportedCost ?? 0)}
          />
          <CostReading
            label="Mako's estimate at API list prices"
            value={estimated ? `≈ ${money(data.total.estimatedCost ?? 0)}` : money(0)}
            title={estimated ? estimateSource(data.priceTables ?? []) : undefined}
          />
        </div>

        <p className="mt-2 text-label text-faint">
          {formatTokens(data.total.input)} input · {formatTokens(data.total.output)}
          {" output · "}
          {formatTokens(data.total.cacheRead)} cache read ·{" "}
          {formatTokens(data.total.cacheWrite)} cache write
        </p>

        {peak > 0 ? (
          <div className="mt-3" role="img" aria-label={`Cost by day: ${data.days.map((day) => `${day.date}: ${cost(day)}`).join("; ")}`}>
            <div className="mb-2 flex items-center justify-between gap-2 text-label text-faint">
              <span>Cost by day{estimated ? ", partly estimated" : ""}</span>
              <span className="tabular">{estimated ? "≈ " : ""}{money(peak)} peak day</span>
            </div>
            <div className="flex h-20 items-end gap-[2px]">
              {data.days.map((day) => (
                <div
                  key={day.date}
                  title={`${day.date} · ${cost(day)}`}
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
        rows={(data.sources ?? []).map((source) => {
          const outside = source.harness ? descriptorFor({ descriptors }, source.harness)?.usage.outsideMako : undefined
          return outside?.state === "absent"
            ? { label: `${source.source} · runs in Mako`, note: outside.reason, totals: source }
            : { label: source.source, totals: source }
        })}
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

      <p className="mt-3 text-ui leading-relaxed text-faint" data-estimate-policy>
        Read only from session files on this machine and Mako&rsquo;s own
        records, its commit drafts included. No figure here is a bill: a
        harness&rsquo;s cost is what it priced its tokens at, and where it
        prices none, Mako estimates from API list prices
        {data.priceTables?.length ? ` read ${data.priceTables.join(", ")}` : ""}, marked ≈.
        Subscriptions, discounts, and billing adjustments are not included.
        {data.truncated
          ? " Some session records could not be read, so these totals may be low."
          : ""}
        {data.incomplete?.length
          ? ` ${listNames(data.incomplete)} recorded some of ${data.incomplete.length === 1 ? "its" : "their"} usage as incomplete, so these totals may be low.`
          : ""}
      </p>
    </div>
  )
}

function CostReading({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="rounded-md bg-raised px-2 py-1.5" title={title}>
      <span className="block text-label text-faint">{label}</span>
      <span className="tabular text-ui">{value}</span>
    </div>
  )
}

/** A total with any estimate in it is one, and says so. */
function cost(totals: UsageTotals): string {
  return `${(totals.estimatedCost ?? 0) > 0 ? "≈ " : ""}${money(totals.cost)}`
}

/** Where Mako's estimate came from: each table's day and its sources. */
function estimateSource(tables: readonly string[]): string {
  const sources = PRICE_TABLES.filter((entry) => tables.includes(entry.id)).flatMap((entry) => entry.sources)
  return `Estimated from API list prices read ${tables.join(", ") || "recently"}${sources.length ? ` (${sources.join(", ")})` : ""}, for tokens no harness priced.`
}

function Breakdown({
  title,
  rows,
  total,
}: {
  title: string
  rows: Array<{ label: string; totals: UsageTotals; note?: string }>
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
                [row.note, unavailable ? `${formatTokens(row.totals.unpricedTokens ?? 0)} tokens have no known price` : undefined]
                  .filter(Boolean)
                  .join(" ") || undefined
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
                {row.totals.cost > 0 ? cost(row.totals) : "Price unavailable"}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const NAMES = new Intl.ListFormat("en", { type: "conjunction" })

function listNames(names: readonly string[]): string {
  return NAMES.format(names)
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

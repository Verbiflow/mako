import { useEffect, useState } from "react"
import type { ChangeUsage } from "@mako/host/contracts/thread-changes"
import { Eyebrow } from "@/components/ui/kit"
import { loadChangeUsage } from "@/state/usage"
import { Shimmer } from "@/components/ui/shimmer"
import { AccountLimits } from "@/components/identity/account-usage"
import { accounts } from "@/state/accounts"
import { share, shortPath } from "./usage-figures"
import { SpendOverview } from "./usage-spend"

export function UsageSection() {
  return (
    <div className="flex flex-col gap-8">
      <PlanLimits />
      <SpendOverview />
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
        <span className="tabular">{share(sure, total)} certain</span>
      </div>
      <div
        role="img"
        aria-label={parts.map((part) => `${part.label}: ${share(part.count, total)}`).join("; ")}
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
            {part.label} <span className="tabular">{share(part.count, total)}</span>
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

function CostReading({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="rounded-md bg-raised px-2 py-1.5" title={title}>
      <span className="block text-label text-faint">{label}</span>
      <span className="tabular text-ui">{value}</span>
    </div>
  )
}

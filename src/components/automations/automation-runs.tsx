import { memo, useEffect, useState } from "react"
import { ChevronRightIcon, ExternalLinkIcon, GitPullRequestIcon, KeyRoundIcon } from "lucide-react"
import type { AutomationRun } from "@mako/host/contracts/automations"
import { LiveMark } from "@/components/ui/live-mark"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { Skeleton } from "@/components/ui/skeleton"
import { causeWords, foldSkips, runAt, runLine, runStatus, runWhenWords, whenAgo, type RunEntry, type RunTone } from "@/lib/automation-words"
import { cn } from "@/lib/utils"
import { automations, openRunThread, runsKey, useAutomations } from "@/state/automations"
import { desktop } from "@/state/desktop"

/**
 * An automation's runs, newest first, from `automationRuns` and kept current by `automation-run`: each with its
 * status, what started it, its gate's key and context, its result and pull request, and its Thread to open. Skips in
 * a row fold into one line that opens to show each.
 */
export function AutomationRuns({ project, id, harness }: { project: string; id: string; harness?: string }) {
  const runs = useAutomations((state) => state.runs[runsKey(project, id)])
  useEffect(() => {
    void automations.loadRuns(project, id)
  }, [project, id])
  if (!runs) return <Skeleton className="h-24 w-full" />
  if (!runs.length)
    return <p data-runs-empty className="py-3 text-ui text-faint">No runs yet. Run now starts one; its Thread shows here.</p>
  return (
    <ol data-automation-runs={runs.length} className="-mx-2 flex flex-col">
      {foldSkips(runs).map((entry) => (
        <li key={entry.kind === "run" ? entry.run.occurrence : `skips:${entry.runs[0]!.occurrence}`}>
          {entry.kind === "run" ? <RunRow run={entry.run} harness={harness} /> : <SkipFold entry={entry} harness={harness} />}
        </li>
      ))}
    </ol>
  )
}

const TONE_TEXT = {
  working: "text-foreground",
  positive: "text-positive",
  negative: "text-negative",
  caution: "text-caution",
  attention: "text-attention",
  faint: "text-faint",
} satisfies Record<RunTone, string>

function runMark(tone: RunTone): "working" | "failed" | "needs" | "idle" | "queued" {
  return tone === "working" ? "working" : tone === "negative" ? "failed" : tone === "attention" ? "needs" : tone === "faint" ? "queued" : "idle"
}

const RunRow = memo(function RunRow({ run, harness }: { run: AutomationRun; harness?: string }) {
  const [open, setOpen] = useState(false)
  const status = runStatus(run)
  const line = runLine(run)
  const checked = run.runWhen?.verdict === "run" ? runWhenWords(run) : undefined
  const eventUrl = run.cause.kind === "event" ? run.cause.url : undefined
  const thread = run.thread
  const context = run.gate?.context !== undefined ? JSON.stringify(run.gate.context, null, 2) : undefined
  const details = Boolean(run.gate || run.thread?.branch || (line && line.length > 90) || checked || eventUrl)
  return (
    <div data-run={run.occurrence} data-run-status={run.status} className="group/run flex flex-col">
      <div className="flex min-w-0 items-start gap-2.5 px-2 py-2 transition-colors hover:bg-fill-hover">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          {thread ? (
            <LiveMark state={runMark(status.tone)} size={18} label={status.label}>
              {harness ? <HarnessIcon harness={harness} /> : null}
            </LiveMark>
          ) : (
            <span aria-hidden className={cn("size-1.5 rounded-full", status.tone === "negative" ? "bg-negative" : "bg-foreground/25")} />
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn("shrink-0 text-ui font-medium", TONE_TEXT[status.tone])}>{status.label}</span>
            <span className="min-w-0 truncate text-label text-muted-foreground" title={causeWords(run.cause)}>
              {causeWords(run.cause)}
            </span>
            {run.gate?.key ? (
              <span data-run-gate-key title="The gate's dedupe key" className="flex shrink-0 items-center gap-1 text-label text-faint">
                <KeyRoundIcon aria-hidden className="size-3" />
                <span className="max-w-32 truncate font-mono">{run.gate.key}</span>
              </span>
            ) : null}
            <span className="ml-auto shrink-0 tabular text-label text-faint" title={new Date(runAt(run)).toLocaleString()}>
              {whenAgo(runAt(run))}
            </span>
          </div>
          {line ? <p data-run-line className={cn("text-label leading-relaxed", status.tone === "negative" ? "text-negative/90" : "text-muted-foreground", !open && "line-clamp-2")}>{line}</p> : null}
          <div className="flex min-w-0 flex-wrap items-center gap-1 pt-0.5">
            {thread ? (
              <button type="button" data-run-thread={thread.conversation} onClick={() => void openRunThread(run)} className="pressable flex h-6 items-center gap-1 px-1.5 text-label text-muted-foreground hover:bg-fill-selected hover:text-foreground">
                Open Thread
                <ChevronRightIcon className="size-3" />
              </button>
            ) : null}
            {run.result?.pullRequest ? (
              <button type="button" data-run-pull={run.result.pullRequest} onClick={() => void desktop.openUrl(run.result!.pullRequest!)} className="pressable flex h-6 items-center gap-1 px-1.5 text-label text-muted-foreground hover:bg-fill-selected hover:text-foreground">
                <GitPullRequestIcon className="size-3" />
                {pullName(run.result.pullRequest)}
              </button>
            ) : null}
            {eventUrl ? (
              <button type="button" data-run-event-link onClick={() => void desktop.openUrl(eventUrl)} className="pressable flex h-6 items-center gap-1 px-1.5 text-label text-muted-foreground hover:bg-fill-selected hover:text-foreground">
                <ExternalLinkIcon className="size-3" />
                The event
              </button>
            ) : null}
            {details ? (
              <button type="button" aria-expanded={open} data-run-details onClick={() => setOpen((value) => !value)} className="pressable flex h-6 items-center gap-1 px-1.5 text-label text-faint hover:bg-fill-selected hover:text-foreground">
                {open ? "Less" : "Details"}
              </button>
            ) : null}
          </div>
          {open ? (
            <dl data-run-more className="mt-1 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-label">
              {checked ? <Fact label="Only if" value={checked.replace(/^Checked “only if”: /, `Passed${run.runWhen?.model ? ` (${run.runWhen.model})` : ""}: `)} /> : null}
              {run.gate?.key ? <Fact label="Gate key" value={run.gate.key} mono /> : null}
              {context ? (
                <div className="col-span-2 flex flex-col gap-1">
                  <dt className="text-faint">Gate context</dt>
                  <dd>
                    <pre data-run-gate-context className="max-h-48 overflow-auto bg-raised px-2.5 py-2 font-mono text-label text-muted-foreground">{context}</pre>
                  </dd>
                </div>
              ) : null}
              {thread?.branch ? <Fact label="Branch" value={thread.branch} mono /> : null}
              {thread?.place ? <Fact label="Ran on" value={thread.place} /> : null}
              <Fact label="Occurrence" value={run.occurrence} mono />
            </dl>
          ) : null}
        </div>
      </div>
    </div>
  )
})

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-faint">{label}</dt>
      <dd className={cn("min-w-0 truncate text-muted-foreground", mono && "font-mono")}>{value}</dd>
    </>
  )
}

function pullName(url: string): string {
  const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url)
  return match ? `${match[1]}#${match[2]}` : "Pull request"
}

/** Skips in a row as one line: how many, the span, and why; opened, each. */
function SkipFold({ entry, harness }: { entry: Extract<RunEntry, { kind: "skips" }>; harness?: string }) {
  const [open, setOpen] = useState(false)
  const first = entry.runs[0]!
  const last = entry.runs.at(-1)!
  const status = runStatus(first)
  return (
    <div data-run-skips={entry.runs.length}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="pressable flex w-full min-w-0 items-center gap-2.5 px-2 py-1.5 text-left hover:bg-fill-hover">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          <span aria-hidden className="size-1.5 rounded-full bg-foreground/25" />
        </span>
        <span className="shrink-0 text-ui text-faint">
          {status.label} {entry.runs.length} times
        </span>
        <span className="min-w-0 flex-1 truncate text-label text-faint">{runLine(first) ?? ""}</span>
        <span className="shrink-0 tabular text-label text-faint">
          {whenAgo(runAt(last))} – {whenAgo(runAt(first))}
        </span>
        <ChevronRightIcon className={cn("size-3 shrink-0 text-faint transition-transform duration-150", open && "rotate-90")} />
      </button>
      {open ? (
        <div className="pl-5">
          {entry.runs.map((run) => (
            <RunRow key={run.occurrence} run={run} harness={harness} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

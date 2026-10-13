import { useState, type ReactNode } from "react"
import { CheckIcon, ChevronRightIcon, CopyIcon, ScanSearchIcon, WrenchIcon } from "lucide-react"
import { reviewTargetLabel, type ReviewTarget } from "@mako/host/contracts/live-reviews"
import { makoReviewReport, type ReviewFinding, type ReviewReport } from "@mako/sessions/review"
import { Prose } from "@/components/transcript/markdown"
import { Shimmer } from "@/components/ui/shimmer"
import { useCopy } from "@/components/ui/use-copy"
import { useAcp } from "@/state/acp"
import { reviewer } from "@/state/reviews"
import { viewer } from "@/state/viewer"
import { formatTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useTranscriptSource } from "./source-context"

/** Up to this many findings start open; past it, only the first. */
const OPEN_ALL_UP_TO = 3

const PRIORITY_NAMES = ["Breaks it", "Fix before merging", "Fix soon", "Minor"] as const

/** The review the person asked for, where their message would be. */
export function ReviewRequest({ target, timestamp }: { target: ReviewTarget; timestamp?: number }) {
  const { liveId } = useTranscriptSource()
  const harness = useAcp((state) => (liveId ? state.conversations[liveId]?.harness : undefined))
  return (
    <div data-review-request={target.kind} className="flex flex-col items-end">
      <div className="review-request flex max-w-[min(82%,64ch)] items-center gap-2 px-3 py-2 text-ui">
        <ScanSearchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="shrink-0 text-foreground">Review {reviewTargetLabel(target)}</span>
        {target.kind === "commit" && target.title ? <span className="min-w-0 truncate text-faint">{target.title}</span> : null}
      </div>
      <div className="mt-1 flex min-h-6 items-center justify-end gap-2 px-0.5 text-label text-faint">
        {harness ? <span>{reviewer(harness)}</span> : null}
        {timestamp ? <span className="tabular">{formatTime(timestamp)}</span> : null}
      </div>
    </div>
  )
}

/** A review's findings, most serious first, each opening its file at the line. */
export function ReviewFindings({ report }: { report: ReviewReport }) {
  const findings = report.findings.toSorted((a, b) => (a.priority ?? 4) - (b.priority ?? 4))
  const count = findings.length
  const { copied, copy } = useCopy(reviewMarkdown(report))
  return (
    <section data-review-card aria-label="Code review" className="review-card text-ui">
      <header className="flex h-8 items-center gap-2 px-3 text-label">
        <ScanSearchIcon className="size-3.5 shrink-0 text-faint" aria-hidden />
        <span className="shrink-0 font-medium text-muted-foreground">Code review</span>
        <span className={cn("min-w-0 truncate", count ? "text-faint" : "text-positive")}>
          {count ? `${count} ${count === 1 ? "finding" : "findings"}` : "No issues found"}
        </span>
        <button
          type="button"
          aria-label="Copy the review"
          title="Copy the review"
          onClick={() => void copy()}
          className="pressable ml-auto flex size-6 items-center justify-center text-faint hover:bg-fill-hover hover:text-foreground"
        >
          {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
        </button>
      </header>
      {report.summary ? (
        <div className="review-summary px-3 py-2">
          <Prose text={report.summary} className="review-prose" />
        </div>
      ) : null}
      {count ? (
        <ol className="review-findings">
          {findings.map((finding, index) => (
            <Finding key={`${index}:${finding.title}`} finding={finding} open={count <= OPEN_ALL_UP_TO || index === 0} />
          ))}
        </ol>
      ) : report.summary ? null : (
        <p className="review-summary px-3 py-2 text-muted-foreground">The review found nothing to fix.</p>
      )}
      {count ? <FixThem findings={findings} /> : null}
    </section>
  )
}

function Finding({ finding, open: startsOpen }: { finding: ReviewFinding; open: boolean }) {
  const [open, setOpen] = useState(startsOpen)
  return (
    <li data-finding data-priority={finding.priority} className="review-finding flex gap-2.5 px-3 py-2">
      <Priority finding={finding} />
      <div className="min-w-0 flex-1">
        {finding.body ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="group/finding flex w-full items-start gap-1.5 text-left"
          >
            <span className="min-w-0 flex-1 font-medium text-foreground text-pretty">{finding.title}</span>
            <ChevronRightIcon className={cn("review-chevron mt-[0.3em] size-3 shrink-0 text-faint group-hover/finding:text-foreground", open && "rotate-90")} aria-hidden />
          </button>
        ) : (
          <p className="font-medium text-foreground text-pretty">{finding.title}</p>
        )}
        <Location finding={finding} />
        {finding.body ? (
          <div className="review-body" data-open={open || undefined} inert={!open}>
            <div className="min-h-0 overflow-hidden">
              <Prose text={finding.body} className="review-prose pt-1" />
            </div>
          </div>
        ) : null}
      </div>
    </li>
  )
}

function Priority({ finding }: { finding: ReviewFinding }) {
  if (finding.priority === undefined)
    return <span className="review-priority" data-priority="none" aria-hidden>{finding.category ? finding.category.slice(0, 3) : "·"}</span>
  return (
    <span className="review-priority" data-priority={finding.priority} title={PRIORITY_NAMES[finding.priority]}>
      P{finding.priority}
    </span>
  )
}

function Location({ finding }: { finding: ReviewFinding }) {
  const source = useTranscriptSource()
  const cwd = useAcp((state) => (source.liveId ? state.conversations[source.liveId]?.cwd : undefined))
  if (!finding.path) return null
  const path = finding.path
  const shown = cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
  const lines = finding.line === undefined ? "" : finding.endLine && finding.endLine !== finding.line ? `:${finding.line}–${finding.endLine}` : `:${finding.line}`
  return (
    <button
      type="button"
      title={`Open ${path}${lines}`}
      onClick={() => void viewer.open(path, finding.line, source.threadPath, source.liveId)}
      className="pressable mt-0.5 block max-w-full truncate text-left font-mono text-label text-muted-foreground underline decoration-hairline underline-offset-2 hover:text-foreground hover:decoration-foreground"
    >
      {shown}
      {lines}
    </button>
  )
}

/** Puts a message asking for the fixes in the composer; nothing goes until the person sends it. */
function FixThem({ findings }: { findings: readonly ReviewFinding[] }) {
  const { liveId } = useTranscriptSource()
  if (!liveId) return null
  const ask = () =>
    window.dispatchEvent(new CustomEvent("mako:attach", {
      detail: { files: [], text: () => fixPrompt(findings) },
    }))
  return (
    <footer className="review-foot flex h-8 items-center px-1.5">
      <button
        type="button"
        onClick={ask}
        className="pressable flex h-6 items-center gap-1.5 px-1.5 text-label text-muted-foreground hover:bg-fill-hover hover:text-foreground"
      >
        <WrenchIcon className="size-3" aria-hidden />
        {findings.length === 1 ? "Ask to fix it" : "Ask to fix these"}
      </button>
    </footer>
  )
}

/** A reply's `mako-review` block: the card once it parses, the source when it doesn't. */
export function ReviewFence({ source, streaming, fallback }: { source: string; streaming: boolean; fallback: ReactNode }) {
  if (streaming)
    return (
      <div data-review-card="writing" className="review-card">
        <div className="flex h-8 items-center gap-2 px-3 text-label">
          <ScanSearchIcon className="size-3.5 shrink-0 text-faint" aria-hidden />
          <Shimmer text="Writing up the findings…" />
        </div>
      </div>
    )
  const report = makoReviewReport(source)
  return report ? <ReviewFindings report={report} /> : fallback
}

/** The findings as one compact line each, where a tool's details show. */
export function ReviewList({ report }: { report: ReviewReport }) {
  if (!report.findings.length) return <p className="text-label text-faint">No issues found.</p>
  return (
    <ul className="space-y-0.5">
      {report.findings.map((finding, index) => (
        <li key={`${index}:${finding.title}`} className="flex min-w-0 items-center gap-2 text-label">
          <Priority finding={finding} />
          <span className="min-w-0 truncate text-muted-foreground">{finding.title}</span>
        </li>
      ))}
    </ul>
  )
}

function where(finding: ReviewFinding): string {
  if (!finding.path) return ""
  return finding.line === undefined ? finding.path : `${finding.path}:${finding.line}`
}

function fixPrompt(findings: readonly ReviewFinding[]): string {
  const lines = findings.map((finding, index) => {
    const at = where(finding)
    return `${index + 1}. ${finding.priority === undefined ? "" : `[P${finding.priority}] `}${finding.title}${at ? ` (${at})` : ""}`
  })
  return `Fix what the review found, most serious first. For any you disagree with, say why instead of changing it.\n\n${lines.join("\n")}`
}

function reviewMarkdown(report: ReviewReport): string {
  const findings = report.findings.map((finding) => {
    const at = where(finding)
    const head = `- ${finding.priority === undefined ? "" : `**P${finding.priority}** `}${finding.title}${at ? ` — \`${at}\`` : ""}`
    return finding.body ? `${head}\n  ${finding.body.replaceAll("\n", "\n  ")}` : head
  })
  return [report.summary, findings.join("\n") || "No issues found."].filter(Boolean).join("\n\n")
}

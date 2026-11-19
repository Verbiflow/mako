import { memo, useMemo, useState } from "react"
import { automationDiff, type AutomationProposal } from "@mako/host/contracts/automations"
import { harnessLabel } from "@/components/rail/harness-meta"
import { DIFF_FIELD_WORDS, readableDiff, type DiffLine, type DiffMark, type ReadableDiff } from "@/lib/automation-diff"
import { cn } from "@/lib/utils"

/**
 * What a proposal changes, part by part, in the order `AUTOMATION_DIFF_FIELDS` names them: the prompt line by line,
 * each trigger as its sentence, and the facts of its start, limits, gate, thread and result before and after. A create
 * reads as everything added, a delete as everything removed.
 */
export const AutomationDiff = memo(function AutomationDiff({ proposal, only, className }: { proposal: Pick<AutomationProposal, "before" | "after" | "change">; /** Just these parts, when the rest is a press away. */ only?: readonly string[]; className?: string }) {
  const all = useMemo(() => readableDiff(automationDiff(proposal.before, proposal.after), harnessLabel), [proposal.before, proposal.after])
  const parts = only ? all.filter((part) => only.includes(part.field)) : all
  // Turning it on approves what its file says now: against what the person approved before, or all of it if never.
  if (proposal.change === "enable" && !parts.length)
    return <p className={cn("text-label text-muted-foreground", className)}>Nothing changed since you approved it; it starts running on its own, as its triggers say.</p>
  if (!parts.length) return <p className={cn("text-label text-muted-foreground", className)}>Nothing changes.</p>
  const lead = proposal.change === "enable" ? (proposal.before === undefined ? "Turning it on approves all it says:" : "Turning it on approves what changed since you approved it:") : undefined
  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      {lead ? <p data-diff-lead className="text-label text-muted-foreground">{lead}</p> : null}
    <dl data-automation-diff className="flex flex-col gap-2.5">
      {parts.map((part) => (
        <div key={part.field} data-diff-field={part.field} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3">
          <dt className="pt-px text-label text-faint">{DIFF_FIELD_WORDS[part.field]}</dt>
          <dd className="min-w-0">
            <DiffPart part={part} />
          </dd>
        </div>
      ))}
    </dl>
    </div>
  )
})

const MARK_STYLE = {
  same: "text-muted-foreground",
  add: "bg-positive/10 text-foreground",
  remove: "bg-negative/10 text-muted-foreground line-through decoration-negative/50",
} satisfies Record<DiffMark, string>

const MARK_SIGN = { same: " ", add: "+", remove: "−" } satisfies Record<DiffMark, string>

function Sign({ mark }: { mark: DiffMark }) {
  return (
    <span aria-hidden className={cn("w-3 shrink-0 select-none text-center", mark === "add" ? "text-positive" : mark === "remove" ? "text-negative" : "text-faint")}>
      {MARK_SIGN[mark]}
    </span>
  )
}

function DiffPart({ part }: { part: ReadableDiff }) {
  switch (part.field) {
    case "name":
      return <Change before={part.before} after={part.after} />
    case "prompt":
      return <PromptLines lines={part.lines} />
    case "triggers":
      return (
        <ul className="flex flex-col gap-px text-label">
          {part.items.map((item, index) => (
            <li key={`${item.mark}:${index}`} data-diff-trigger={item.mark} className={cn("flex min-w-0 gap-1.5 px-1 py-0.5", MARK_STYLE[item.mark])}>
              <Sign mark={item.mark} />
              <span className="min-w-0 flex-1">
                {item.text}
                {item.waits && item.mark !== "remove" ? <span className="block text-faint no-underline">{item.waits}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )
    default:
      return (
        <ul className="flex flex-col gap-0.5 text-label">
          {part.facts.map((fact) => (
            <li key={fact.label} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
              <span className="text-faint">{fact.label}</span>
              <Change before={fact.before} after={fact.after} />
            </li>
          ))}
        </ul>
      )
  }
}

/** Unchanged stretches of more than two lines fold to a line that opens them, so what changes stands together. */
function PromptLines({ lines }: { lines: readonly DiffLine[] }) {
  const [open, setOpen] = useState(false)
  const changed = lines.some((line) => line.mark !== "same")
  const shown: Array<DiffLine | { fold: number; at: number }> = []
  for (let index = 0; index < lines.length; ) {
    let end = index
    while (end < lines.length && lines[end]!.mark === "same") end++
    const run = end - index
    if (!open && changed && run > 2) {
      shown.push({ fold: run, at: index })
      index = end
    } else {
      shown.push(lines[index]!)
      index++
    }
  }
  return (
    <div className="flex flex-col text-label leading-relaxed">
      {shown.map((line, index) =>
        "fold" in line ? (
          <button key={`fold:${line.at}`} type="button" data-diff-fold={line.fold} onClick={() => setOpen(true)} className="pressable flex w-fit gap-1.5 px-1 text-faint hover:text-foreground">
            <span aria-hidden className="w-3 text-center">⋯</span>
            {line.fold} unchanged lines
          </button>
        ) : (
          <div key={index} data-diff-line={line.mark} className={cn("flex min-w-0 gap-1.5 px-1", MARK_STYLE[line.mark])}>
            <Sign mark={line.mark} />
            <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{line.text || " "}</span>
          </div>
        )
      )}
    </div>
  )
}

/** One value before and after: the old struck in the removed hue, an arrow, the new in the added one. */
function Change({ before, after }: { before?: string; after?: string }) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-label">
      {before !== undefined ? <span data-diff-before className="bg-negative/10 px-1 text-muted-foreground line-through decoration-negative/50">{before}</span> : null}
      {before !== undefined && after !== undefined ? <span aria-label="becomes" className="text-faint">→</span> : null}
      {after !== undefined ? <span data-diff-after className="bg-positive/10 px-1 text-foreground">{after}</span> : null}
    </span>
  )
}

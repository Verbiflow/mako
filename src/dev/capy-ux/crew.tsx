import { CornerUpLeftIcon, GitPullRequestIcon, SquareIcon } from "lucide-react"
import { rollupLine, type ChildGroup, type Rollup } from "@mako/host/contracts/children"
import { harnessLabel } from "@/components/rail/harness-meta"
import { ApexMark } from "@/components/ui/apex-mark"
import { Shimmer } from "@/components/ui/shimmer"
import { cn } from "@/lib/utils"
import type { Fin } from "./data"
import { CrewBar, LiveMark, Took } from "./marks"

const HEADINGS: Record<ChildGroup, string> = {
  needs: "Needs you",
  working: "Working",
  queued: "Queued",
  failed: "Failed",
  done: "Done",
}

function Who({ fin }: { fin: Fin }) {
  return (
    <span className="shrink-0 text-label text-faint">
      {harnessLabel(fin.agent.provider)}
      {fin.agent.model ? <span className="text-faint/80"> · {fin.agent.model}</span> : null}
    </span>
  )
}

function Asking({ fin, apex, onAnswer, onOpen, compact }: { fin: Fin; apex: string; onAnswer: (fin: Fin, option: number) => void; onOpen: (fin: Fin) => void; compact?: boolean }) {
  if (fin.state.kind !== "blocked") return null
  const ask = fin.state.ask
  const options = ask?.options ?? []
  const recommended = ask && "recommended" in ask ? ask.recommended : undefined
  const order = options.map((_, index) => index).sort((left, right) => (left === recommended ? -1 : right === recommended ? 1 : 0))
  return (
    <div className="rounded-lg bg-[color-mix(in_oklab,var(--caution)_7%,transparent)] px-3 py-2.5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--caution)_22%,transparent)]">
      <div className="flex items-center gap-2">
        <LiveMark harness={fin.agent.provider} state={fin.mark} cut="var(--surface)" />
        <button type="button" onClick={() => onOpen(fin)} className="pressable min-w-0 truncate text-ui font-medium text-foreground hover:underline">
          {fin.agent.title}
        </button>
        {!compact ? <Who fin={fin} /> : null}
        <span className="flex-1" />
        <Took agent={fin.agent} className="text-label text-faint" />
      </div>
      <p className="mt-1.5 pl-7 text-ui text-foreground/90">{fin.state.question}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-7">
        {order.map((index) => {
          const option = options[index]!
          const primary = index === order[0]
          return (
            <button
              key={option.label}
              type="button"
              title={"detail" in option ? option.detail : undefined}
              onClick={() => onAnswer(fin, index)}
              className={cn(
                "pressable flex h-7 items-center gap-1.5 rounded-md px-2.5 text-label font-medium",
                primary ? "bg-foreground text-background hover:bg-foreground/90" : "text-foreground/85 shadow-[inset_0_0_0_1px_var(--border)] hover:bg-fill-hover"
              )}
            >
              {option.label}
              {index === recommended ? <span className={cn("font-normal", primary ? "text-background/70" : "text-faint")}>Recommended</span> : null}
            </button>
          )
        })}
        {!compact ? (
          <span className="ml-auto text-label text-faint">
            {ask?.kind === "approval" ? `${fin.agent.title} waits on this command` : `Answer here or tell ${apex}`}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function Line({ fin, onOpen, compact }: { fin: Fin; onOpen: (fin: Fin) => void; compact?: boolean }) {
  const live = fin.state.kind === "working" || fin.state.kind === "starting"
  const lead = fin.state.kind === "blocked" && fin.state.on === "lead"
  const pr = fin.state.kind === "ended" && /PR/.test(fin.state.reason ?? "")
  return (
    <button
      type="button"
      onClick={() => onOpen(fin)}
      className={cn("pressable group flex w-full items-center gap-2 rounded-md px-1.5 text-left hover:bg-fill-hover", compact ? "min-h-11 py-1.5" : "h-8")}
    >
      <LiveMark harness={fin.agent.provider} state={fin.mark} cut="var(--surface)" />
      <span className={cn("flex min-w-0 flex-1", compact ? "flex-col" : "items-center gap-2")}>
        <span className={cn("shrink-0 truncate text-ui", fin.group === "done" ? "text-foreground/70" : "text-foreground", compact ? "" : "max-w-[42%]")}>{fin.agent.title}</span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-label text-faint">
          {lead ? <CornerUpLeftIcon className="size-3 shrink-0" aria-hidden /> : null}
          {pr ? <GitPullRequestIcon className="size-3 shrink-0" aria-hidden /> : null}
          {live && fin.line ? (
            <Shimmer text={fin.line} className="min-w-0 truncate" />
          ) : (
            <span className="min-w-0 truncate">{lead ? `Asking its Apex: ${fin.line}` : fin.line}</span>
          )}
        </span>
      </span>
      <Took agent={fin.agent} className="min-w-8 text-right text-label text-faint" />
    </button>
  )
}

/**
 * The Apex's Fins at the end of its transcript, every one of them: what needs you first, with its answers in reach,
 * then what works and on what, what waits its turn, and what's done. Nothing folds into "and N more".
 */
export function CrewCard({ fins, counts, apex, onAnswer, onOpen, compact }: { fins: Fin[]; counts: Rollup; apex: string; onAnswer: (fin: Fin, option: number) => void; onOpen: (fin: Fin) => void; compact?: boolean }) {
  const groups = (["needs", "working", "queued", "failed", "done"] as ChildGroup[]).filter((group) => fins.some((fin) => fin.group === group))
  return (
    <section data-crew aria-label={`${apex}'s Fins`} className="rounded-xl bg-surface shadow-[inset_0_0_0_1px_var(--hairline)]">
      <header className={cn("flex items-center gap-3 border-b border-hairline", compact ? "px-3 py-2.5" : "px-4 py-3")}>
        <ApexMark className="size-4 text-muted-foreground" />
        <span className="shrink-0 whitespace-nowrap text-ui font-medium text-foreground">{counts.total} Fins</span>
        <span className="min-w-0 truncate text-label text-muted-foreground">{rollupLine(counts)}</span>
        <CrewBar counts={counts} className={cn("ml-auto shrink-0", compact ? "w-16" : "w-24")} />
        {!compact ? (
          <button type="button" className="pressable flex h-7 items-center gap-1.5 rounded-md px-2 text-label text-faint hover:bg-fill-hover hover:text-foreground">
            <SquareIcon className="size-2.5 fill-current" aria-hidden />
            Stop all
          </button>
        ) : null}
      </header>
      <div className={cn("flex flex-col gap-3", compact ? "p-2" : "p-3")}>
        {groups.map((group) => {
          const members = fins.filter((fin) => fin.group === group)
          return (
            <div key={group} className="flex flex-col gap-1">
              <h4 className="flex items-center gap-1.5 px-1.5 text-label text-faint">
                <span className={group === "needs" ? "font-medium text-caution" : "font-medium text-muted-foreground"}>{HEADINGS[group]}</span>
                <span className="tabular">{members.length}</span>
              </h4>
              {group === "needs" ? (
                <div className="flex flex-col gap-1.5">
                  {members.map((fin) => <Asking key={fin.agent.nativeId} fin={fin} apex={apex} onAnswer={onAnswer} onOpen={onOpen} compact={compact} />)}
                </div>
              ) : (
                members.map((fin) => <Line key={fin.agent.nativeId} fin={fin} onOpen={onOpen} compact={compact} />)
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

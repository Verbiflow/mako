import type { ReactNode } from "react"
import { ArrowUpIcon, ChevronLeftIcon, GitPullRequestIcon, InboxIcon, SearchIcon, TimerIcon } from "lucide-react"
import { rollupLine, type Rollup } from "@mako/host/contracts/children"
import { harnessLabel } from "@/components/rail/harness-meta"
import { ApexMark } from "@/components/ui/apex-mark"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { cn } from "@/lib/utils"
import { APEX_ID, AUTOMATIONS, PULL_REQUESTS, THREADS, type Fin, type MarkState } from "./data"
import { CrewCard } from "./crew"
import { useEnd } from "./use-end"
import { LiveMark, Pips } from "./marks"

function Big({ harness, state }: { harness: string; state: MarkState }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center">
      <LiveMark harness={harness} state={state} cut="var(--shell)" className="scale-[1.4]" />
    </span>
  )
}

function PhoneRow({ harness, state, title, line, end, below, onClick, nested }: { harness: string; state: MarkState; title: string; line?: ReactNode; end?: ReactNode; below?: ReactNode; onClick?: () => void; nested?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={cn("pressable flex w-full items-center gap-3 py-2.5 pr-4 text-left active:bg-fill-hover", nested ? "pl-9" : "pl-4")}>
      <Big harness={harness} state={state} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-prose font-medium leading-5 text-foreground">{title}</span>
          {end}
        </span>
        {line ? <span className="block min-w-0 truncate text-label text-muted-foreground">{line}</span> : null}
        {below}
      </span>
    </button>
  )
}

function Age({ children }: { children: ReactNode }) {
  return <span className="tabular shrink-0 text-label text-faint">{children}</span>
}

export function PhoneList({ fins, counts, asks, onOpenApex }: { fins: Fin[]; counts: Rollup; asks: number; onOpenApex: () => void }) {
  const apex = THREADS.find((thread) => thread.id === APEX_ID)!
  const needs = fins.filter((fin) => fin.group === "needs")
  const working = THREADS.filter((thread) => ["working", "background", "starting"].includes(thread.mark))
  const recent = THREADS.filter((thread) => !["working", "background", "starting", "needs"].includes(thread.mark))
  const needsThreads = THREADS.filter((thread) => thread.mark === "needs")
  return (
    <div className="flex h-full flex-col bg-shell">
      <div className="h-[47px] shrink-0" />
      <header className="flex items-center gap-3 px-4 pb-2">
        <h1 className="flex-1 text-title font-semibold leading-9 tracking-[-0.5px] text-foreground">Threads</h1>
        <span className="flex size-8 items-center justify-center rounded-full bg-raised text-ui font-medium text-foreground">A</span>
      </header>
      <div className="mx-4 mb-3 flex h-9 items-center gap-2 bg-raised px-3 text-ui text-faint">
        <SearchIcon className="size-4" />Search Threads, Fins and pull requests
      </div>
      <div className="flex gap-2 px-4 pb-3">
        <span className="flex h-8 items-center gap-1.5 rounded-full bg-raised px-3 text-label font-medium text-foreground"><InboxIcon className="size-3.5" />Inbox<span className="tabular rounded-full bg-[color-mix(in_oklab,var(--caution)_16%,transparent)] px-1.5 text-caution">{asks}</span></span>
        <span className="flex h-8 items-center gap-1.5 rounded-full bg-raised px-3 text-label text-muted-foreground"><GitPullRequestIcon className="size-3.5" />{PULL_REQUESTS}</span>
        <span className="flex h-8 items-center gap-1.5 rounded-full bg-raised px-3 text-label text-muted-foreground"><TimerIcon className="size-3.5" />{AUTOMATIONS} on</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-8">
        <h2 className="px-4 pb-1 pt-2 text-label font-medium text-caution">Needs you</h2>
        {needsThreads.map((thread) => <PhoneRow key={thread.id} harness={thread.harness} state={thread.mark} title={thread.title} line={thread.line} end={<Age>{thread.age}</Age>} />)}
        {needs.map((fin) => (
          <PhoneRow key={fin.agent.nativeId} harness={fin.agent.provider} state={fin.mark} title={fin.agent.title} line={<><ApexMark className="mr-1 inline size-3 align-[-2px]" />{apex.title} · {fin.state.kind === "blocked" ? fin.state.question : ""}</>} end={<Age>9m</Age>} onClick={onOpenApex} />
        ))}
        <h2 className="px-4 pb-1 pt-4 text-label font-medium text-muted-foreground">Working</h2>
        {working.map((thread) =>
          thread.id === APEX_ID ? (
            <PhoneRow key={thread.id} harness={thread.harness} state={thread.mark} title={thread.title} onClick={onOpenApex} end={<Age>{thread.age}</Age>} below={<span className="mt-1 flex items-center gap-2"><Pips fins={fins} /><span className="truncate text-label text-faint">{rollupLine(counts)}</span></span>} />
          ) : (
            <PhoneRow key={thread.id} harness={thread.harness} state={thread.mark} title={thread.title} line={thread.line} end={<Age>{thread.age}</Age>} />
          )
        )}
        <h2 className="px-4 pb-1 pt-4 text-label font-medium text-muted-foreground">Recent</h2>
        {recent.map((thread) => <PhoneRow key={thread.id} harness={thread.harness} state={thread.mark} title={thread.title} line={thread.line ?? `${thread.project} · ${harnessLabel(thread.harness)}`} end={<Age>{thread.age}</Age>} />)}
      </div>
    </div>
  )
}

export function PhoneApex({ fins, counts, onBack, onAnswer }: { fins: Fin[]; counts: Rollup; onBack: () => void; onAnswer: (fin: Fin, option: number) => void }) {
  const end = useEnd<HTMLDivElement>()
  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="h-[47px] shrink-0" />
      <header className="flex shrink-0 items-center gap-2 border-b border-hairline px-2 pb-2.5">
        <button type="button" onClick={onBack} aria-label="Threads" className="pressable flex size-9 items-center justify-center text-muted-foreground"><ChevronLeftIcon className="size-6" /></button>
        <LiveMark harness="claude" state="working" lit cut="var(--surface)" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-prose font-semibold leading-5 text-foreground">Mobile polish</span>
          <span className="truncate text-label text-faint">Claude Code · mobile-polish · This Mac</span>
        </span>
      </header>
      <div ref={end} className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 px-3 py-4">
          <div className="flex justify-end px-1">
            <p className="max-w-[85%] bg-raised px-3 py-2 text-prose leading-[1.45] text-foreground">The sheet still jumps when the keyboard opens in split view.</p>
          </div>
          <div className="flex flex-col gap-1 px-1">
            <span className="flex items-center gap-1.5 text-label text-faint"><HarnessIcon harness="claude" className="size-3" />Claude Code</span>
            <p className="text-prose leading-[1.55] text-foreground">That's Sheet motion's: it's measuring the container in split view now. Two Fins need a word from you.</p>
          </div>
          <CrewCard fins={fins} counts={counts} apex="Mobile polish" onAnswer={onAnswer} onOpen={() => undefined} compact />
        </div>
      </div>
      <div className="shrink-0 border-t border-hairline px-3 pb-8 pt-2">
        <div className="flex items-center gap-2 rounded-full bg-raised py-1.5 pl-4 pr-1.5">
          <span className="flex-1 text-prose text-faint">Message Mobile polish</span>
          <span className="flex size-8 items-center justify-center rounded-full bg-foreground text-background"><ArrowUpIcon className="size-4" /></span>
        </div>
      </div>
    </div>
  )
}

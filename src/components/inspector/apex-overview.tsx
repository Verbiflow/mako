import { Fragment, memo, useCallback, useMemo, useState, type ReactNode, type RefObject } from "react"
import { DIGEST_HEADINGS } from "@mako/host/contracts/apexes"
import { ApexHeader, NewSection, PlanNeeds, PlanSection, RulesSection } from "@/components/apexes/apex-overview-parts"
import { useApex, usePlanNeedsCount } from "@/state/apexes"
import { ChevronRightIcon, GitPullRequestDraftIcon, GitPullRequestIcon } from "lucide-react"
import { APEX_ROLE, APEX_WORD, FIN_WORD, finsWord } from "@mako/host/contracts/agents"
import { askWords, childGroup, childLine, childStateOf, childWord, openAsk, rollup, rollupLabel, rollupLine, sameRollup } from "@mako/host/contracts/children"
import { finTuningLine } from "@mako/host/contracts/fin-tuning"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { WindowedFins } from "@/components/inspector/overview-window"
import { harnessLabel } from "@/components/rail/harness-meta"
import { FinMark } from "@/components/stage/child-tabs"
import { ApexMark } from "@/components/ui/apex-mark"
import { useTickingText } from "@/components/ui/second-clock"
import { ShiverElapsed } from "@/components/viewer/shiver-card"
import { FinAnswerButtons } from "@/components/viewer/fin-answer-buttons"
import { useFinAnswer } from "@/components/viewer/use-fin-answer"
import { FinRowActions } from "@/components/viewer/fin-row-actions"
import { waitsOutside } from "@/lib/shiver-rows"
import { useHarnessIdentity } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import { acp } from "@/state/acp"
import { railAcpStore, useRailAcp } from "@/state/acp-state"
import {
  checksWords,
  foldKey,
  OVERVIEW_HEADINGS,
  OVERVIEW_SECTIONS,
  OVERVIEW_SHOWN,
  OVERVIEW_WINDOWED,
  overviewChildren,
  overviewPulls,
  sameFins,
  toggleOverviewFold,
  toggleOverviewOpened,
  treeFins,
  useOverviewChildren,
  useOverviewFolds,
  useOverviewSection,
  type OverviewPull,
  type OverviewSection,
  type PullOwner,
} from "@/state/apex-overview"
import { desktop } from "@/state/desktop"
import { shallowEqual } from "@/state/store"
import { useWorktreeSummaries, useWorktrees } from "@/state/worktrees"
import { FinMovedLine } from "./fin-moved-line"
import { FinSharingLine } from "./fin-sharing-line"

/**
 * An Apex's Overview, what its right rail opens on: who needs the person, who works, who waits, who failed and who's
 * done, then the tree's open pull requests. A section draws only while it holds something, its first rows until it's
 * opened further, and each reads its own Fins from the roster the window holds (`useOverviewSection`): a Fin's step
 * draws that Fin's row, and a token streaming anywhere draws nothing here.
 */
export function ApexOverview({
  thread,
  conversation,
  apexTitle,
  scroller,
  open,
  onOpen,
}: {
  thread: string | undefined
  /** The Apex's conversation: its host answers the asks and stops the Fins, and its composer is the one addressed. */
  conversation: string | undefined
  apexTitle: string
  scroller: RefObject<HTMLDivElement | null>
  /** The Fin shown now, whose row is lit. */
  open?: string
  onOpen?: (agent: NativeAgent) => void
}) {
  const deliberate = useApex(thread)
  const counts = useRailAcp((state) => rollup(overviewChildren(state, thread, conversation)), sameRollup)
  const stoppable = useRailAcp((state) => overviewChildren(state, thread, conversation).filter((agent) => agent.stoppable).length)
  const planNeedsCount = usePlanNeedsCount(deliberate)
  const stopAll = () => {
    if (!conversation) return
    for (const agent of overviewChildren(railAcpStore.get(), thread, conversation)) if (agent.stoppable) void acp.stopAgent(conversation, agent.nativeId)
  }
  return (
    <section data-apex-fins={counts.total} data-fin-counts={rollupLabel(counts)} data-deliberate-apex={deliberate ? "" : undefined} aria-label={`${apexTitle}'s ${FIN_WORD}s`} className="mb-1">
      {deliberate ? <ApexHeader apex={deliberate} /> : null}
      <div data-apex-counts className="flex h-7 items-center gap-1.5 px-2 text-label text-faint">
        <span className="tabular min-w-0 shrink truncate">{finsWord(counts.total)} · {rollupLine(counts)}</span>
        {stoppable && conversation ? (
          <button
            type="button"
            onClick={stopAll}
            title={`Stop ${finsWord(stoppable)} under ${apexTitle}; the ${APEX_WORD} keeps running`}
            className="pressable -mr-1.5 ml-auto shrink-0 px-1.5 py-0.5 text-label text-faint hover:bg-fill-hover hover:text-foreground"
          >
            Stop all
          </button>
        ) : null}
      </div>
      {OVERVIEW_SECTIONS.map((section) => (
        <Fragment key={section}>
          <FinSection
            section={section}
            thread={thread}
            conversation={conversation}
            apexTitle={apexTitle}
            scroller={scroller}
            open={open}
            onOpen={onOpen}
            {...(deliberate && section === "working" && { label: DIGEST_HEADINGS.progress })}
            {...(deliberate && section === "needs" && { extra: <PlanNeeds apex={deliberate} />, extraCount: planNeedsCount })}
          />
          {deliberate && section === "needs" ? <NewSection apex={deliberate} onOpen={onOpen} /> : null}
        </Fragment>
      ))}
      <PullsSection thread={thread} conversation={conversation} apexTitle={apexTitle} />
      {deliberate ? <PlanSection apex={deliberate} /> : null}
      {deliberate ? <RulesSection apex={deliberate} /> : null}
    </section>
  )
}

/**
 * A section's heading: its name and a quiet count, the rail's own row height. Pressing it folds the section, kept for
 * the Thread while the window is.
 */
export function OverviewHeading({ id, label, count, folded, attention, onToggle }: { id: string; label: string; count: number; folded: boolean; attention?: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      data-child-group={id}
      aria-expanded={!folded}
      onClick={onToggle}
      className="pressable group/heading flex h-7 w-full items-center gap-1.5 px-2 text-left text-label text-faint hover:bg-fill-hover"
    >
      <span className={cn("font-medium", attention ? "text-attention" : "text-muted-foreground")}>{label}</span>
      <span className="tabular">{count}</span>
      <ChevronRightIcon
        aria-hidden
        className={cn("ml-auto size-3 shrink-0 opacity-0 transition-[opacity,transform] duration-150 ease-[var(--ease-out)] group-hover/heading:opacity-100 group-focus-visible/heading:opacity-100", folded ? "opacity-100" : "rotate-90")}
      />
    </button>
  )
}

/** The line under a section's first rows that opens the rest, and puts them away again. */
export function OverviewMore({ rest, opened, onToggle }: { rest: number; opened: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      data-overview-more={opened ? "opened" : rest}
      aria-expanded={opened}
      onClick={onToggle}
      className="pressable flex h-7 w-full items-center px-2 pl-[2.125rem] text-left text-label text-faint hover:bg-fill-hover hover:text-muted-foreground"
    >
      <span className="tabular">{opened ? "Show fewer" : `Show ${rest} more`}</span>
    </button>
  )
}

const FinSection = memo(function FinSection({
  section,
  thread,
  conversation,
  apexTitle,
  scroller,
  open,
  onOpen,
  label,
  extra,
  extraCount = 0,
}: {
  section: OverviewSection
  thread: string | undefined
  conversation: string | undefined
  apexTitle: string
  scroller: RefObject<HTMLDivElement | null>
  open?: string
  onOpen?: (agent: NativeAgent) => void
  /** A deliberate Apex's own word for the section ("In progress"). */
  label?: string
  /** Rows of its own after the Fins': a deliberate Apex's plan lines that wait on the person, counted with them. */
  extra?: ReactNode
  extraCount?: number
}) {
  const fins = useOverviewSection(thread, section, conversation)
  const key = foldKey(thread ?? conversation, section)
  const folded = useOverviewFolds((state) => Boolean(state.folded[key]))
  const opened = useOverviewFolds((state) => Boolean(state.opened[key]))
  const shown = useMemo(() => (opened || fins.length <= OVERVIEW_SHOWN ? fins : fins.slice(0, OVERVIEW_SHOWN)), [fins, opened])
  const row = useCallback(
    (agent: NativeAgent) => <FinRow key={agent.nativeId} agent={agent} conversation={conversation} apexTitle={apexTitle} onOpen={onOpen} lit={agent.child?.thread === open} />,
    [conversation, apexTitle, onOpen, open]
  )
  if (!fins.length && !extraCount) return null
  return (
    <div data-overview-section={section}>
      <OverviewHeading id={section} label={label ?? OVERVIEW_HEADINGS[section]} count={fins.length + extraCount} folded={folded} attention={section === "needs"} onToggle={() => toggleOverviewFold(key)} />
      {folded ? null : (
        <>
          {shown.length > OVERVIEW_WINDOWED ? <WindowedFins fins={shown} scroller={scroller} row={row} /> : shown.map(row)}
          {fins.length > OVERVIEW_SHOWN ? <OverviewMore rest={fins.length - OVERVIEW_SHOWN} opened={opened} onToggle={() => toggleOverviewOpened(key)} /> : null}
          {extra}
        </>
      )}
    </div>
  )
})

/**
 * One Fin, two lines: its mark, its name and how long it has stood as it does, then what it's doing, waits on or
 * ended with, in one muted line. One that needs the person says its question there and offers its answers under it.
 * Opening it is the row; writing to it or stopping it shows beside under the pointer or focus. Memoized on its entry,
 * which the roster keeps while it's unchanged.
 */
const FinRow = memo(function FinRow({
  agent,
  conversation,
  apexTitle,
  onOpen,
  lit = false,
  nested = false,
}: {
  agent: NativeAgent
  conversation: string | undefined
  apexTitle: string
  onOpen?: (agent: NativeAgent) => void
  lit?: boolean
  nested?: boolean
}) {
  useHarnessIdentity()
  const state = childStateOf(agent)
  const group = childGroup(state)
  const ask = openAsk(state)
  const needs = group === "needs" && ask !== undefined
  const quiet = state.kind === "working" && state.quiet !== undefined
  // "Waiting on acme/app#371 checks · 12m", "Quiet 18m · …": the same words for a whole minute, so the row draws once a minute.
  const ticking = waitsOutside(state) || quiet
  const ticked = useTickingText(ticking, (now) => (ticking ? (childLine(state, now) ?? "") : ""))
  const said = needs ? askWords(ask) : ticking ? ticked : childLine(state)
  const lead = ask?.on === "lead"
  const line = (lead && said ? `Asking its ${APEX_WORD}: ${said}` : said) || childWord(state)
  const tip = [
    childWord(state),
    harnessLabel(agent.provider),
    agent.runsOn ? finTuningLine(agent.runsOn) : agent.model,
    agent.role === APEX_ROLE ? APEX_WORD : undefined,
    agent.usage?.toolUses !== undefined ? `${agent.usage.toolUses} ${agent.usage.toolUses === 1 ? "tool use" : "tool uses"}` : undefined,
    agent.runsOn?.rule ? `started by your rule: ${agent.runsOn.rule}` : undefined,
    agent.child?.proceed ? `started on files another ${FIN_WORD} edits: ${agent.child.proceed}` : undefined,
  ].filter(Boolean).join(" · ")
  return (
    <div className={cn("contain-turn group/fin relative", nested && "ml-5")}>
      <FinRowActions agent={agent} conversation={conversation} always={quiet} className="absolute top-1 right-1 z-[1] bg-shell" />
      <button
        type="button"
        data-child-row={agent.child?.thread}
        data-child-state={state.kind}
        data-overview-ask={needs ? (ask.ask?.kind ?? "question") : undefined}
        aria-current={lit || undefined}
        title={tip}
        onClick={() => onOpen?.(agent)}
        className={cn("pressable flex w-full items-start gap-2 px-2 py-1.5 text-left transition-colors duration-100 hover:bg-fill-hover", lit && "bg-fill-selected")}
      >
        <span className="flex h-5 w-[1.125rem] shrink-0 items-center justify-center">
          <FinMark agent={agent} state={state} read cut={lit ? "var(--raised)" : "var(--shell)"} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex h-5 min-w-0 items-center gap-2">
            <span className={cn("min-w-0 flex-1 truncate text-ui", needs ? "font-medium text-foreground" : group === "done" ? "text-foreground/70" : "text-foreground")}>{agent.title}</span>
            {ticking ? null : <ShiverElapsed agent={agent} className="text-label text-faint" />}
          </span>
          <span className={cn("truncate text-label", needs ? "text-foreground/90" : "text-muted-foreground")}>{line}</span>
          <FinMovedLine agent={agent} />
          <FinSharingLine agent={agent} />
          {agent.runsOn?.note ? (
            <span data-fin-fell-back className="truncate text-label text-caution" title={agent.runsOn.note}>
              {agent.runsOn.note}
            </span>
          ) : null}
        </span>
      </button>
      {needs && ask.ask && conversation ? <FinAnswers agent={agent} conversation={conversation} apexTitle={apexTitle} /> : null}
      {agent.role === APEX_ROLE && agent.child ? <SubApexFold thread={agent.child.thread} conversation={conversation} apexTitle={apexTitle} onOpen={onOpen} /> : null}
    </div>
  )
})

/** A needing Fin's answers under its row: the Shiver card's own buttons, so an answer here is the one given there. */
function FinAnswers({ agent, conversation, apexTitle }: { agent: NativeAgent; conversation: string; apexTitle: string }) {
  const { sent, send } = useFinAnswer(agent, conversation)
  const ask = openAsk(childStateOf(agent))?.ask
  if (!ask) return null
  return <FinAnswerButtons agent={agent} ask={ask} apexTitle={apexTitle} sent={sent} send={send} typed className="pt-0.5 pr-2 pb-2 pl-[2.125rem]" />
}

/** A Fin that is an Apex of its own: its Fins fold under it, closed until asked, counted as its badge counts them. */
function SubApexFold({ thread, conversation, apexTitle, onOpen }: { thread: string; conversation: string | undefined; apexTitle: string; onOpen?: (agent: NativeAgent) => void }) {
  const children = useOverviewChildren(thread)
  const [open, setOpen] = useState(false)
  if (!children.length) return null
  return (
    <div className="mb-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="pressable ml-[1.75rem] flex items-center gap-1 px-1.5 py-0.5 text-label text-muted-foreground hover:bg-fill-hover hover:text-foreground"
      >
        <ChevronRightIcon className={cn("size-3 transition-transform duration-150", open && "rotate-90")} />
        <ApexMark className="size-3" />
        {finsWord(children.length)}
      </button>
      {open ? children.slice(0, OVERVIEW_WINDOWED).map((agent) => <FinRow key={agent.nativeId} agent={agent} conversation={conversation} apexTitle={apexTitle} onOpen={onOpen} nested />) : null}
    </div>
  )
}

/** The tree's open pull requests, from the worktree summaries the rail already keeps and what the Fins say they wait on. */
function PullsSection({ thread, conversation, apexTitle }: { thread: string | undefined; conversation: string | undefined; apexTitle: string }) {
  const fins = useRailAcp((state) => (thread ? treeFins(state, thread) : overviewChildren(state, thread, conversation)), sameFins)
  const worktrees = useWorktrees((state) => state.worktrees)
  const summaries = useWorktreeSummaries((state) => state.byPath)
  const pulls = useMemo(() => {
    const owners: PullOwner[] = [...(thread ? [{ thread, title: apexTitle }] : []), ...fins.flatMap((agent) => (agent.child ? [{ thread: agent.child.thread, title: agent.title, agent }] : []))]
    return overviewPulls(owners, worktrees, summaries)
  }, [thread, apexTitle, fins, worktrees, summaries])
  const key = foldKey(thread ?? conversation, "pulls")
  const folded = useOverviewFolds((state) => Boolean(state.folded[key]))
  const opened = useOverviewFolds((state) => Boolean(state.opened[key]))
  if (!pulls.length) return null
  const shown = opened ? pulls : pulls.slice(0, OVERVIEW_SHOWN)
  return (
    <div data-overview-section="pulls">
      <OverviewHeading id="pulls" label="Pull requests" count={pulls.length} folded={folded} onToggle={() => toggleOverviewFold(key)} />
      {folded ? null : (
        <>
          {shown.map((pull) => <PullRow key={pull.key} pull={pull} />)}
          {pulls.length > OVERVIEW_SHOWN ? <OverviewMore rest={pulls.length - OVERVIEW_SHOWN} opened={opened} onToggle={() => toggleOverviewOpened(key)} /> : null}
        </>
      )}
    </div>
  )
}

/** One pull request: its number, its title (or who waits on it), and how its checks stand. It opens on GitHub. */
const PullRow = memo(function PullRow({ pull }: { pull: OverviewPull }) {
  const Icon = pull.draft ? GitPullRequestDraftIcon : GitPullRequestIcon
  const checks = checksWords(pull.checks)
  const waits = pull.until ? `${pull.owner} waits on its ${pull.until}` : undefined
  const words = pull.title ?? waits ?? pull.owner
  const end = checks || (pull.draft ? "Draft" : "")
  const tip = [`${pull.repository ?? ""}#${pull.number}${pull.title ? ` ${pull.title}` : ""}`, pull.title ? pull.owner : undefined, pull.title ? waits : undefined, checks || undefined].filter(Boolean).join("\n")
  const body: ReactNode = (
    <>
      <span className="flex h-5 w-[1.125rem] shrink-0 items-center justify-center text-muted-foreground">
        <Icon aria-hidden className="size-3.5" />
      </span>
      <span className="tabular shrink-0 text-ui text-muted-foreground">#{pull.number}</span>
      <span className="min-w-0 flex-1 truncate text-ui text-foreground">{words}</span>
      {end ? <span className={cn("shrink-0 text-label", pull.checks === "failed" ? "font-medium text-negative" : "text-faint")}>{end}</span> : null}
    </>
  )
  const url = pull.url
  if (!url) return <div data-overview-pull={pull.key} title={tip} className="contain-turn flex h-7 items-center gap-2 px-2">{body}</div>
  return (
    <button type="button" data-overview-pull={pull.key} title={tip} onClick={() => void desktop.openUrl(url)} className="pressable contain-turn flex h-7 w-full items-center gap-2 px-2 text-left hover:bg-fill-hover">
      {body}
    </button>
  )
}, (before, after) => shallowEqual(before.pull, after.pull))

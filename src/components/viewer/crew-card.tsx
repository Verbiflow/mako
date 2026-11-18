import { LimitNoticeRow } from "./limit-notice"
import {
  memo,
  use,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { FinRowActions } from "@/components/viewer/fin-row-actions"
import { FinAnswerButtons } from "@/components/viewer/fin-answer-buttons"
import { useFinAnswer } from "@/components/viewer/use-fin-answer"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useRowRef } from "@/lib/virtual-row-ref"
import { finMoved } from "@/state/fin-moved"
import {
  ArrowRightLeftIcon,
  ChevronRightIcon,
  CornerUpLeftIcon,
  GitPullRequestIcon,
  SquareIcon,
} from "lucide-react"
import { CHILD_GROUPS, askWords, childGroup, childLine, childStateOf, openAsk, rollup, rollupLabel, rollupLine, stoodFor, timeWords, type ChildGroup, type Rollup } from "@mako/host/contracts/children"
import { APEX_WORD, FIN_WORD, finsWord } from "@mako/host/contracts/agents"
import { isLimitAsk } from "@mako/host/contracts/fin-fallback"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { buildRows, waitsOutside, type CrewRow } from "@/lib/crew-rows"
import { FinMark } from "@/components/stage/child-tabs"
import { NOT_OPENABLE } from "@/components/rail/apex-asks"
import { RoutedOpenContext } from "@/components/transcript/routed-open"
import { LiveMark } from "@/components/ui/live-mark"
import { Shimmer } from "@/components/ui/shimmer"
import { useTickingText } from "@/components/ui/second-clock"
import { observeVisibleAnimation } from "@/lib/visible-animation"
import { useHarnessIdentity, harnessLabel } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import { acp, acpStore, useAcp } from "@/state/acp"
import { scopedAcp, useConversationScope } from "@/state/conversation-scope"
import { useThreads } from "@/state/threads"
import {
  apexConversation,
  openFinInApex,
  useFinOpenable,
  threadChildren,
  useThreadAsks,
  useThreadChildren,
} from "@/state/apex-fins"
import { mountCrewCard, unmountCrewCard } from "@/state/crew-card-view"

const HEADINGS = {
  needs: "Needs you",
  working: "Working",
  queued: "Queued",
  idle: "Idle",
  failed: "Failed",
  done: "Done",
} satisfies Record<ChildGroup, string>

const BAR_GROUPS: readonly ChildGroup[] = CHILD_GROUPS
const BAR_TONE = {
  needs: "bg-attention",
  working: "bg-muted-foreground",
  queued: "bg-faint/50",
  idle: "bg-faint",
  failed: "bg-negative/80",
  done: "bg-positive/70",
} satisfies Record<ChildGroup, string>

/** An Apex's name as its Thread's title, read the same way the Agents panel does. */
function useApexCardTitle(thread: string | undefined): string {
  const listed = useThreads((state) =>
    thread
      ? state.threads.find((ref) => ref.threadId === thread)?.title
      : undefined
  )
  const live = useAcp((state) =>
    thread ? apexConversation(state, thread)?.title : undefined
  )
  return listed ?? live ?? "This Thread"
}

/** The header's thin bar, split by group; the working stretch sweeps while it runs, on the compositor alone. */
function CrewBar({
  counts,
  className,
}: {
  counts: Rollup
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "crew-bar flex h-1 gap-0.5 overflow-hidden",
        className
      )}
    >
      {BAR_GROUPS.filter((group) => counts[group] > 0).map((group) =>
        group === "working" ? (
          <span
            key={group}
            ref={observeVisibleAnimation}
            data-group={group}
            className={cn(BAR_TONE[group], "crew-bar-working")}
            style={{ flexGrow: counts[group] }}
          />
        ) : (
          <span
            key={group}
            data-group={group}
            className={BAR_TONE[group]}
            style={{ flexGrow: counts[group] }}
          />
        )
      )}
    </span>
  )
}

/** A Fin needing the person: its question or command, its options as buttons, the recommended one first and labelled. */
const NeedsRow = memo(function NeedsRow({
  agent,
  apex,
  apexTitle,
  onOpen,
  compact,
}: {
  agent: NativeAgent
  apex: string
  apexTitle: string
  onOpen: (agent: NativeAgent) => void
  compact?: boolean
}) {
  useHarnessIdentity()
  const state = childStateOf(agent)
  const openable = useFinOpenable(agent)
  const open = openAsk(state)
  const { sent, send } = useFinAnswer(agent, apex)
  if (!open || !agent.child) return null
  const ask = open.ask
  return (
    <div
      data-crew-row={agent.child.thread}
      data-child-group="needs"
      data-fin-ask={ask?.kind}
      data-fin-decision={open.done || undefined}
      data-fin={agent.child.thread}
      aria-busy={sent ? true : undefined}
      className="bg-[color-mix(in_oklab,var(--attention)_8%,var(--raised))] px-3 py-2.5 shadow-[inset_2px_0_0_var(--attention)]"
    >
      <div className="flex items-center gap-2">
        <FinMark agent={agent} state={state} cut="var(--raised)" />
        <button
          type="button"
          onClick={() => onOpen(agent)}
          data-openable={openable}
          aria-disabled={openable ? undefined : true}
          title={openable ? undefined : NOT_OPENABLE}
          className={cn("pressable min-w-0 truncate text-ui font-medium text-foreground hover:underline", !openable && "cursor-default opacity-60 hover:no-underline")}
        >
          {agent.title}
        </button>
        {!compact ? (
          <span className="shrink-0 text-label text-faint">
            {harnessLabel(agent.provider)}
            {agent.model ? (
              <span className="text-faint/80"> · {agent.model}</span>
            ) : null}
          </span>
        ) : null}
        <span className="flex-1" />
        <CrewElapsed agent={agent} className="text-label text-faint" />
      </div>
      <p className="mt-1.5 pl-7 text-ui text-foreground/90">{askWords(open)}</p>
      {ask ? <FinAnswerButtons agent={agent} ask={ask} apexTitle={apexTitle} sent={sent} send={send} compact={compact} hint={!compact} className="mt-2 pl-7" /> : null}
    </div>
  )
})

/**
 * The time on a row: how long the Fin has stood as it does (`since`), a working
 * one's current turn and never its age. The shared clock ticks once a second; a
 * minute or an hour is the same string for that whole stretch, so the row's
 * label doesn't repaint on the seconds in between.
 */
export const CrewElapsed = memo(function CrewElapsed({
  agent,
  className,
}: {
  agent: NativeAgent
  className?: string
}) {
  const since = agent.since
  const stood = useTickingText(since !== undefined, (now) =>
    since === undefined ? "" : stoodFor(now - since)
  )
  const { time, title } = timeWords(childStateOf(agent), stood)
  if (!time) return null
  return <span title={title} className={cn("tabular shrink-0", className)}>{time}</span>
})

/** Working, queued, failed or done: one line, its mark, title, current line and time. */
const CrewLineRow = memo(function CrewLineRow({
  agent,
  onOpen,
  conversation,
  compact,
}: {
  agent: NativeAgent
  onOpen: (agent: NativeAgent) => void
  /** The Apex's conversation, for the row's actions; none where the window can't act on its Fins (the web's). */
  conversation?: string
  compact?: boolean
}) {
  useHarnessIdentity()
  const state = childStateOf(agent)
  const openable = useFinOpenable(agent)
  const group = childGroup(state)
  const waiting = waitsOutside(state)
  const quiet = state.kind === "working" && state.quiet !== undefined
  // "Waiting on acme/app#371 checks · 12m", "Quiet 18m · …": the same string for a whole minute, so the row repaints once a minute.
  const ticking = waiting || quiet
  const waited = useTickingText(ticking, (now) => (ticking ? childLine(state, now) ?? "" : ""))
  const line = ticking ? waited : childLine(state)
  const live = (state.kind === "working" && !quiet) || state.kind === "starting"
  const lead = openAsk(state)?.on === "lead"
  const moved = finMoved(agent)
  // `childState()` keeps a reason for a failed Fin but drops it for one that succeeded (`agents.ts`, not this
  // card's own), so the glyph only ever has a failure's line to read on real data today.
  const pr =
    (group === "done" || group === "failed") && /\bPR\b/.test(line ?? "")
  const row = (
    <button
      type="button"
      data-crew-row={agent.child?.thread}
      data-child-group={group}
      data-child-state={state.kind}
      data-quiet={quiet || undefined}
      data-openable={openable}
      aria-disabled={openable ? undefined : true}
      title={openable ? undefined : NOT_OPENABLE}
      onClick={() => onOpen(agent)}
      className={cn(
        "pressable group flex w-full items-center gap-2 px-1.5 text-left hover:bg-fill-hover",
        compact ? "min-h-11 py-1.5" : "h-8",
        !openable && "cursor-default opacity-60 hover:bg-transparent",
      )}
    >
      <FinMark agent={agent} state={state} cut="var(--surface)" />
      <span
        className={cn(
          "flex min-w-0 flex-1",
          compact ? "flex-col" : "items-center gap-2"
        )}
      >
        <span
          className={cn(
            "shrink-0 truncate text-ui",
            group === "done" ? "text-foreground/70" : "text-foreground",
            compact ? "" : "max-w-[42%]"
          )}
        >
          {agent.title}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-label text-faint">
          {lead ? (
            <CornerUpLeftIcon className="size-3 shrink-0" aria-hidden />
          ) : null}
          {moved ? (
            <span data-fin-moved title={moved} className="flex min-w-0 items-center gap-1">
              <ArrowRightLeftIcon className="size-3 shrink-0" aria-hidden />
              <span className="min-w-0 truncate">
                {moved.split(":")[0]}
                {line ? " ·" : null}
              </span>
            </span>
          ) : null}
          {pr ? (
            <GitPullRequestIcon className="size-3 shrink-0" aria-hidden />
          ) : null}
          {live && line ? (
            <Shimmer text={line} className="min-w-0 truncate" />
          ) : (
            <span className="min-w-0 truncate" title={line}>
              {lead ? `Asking its Apex: ${line}` : line}
            </span>
          )}
        </span>
      </span>
      {ticking ? null : (
        <CrewElapsed
          agent={agent}
          className="min-w-8 shrink-0 text-right text-label text-faint"
        />
      )}
    </button>
  )
  if (!conversation || compact) return row
  // Opening it is the row; writing to it or stopping it sits beside, on hover, and always for a quiet Fin.
  return (
    <div data-quiet-row={quiet || undefined} className="group/fin flex items-center">
      <div className="min-w-0 flex-1">{row}</div>
      <FinRowActions agent={agent} conversation={conversation} always={quiet} />
    </div>
  )
})


/** The settled Fins, folded: "24 done · 1 idle", which opens their list and closes it again. */
export function SettledLine({ row, onToggle }: { row: Extract<CrewRow, { kind: "settled" }>; onToggle: () => void }) {
  const words = [row.done ? `${row.done} done` : "", row.idle ? `${row.idle} idle` : ""].filter(Boolean).join(" · ")
  return (
    <button
      type="button"
      data-crew-settled={row.open ? "open" : "folded"}
      aria-expanded={row.open}
      onClick={onToggle}
      className="pressable flex h-7 w-full items-center gap-1.5 px-1.5 text-left text-label text-faint hover:bg-fill-hover hover:text-muted-foreground"
    >
      <ChevronRightIcon aria-hidden className={cn("size-3 shrink-0 transition-transform duration-150 ease-[var(--ease-out)]", row.open && "rotate-90")} />
      <span className="tabular">{words}</span>
    </button>
  )
}

/**
 * An Apex's crew, at the end of its transcript: what needs the person and what's live, needs-you first, the settled
 * ones folded into one line, its asks answered in place through the
 * same action the Agents panel and the dock use. Replaces `BackgroundWorkLine` while the Thread has Fins; `fallback`
 * (the background-work line) draws instead for a Thread with none. It stays through whatever its Apex's session does
 * (a turn, starting, waking, reconnecting): the Fins are theirs, not the session's. Past about twenty rows it scrolls inside itself;
 * rows are drawn as they scroll into view, so a crew of forty costs what a screenful does. Each row reads its own
 * Fin's entry alone, so a step changing repaints that row, not this card.
 *
 * Memoized by hand: `useVirtualizer` keeps the React Compiler off this file, so without it the card drew again with
 * every batch its transcript streamed, its virtualizer's options set anew each time, as long a stretch of a phone's
 * frame as the streamed words were.
 */
export const CrewCard = memo(CrewCardBody)

function CrewCardBody({
  compact = false,
  fallback = null,
  thread: shownThread,
}: {
  compact?: boolean
  fallback?: ReactNode
  /** The Thread whose Fins it shows, where that isn't the conversation in scope: a saved transcript's own. */
  thread?: string
}) {
  const scope = useConversationScope()
  const scoped = useAcp((state) => scopedAcp(state, scope)?.threadId)
  const thread = shownThread ?? scoped
  const conversation = useAcp((state) =>
    thread ? apexConversation(state, thread)?.key : undefined
  )
  const apexTitle = useApexCardTitle(thread)
  const children = useThreadChildren(thread)
  const notice = useThreadAsks(thread).find((ask) => isLimitAsk(ask.ask.id))
  const scroller = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLElement>(null)
  // In view until the observer says otherwise, so the dock doesn't also draw the asks for the frame before it reports.
  useLayoutEffect(() => {
    const element = card.current
    if (!thread || !element) return
    mountCrewCard(thread, true)
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (entry) mountCrewCard(thread, entry.isIntersecting)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      unmountCrewCard(thread)
    }
  }, [thread, children.length])
  const [settledOpen, setSettledOpen] = useState(false)
  const rows = useMemo(() => buildRows(children, settledOpen), [children, settledOpen])
  const counts = useMemo(() => rollup(children), [children])
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (index) => {
      const row = rows[index]
      if (!row || row.kind === "heading" || row.kind === "settled") return 28
      if (row.group === "needs") return compact ? 176 : 128
      return compact ? 52 : 32
    },
    overscan: 6,
    getItemKey: (index) => {
      const row = rows[index]
      return row?.kind === "heading"
        ? `heading:${row.group}`
        : row?.kind === "settled"
          ? "settled"
          : row
          ? `child:${row.agent.nativeId}`
          : index
    },
  })
  const measureRow = useRowRef(virtualizer)
  // A Fin opens in place on the desk; the web's Thread screen opens it by its own address.
  const routed = use(RoutedOpenContext)
  const onOpen = useCallback(
    (agent: NativeAgent) => {
      if (routed) routed(agent)
      else if (thread) openFinInApex(thread, apexTitle, agent)
    },
    [routed, thread, apexTitle]
  )
  const stoppable = children.filter((agent) => agent.stoppable).length
  // On the phone one tap stops every Fin; it asks first there, where a thumb brushes it easily.
  const [confirmingStop, setConfirmingStop] = useState(false)
  const stopAll = useCallback(() => {
    setConfirmingStop(false)
    if (!conversation || !thread) return
    for (const agent of threadChildren(acpStore.get(), thread))
      if (agent.stoppable) void acp.stopAgent(conversation, agent.nativeId)
  }, [conversation, thread])
  if (!children.length || !conversation) return <>{fallback}</>
  return (
    <section
      ref={card}
      data-crew={counts.total}
      data-compact={compact || undefined}
      aria-label={`${apexTitle}'s ${FIN_WORD}s`}
      className="mt-2 flex animate-in flex-col duration-200 ease-[var(--ease-out)] fade-in-0"
    >
      <header
        className={cn(
          "flex items-center gap-2.5",
          compact ? "px-1.5 py-2" : "px-1.5 py-2"
        )}
      >
        <LiveMark state="idle" className="live-mark-still" cut="var(--surface)" />
        <span data-fin-counts={rollupLabel(counts)} className="shrink-0 text-ui font-medium whitespace-nowrap text-foreground">
          {finsWord(counts.total)}
        </span>
        <span className="min-w-0 flex-1 truncate text-label text-muted-foreground">
          {rollupLine(counts)}
        </span>
        <CrewBar counts={counts} className={compact ? "w-14" : "w-24"} />
        {stoppable ? (
          <button
            type="button"
            onClick={compact ? () => setConfirmingStop((open) => !open) : stopAll}
            title={`Stop ${finsWord(stoppable)} under ${apexTitle}; the ${APEX_WORD} keeps running`}
            aria-expanded={compact ? confirmingStop : undefined}
            data-stop-all
            className={cn("pressable flex shrink-0 items-center gap-1.5 px-2 text-label text-faint hover:bg-fill-hover hover:text-foreground", compact ? "h-9" : "h-7")}
          >
            <SquareIcon className="size-2.5 fill-current" aria-hidden />
            Stop all
          </button>
        ) : null}
      </header>
      {compact && confirmingStop && stoppable ? (
        <div role="group" aria-label="Stop all" data-stop-all-confirm className="flex items-center gap-2 bg-raised/60 px-3 py-1.5">
          <span className="min-w-0 flex-1 text-ui text-foreground">
            Stop {finsWord(stoppable)}? <span className="text-muted-foreground">The {APEX_WORD} keeps running.</span>
          </span>
          <button type="button" onClick={() => setConfirmingStop(false)} className="pressable h-9 shrink-0 px-3 text-ui text-muted-foreground hover:bg-fill-hover">
            Cancel
          </button>
          <button type="button" data-stop-all-yes onClick={stopAll} className="pressable h-9 shrink-0 bg-negative/15 px-3 text-ui font-medium text-negative hover:bg-negative/25">
            Stop
          </button>
        </div>
      ) : null}
      {notice && conversation ? <LimitNoticeRow key={notice.ask.id} apex={conversation} ask={notice} compact={compact} /> : null}
      <div
        ref={scroller}
        data-crew-scroller
        className="max-h-[420px] overflow-y-auto py-1"
      >
        <div
          className="relative"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]!
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={measureRow}
                className="absolute inset-x-0 top-0 pb-1.5"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {row.kind === "settled" ? (
                  <SettledLine row={row} onToggle={() => setSettledOpen((open) => !open)} />
                ) : row.kind === "heading" ? (
                  <h4
                    data-crew-needs={row.group === "needs" || undefined}
                    className="flex items-center gap-1.5 px-1.5 pb-1 text-label text-faint"
                  >
                    <span
                      className={
                        row.group === "needs"
                          ? "font-medium text-attention"
                          : "font-medium text-muted-foreground"
                      }
                    >
                      {HEADINGS[row.group]}
                    </span>
                    <span className="tabular">{row.count}</span>
                  </h4>
                ) : row.group === "needs" ? (
                  <NeedsRow
                    agent={row.agent}
                    apex={conversation}
                    apexTitle={apexTitle}
                    onOpen={onOpen}
                    compact={compact}
                  />
                ) : (
                  <CrewLineRow
                    agent={row.agent}
                    onOpen={onOpen}
                    conversation={routed ? undefined : conversation}
                    compact={compact}
                  />
                )}
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

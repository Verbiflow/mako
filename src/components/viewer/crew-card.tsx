import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  CheckIcon,
  CornerUpLeftIcon,
  GitPullRequestIcon,
  SquareIcon,
  XIcon,
} from "lucide-react"
import {
  CHILD_GROUPS,
  childGroup,
  childLine,
  childStateOf,
  rollup,
  rollupLabel,
  rollupLine,
  type ChildGroup,
  type Rollup,
} from "@mako/host/contracts/children"
import { APEX_WORD, FIN_WORD, finsWord } from "@mako/host/contracts/agents"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { ApexMark } from "@/components/ui/apex-mark"
import { FinMark } from "@/components/stage/child-tabs"
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
  threadChildren,
  useThreadChildren,
} from "@/state/apex-fins"
import { answerFin, type FinAnswer } from "@/state/fin-asks"
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
  needs: "bg-caution",
  working: "bg-muted-foreground",
  queued: "bg-faint/50",
  idle: "bg-faint",
  failed: "bg-negative/80",
  done: "bg-positive/70",
} satisfies Record<ChildGroup, string>

type CrewRow =
  | { kind: "heading"; group: ChildGroup; count: number }
  | { kind: "child"; agent: NativeAgent; group: ChildGroup }

function buildRows(children: readonly NativeAgent[]): CrewRow[] {
  const out: CrewRow[] = []
  let group: ChildGroup | undefined
  let heading: Extract<CrewRow, { kind: "heading" }> | undefined
  for (const agent of children) {
    const next = childGroup(childStateOf(agent))
    if (next !== group) {
      group = next
      heading = { kind: "heading", group: next, count: 0 }
      out.push(heading)
    }
    heading!.count += 1
    out.push({ kind: "child", agent, group: next })
  }
  return out
}

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
        "crew-bar flex h-1 overflow-hidden rounded-full bg-foreground/10",
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
  const [sent, setSent] = useState<FinAnswer | undefined>(undefined)
  const state = childStateOf(agent)
  if (state.kind !== "blocked" || !agent.child) return null
  const ask = state.ask
  const approval = ask?.kind === "approval"
  const options = ask?.options ?? []
  const order = options
    .map((_, index) => index)
    .sort((left, right) =>
      left === ask?.recommended ? -1 : right === ask?.recommended ? 1 : 0
    )
  const send = (answer: FinAnswer) => {
    if (sent || !ask || !agent.child) return
    setSent(answer)
    void answerFin(
      apex,
      {
        fin: agent.child.thread,
        title: agent.title,
        harness: agent.provider,
        question: state.question,
        ask,
      },
      answer
    ).then((answered) => {
      if (!answered) setSent(undefined)
    })
  }
  return (
    <div
      data-crew-row={agent.child.thread}
      data-child-group="needs"
      data-fin-ask={ask?.kind}
      data-fin={agent.child.thread}
      aria-busy={sent ? true : undefined}
      className="rounded-lg bg-[color-mix(in_oklab,var(--caution)_7%,transparent)] px-3 py-2.5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--caution)_22%,transparent)]"
    >
      <div className="flex items-center gap-2">
        <FinMark agent={agent} state={state} cut="var(--surface)" />
        <button
          type="button"
          onClick={() => onOpen(agent)}
          className="pressable min-w-0 truncate text-ui font-medium text-foreground hover:underline"
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
      <p className="mt-1.5 pl-7 text-ui text-foreground/90">{state.question}</p>
      {ask ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-7">
          {approval ? (
            <>
              <button
                type="button"
                data-fin-answer="allow"
                disabled={Boolean(sent)}
                data-chosen={sent?.allow === true || undefined}
                onClick={() => send({ allow: true })}
                className={cn(
                  "pressable flex items-center gap-1.5 rounded-md bg-foreground px-2.5 text-label font-medium text-background hover:bg-foreground/90 disabled:opacity-50",
                  compact ? "h-9" : "h-7"
                )}
              >
                <CheckIcon className="size-3.5" />
                Allow once
              </button>
              <button
                type="button"
                data-fin-answer="refuse"
                disabled={Boolean(sent)}
                data-chosen={sent?.allow === false || undefined}
                onClick={() => send({ allow: false })}
                className={cn(
                  "pressable flex items-center gap-1.5 rounded-md px-2.5 text-label font-medium text-foreground/85 shadow-[inset_0_0_0_1px_var(--border)] hover:bg-fill-hover disabled:opacity-50",
                  compact ? "h-9" : "h-7"
                )}
              >
                <XIcon className="size-3.5" />
                Refuse
              </button>
            </>
          ) : (
            order.map((index) => {
              const option = options[index]!
              const primary = index === order[0]
              return (
                <button
                  key={`${index}:${option.label}`}
                  type="button"
                  data-fin-answer={index}
                  data-recommended={index === ask.recommended || undefined}
                  title={option.detail}
                  disabled={Boolean(sent)}
                  data-chosen={sent?.option === index || undefined}
                  onClick={() => send({ option: index })}
                  className={cn(
                    "pressable flex items-center gap-1.5 rounded-md px-2.5 text-label font-medium disabled:opacity-50",
                    compact ? "h-9" : "h-7",
                    primary
                      ? "bg-foreground text-background hover:bg-foreground/90"
                      : "text-foreground/85 shadow-[inset_0_0_0_1px_var(--border)] hover:bg-fill-hover"
                  )}
                >
                  {option.label}
                  {index === ask.recommended ? (
                    <span
                      className={cn(
                        "font-normal",
                        primary ? "text-background/70" : "text-faint"
                      )}
                    >
                      Recommended
                    </span>
                  ) : null}
                </button>
              )
            })
          )}
          {!compact ? (
            <span className="ml-auto text-label text-faint">
              {approval
                ? `${agent.title} waits on this command`
                : `Answer here or tell ${apexTitle}`}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})

/** How long a Fin has run, one unit: "25s", "18m", "1h 4m". Nothing under a second. */
function took(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 1) return ""
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

/**
 * The time on a row. The shared clock ticks once a second only while the Fin
 * works; a minute or an hour is the same string for that whole stretch, so
 * the row's label doesn't repaint on the seconds in between.
 */
const CrewElapsed = memo(function CrewElapsed({
  agent,
  className,
}: {
  agent: NativeAgent
  className?: string
}) {
  const state = childStateOf(agent)
  const working = state.kind === "working" || state.kind === "starting"
  const start = agent.startedAt ?? agent.observedAt
  const frozen = (agent.settledAt ?? agent.observedAt) - start
  const text = useTickingText(working, (now) =>
    took(working ? now - start : frozen)
  )
  if (!text) return null
  return <span className={cn("tabular shrink-0", className)}>{text}</span>
})

/** Working, queued, failed or done: one line, its mark, title, current line and time. */
const CrewLineRow = memo(function CrewLineRow({
  agent,
  onOpen,
  compact,
}: {
  agent: NativeAgent
  onOpen: (agent: NativeAgent) => void
  compact?: boolean
}) {
  useHarnessIdentity()
  const state = childStateOf(agent)
  const group = childGroup(state)
  const line = childLine(state)
  const live = state.kind === "working" || state.kind === "starting"
  const lead = state.kind === "blocked" && state.on === "lead"
  // `childState()` keeps a reason for a failed Fin but drops it for one that succeeded (`agents.ts`, not this
  // card's own), so the glyph only ever has a failure's line to read on real data today.
  const pr =
    (group === "done" || group === "failed") && /\bPR\b/.test(line ?? "")
  return (
    <button
      type="button"
      data-crew-row={agent.child?.thread}
      data-child-group={group}
      data-child-state={state.kind}
      onClick={() => onOpen(agent)}
      className={cn(
        "pressable group flex w-full items-center gap-2 rounded-md px-1.5 text-left hover:bg-fill-hover",
        compact ? "min-h-11 py-1.5" : "h-8"
      )}
    >
      <FinMark agent={agent} state={state} cut="var(--raised)" />
      <span
        className={cn(
          "flex min-w-0 flex-1",
          compact ? "flex-col items-start" : "items-center gap-2"
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
          {pr ? (
            <GitPullRequestIcon className="size-3 shrink-0" aria-hidden />
          ) : null}
          {live && line ? (
            <Shimmer text={line} className="min-w-0 truncate" />
          ) : (
            <span className="min-w-0 truncate">
              {lead ? `Asking its Apex: ${line}` : line}
            </span>
          )}
        </span>
      </span>
      <CrewElapsed
        agent={agent}
        className="min-w-8 shrink-0 text-right text-label text-faint"
      />
    </button>
  )
})

/**
 * An Apex's crew, at the end of its transcript: every Fin, needs-you first, its asks answered in place through the
 * same action the Agents panel and the dock use. Replaces `BackgroundWorkLine` while the Thread has Fins; `fallback`
 * (the background-work line) draws instead for a Thread with none. Past about twenty rows it scrolls inside itself;
 * rows are drawn as they scroll into view, so a crew of forty costs what a screenful does. Each row reads its own
 * Fin's entry alone, so a step changing repaints that row, not this card.
 */
export function CrewCard({
  compact = false,
  fallback = null,
}: {
  compact?: boolean
  fallback?: ReactNode
}) {
  const scope = useConversationScope()
  const thread = useAcp((state) => scopedAcp(state, scope)?.threadId)
  const conversation = useAcp((state) =>
    thread ? apexConversation(state, thread)?.key : undefined
  )
  const apexTitle = useApexCardTitle(thread)
  const children = useThreadChildren(thread)
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
  const rows = useMemo(() => buildRows(children), [children])
  const counts = useMemo(() => rollup(children), [children])
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (index) => {
      const row = rows[index]
      if (!row || row.kind === "heading") return 28
      if (row.group === "needs") return compact ? 176 : 128
      return compact ? 52 : 32
    },
    overscan: 6,
    getItemKey: (index) => {
      const row = rows[index]
      return row?.kind === "heading"
        ? `heading:${row.group}`
        : row
          ? `child:${row.agent.nativeId}`
          : index
    },
  })
  const onOpen = useCallback(
    (agent: NativeAgent) =>
      thread ? openFinInApex(thread, apexTitle, agent) : undefined,
    [thread, apexTitle]
  )
  const stoppable = children.filter((agent) => agent.stoppable).length
  const stopAll = useCallback(() => {
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
      className="mt-1 flex animate-in flex-col overflow-hidden rounded-xl bg-surface shadow-[inset_0_0_0_1px_var(--hairline)] duration-200 ease-[var(--ease-out)] fade-in-0"
    >
      <header
        className={cn(
          "flex items-center gap-3 border-b border-hairline",
          compact ? "px-3 py-2.5" : "px-4 py-3"
        )}
      >
        <ApexMark className="size-4 shrink-0 text-muted-foreground" />
        <span data-fin-counts={rollupLabel(counts)} className="shrink-0 text-ui font-medium whitespace-nowrap text-foreground">
          {finsWord(counts.total)}
        </span>
        <span className="min-w-0 flex-1 truncate text-label text-muted-foreground">
          {rollupLine(counts)}
        </span>
        <CrewBar counts={counts} className={compact ? "w-14" : "w-24"} />
        {!compact && stoppable ? (
          <button
            type="button"
            onClick={stopAll}
            title={`Stop ${finsWord(stoppable)} under ${apexTitle}; the ${APEX_WORD} keeps running`}
            className="pressable flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-label text-faint hover:bg-fill-hover hover:text-foreground"
          >
            <SquareIcon className="size-2.5 fill-current" aria-hidden />
            Stop all
          </button>
        ) : null}
      </header>
      <div
        ref={scroller}
        data-crew-scroller
        className="max-h-[420px] overflow-y-auto p-3"
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
                ref={virtualizer.measureElement}
                className="absolute inset-x-0 top-0 pb-1.5"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {row.kind === "heading" ? (
                  <h4
                    data-crew-needs={row.group === "needs" || undefined}
                    className="flex items-center gap-1.5 px-1.5 pb-1 text-label text-faint"
                  >
                    <span
                      className={
                        row.group === "needs"
                          ? "font-medium text-caution"
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

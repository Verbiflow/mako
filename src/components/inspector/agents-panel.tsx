import { useHarnessIdentity } from "@/lib/harness-label"
import { memo, useCallback, useMemo, useRef, useState } from "react"
import { ChevronDownIcon, GitBranchIcon, HourglassIcon, SquareIcon } from "lucide-react"
import { acp, activeLiveAcp, useAcp } from "@/state/acp"
import { conversationWork, type AcpState, type LiveAcpConversation } from "@/state/acp-state"
import { toggleAgentsPanel } from "@/state/window-routes"
import { shallowEqual } from "@/state/store"
import { threads, useThreads } from "@/state/threads"
import { descriptorFor } from "@/state/descriptors"
import { capabilityText } from "@mako/host/contracts/harness-capabilities"
import { backgroundWork, backgroundWorkText } from "@mako/host/contracts/background-work"
import { isActiveNativeAgent, isProviderWork, type NativeWork } from "@mako/host/contracts/native-agents"
import { rollup, rollupChip, rollupLabel, rosterChildren } from "@mako/host/contracts/children"
import { ApexFinsSection } from "@/components/inspector/apex-fins-section"
import { apexConversation, openFinInApex, threadChildren, threadRollup, useApexView } from "@/state/apex-fins"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import { harnessLabel } from "@/components/rail/harness-meta"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { ApexMark } from "@/components/ui/apex-mark"
import { Elapsed } from "@/components/inspector/elapsed"
import { formatTokens } from "@/lib/format"
import { cn } from "@/lib/utils"
import { ActivityMark, type ActivityState } from "@/components/ui/activity-mark"
import { Blank } from "@/components/ui/kit"
import { Shimmer } from "@/components/ui/shimmer"
import type { NativeAgent, NativeAgentRoster } from "@/lib/types"
import { finTuningLine } from "@mako/host/contracts/fin-tuning"
import { SignpostIcon } from "lucide-react"
import { FinMovedLine } from "./fin-moved-line"
import { WorkGlyph } from "./work-glyph"

export { WorkGlyph }

const labels = {
  working: "Running",
  waiting: "Waiting",
  completed: "Done",
  failed: "Failed",
  canceled: "Stopped",
  unknown: "Status unavailable",
} satisfies Record<NativeAgent["state"]["kind"], string>

const kinds = {
  agent: "Subagent",
  workflow: "Workflow",
  command: "Background command",
  monitor: "Monitor",
  task: "Task",
} satisfies Record<NativeWork, string>

/** How a child came to be one, said only when it wasn't started through a door. */
function childOrigin(origin: NonNullable<NativeAgent["child"]>["origin"]): string | undefined {
  if (origin === "discovered") return "Found in its shell"
  if (origin === "linked") return "Linked"
  return undefined
}

/**
 * What an entry is, in the one vocabulary every harness's entries share: a
 * subagent its provider runs inside the turn, a background command or
 * monitor, or an agent, a child Thread among them (`child`).
 */
function workKind(agent: NativeAgent): string {
  const origin = agent.child && childOrigin(agent.child.origin)
  return origin ? `${kinds[agent.work ?? "agent"]} · ${origin}` : kinds[agent.work ?? "agent"]
}

/** A child's Session, which opens read-only like any session's transcript. */
function openTranscript(agent: NativeAgent): void {
  const child = agent.child
  if (!child?.path || !child.nativeId) return
  void threads.view({ harness: agent.provider, nativeId: child.nativeId, path: child.path, title: agent.title }, "native")
}

function activity(agent: NativeAgent): string | undefined {
  switch (agent.state.kind) {
    case "working":
      return agent.state.activity
    case "waiting":
      return agent.state.reason ?? "Waiting for the provider"
    case "completed":
      return agent.state.summary
    case "failed":
      return agent.state.error
    case "unknown":
      return agent.state.reason
    case "canceled":
      return undefined
  }
}

/** Active first, oldest first, then what settled, newest first; housekeeping last. */
function ordered(agents: readonly NativeAgent[]): NativeAgent[] {
  const rank = (agent: NativeAgent) => (agent.ambient ? 2 : isActiveNativeAgent(agent) ? 0 : 1)
  return [...agents].sort((left, right) => {
    const byRank = rank(left) - rank(right)
    if (byRank) return byRank
    const a = left.startedAt ?? left.observedAt
    const b = right.startedAt ?? right.observedAt
    return rank(left) === 0 ? a - b : b - a
  })
}

export function AgentsPanel() {
  const focus = useWorkspaceFocus()
  const key = useAcp((state) => (focus.identity === `live:${state.activeKey}` ? state.activeKey : undefined))
  // A Fin open in its Apex's Thread keeps the Apex's panel, the Fin's row lit.
  const open = useApexView((state) => state.open)
  const apex = useAcp((state) => (open && key && state.conversations[key]?.threadId === open.child ? apexConversation(state, open.apex)?.key : undefined))
  return <ConversationAgents key={apex ?? focus.identity} conversation={apex ?? key ?? undefined} litChild={apex ? open?.child : undefined} />
}

function liveConversation(state: AcpState, conversation: string | undefined): LiveAcpConversation | undefined {
  const found = conversation ? state.conversations[conversation] : undefined
  return found?.kind === "live" ? found : undefined
}

/** One conversation's roster as the desk's Agents panel and a phone's Agents sheet both draw it. */
export function ConversationAgents({
  conversation,
  transcripts = true,
  onOpenChild,
  litChild,
}: {
  conversation?: string
  transcripts?: boolean
  /** The Fin shown now, whose row is lit. */
  litChild?: string
  /** Where a Fin's row opens it: in place in its Apex's Thread on the desk (`openFinInApex`). */
  onOpenChild?: (agent: NativeAgent, apex: { thread: string; title: string }) => void
}) {
  const roster = useAcp((state) => liveConversation(state, conversation)?.nativeAgents)
  const provider = useAcp((state) => liveConversation(state, conversation)?.harness)
  const thread = useAcp((state) => liveConversation(state, conversation)?.threadId)
  // Its Thread's Fins, as the newest of its conversations holds them: an older Session hears only how they stand.
  const children = useAcp((state) => (thread ? threadChildren(state, thread) : rosterChildren(liveConversation(state, conversation)?.nativeAgents)))
  const apexTitle = useApexName(conversation, thread)
  // Stable, so a batch moving one Fin repaints that Fin's row alone.
  const openChild = useCallback(
    (agent: NativeAgent) => {
      if (!thread) return
      if (onOpenChild) onOpenChild(agent, { thread, title: apexTitle })
      else openFinInApex(thread, apexTitle, agent)
    },
    [onOpenChild, thread, apexTitle]
  )
  const background = useAcp((state) => {
    const live = liveConversation(state, conversation)
    const work = live ? backgroundWork(live.session, live.nativeAgents) : null
    // The Fins section counts the Fins; this line says what else the session waits on.
    const named = work?.named.filter((agent) => !agent.child) ?? []
    const rest = work && (named.length || work.unnamed) ? { ...work, named, count: named.length + work.unnamed } : null
    return { waiting: rest ? backgroundWorkText(rest) : undefined, unnamed: work?.unnamed ?? 0, stopping: live?.canceling ?? false }
  }, shallowEqual)
  return (
    <AgentRoster
      conversation={conversation}
      roster={roster}
      children={children}
      provider={provider}
      transcripts={transcripts}
      apexTitle={apexTitle}
      litChild={litChild}
      onOpenChild={thread ? openChild : undefined}
      {...background}
    />
  )
}

/** An Apex's name as its rail row says it: its Thread's, else its conversation's. */
function useApexName(conversation: string | undefined, thread: string | undefined): string {
  const listed = useThreads((state) => (thread ? state.threads.find((ref) => ref.threadId === thread)?.title : undefined))
  const live = useAcp((state) => liveConversation(state, conversation)?.title)
  return listed ?? live ?? "This Thread"
}

function AgentRoster({
  conversation,
  roster,
  children,
  provider,
  transcripts,
  waiting,
  unnamed,
  stopping,
  apexTitle,
  litChild,
  onOpenChild,
}: {
  conversation?: string
  roster?: NativeAgentRoster
  /** Its Thread's Fins (`threadChildren`). */
  children: readonly NativeAgent[]
  apexTitle: string
  litChild?: string
  onOpenChild?: (agent: NativeAgent) => void
  provider?: string
  /** Whether a child's row opens its transcript, which only the desk can show. */
  transcripts: boolean
  /** What the session waits on between turns, in words; absent while a turn runs or nothing does. */
  waiting?: string
  /** Work the provider counts without naming it. */
  unnamed: number
  stopping: boolean
}) {
  useHarnessIdentity()
  const [visible, setVisible] = useState(40)
  const capability = useThreads((state) => descriptorFor(state, provider)?.capabilities.nativeAgents)
  const scroller = useRef<HTMLDivElement>(null)
  const agents = useMemo(() => ordered((roster?.agents ?? []).filter(isProviderWork)), [roster])
  if (agents.length === 0 && !unnamed && !children.length)
    return (
      <Blank
        icon={<GitBranchIcon />}
        title={!provider ? "No live conversation" : "Nothing running alongside"}
        body={
          !provider
            ? "Open a live conversation to follow the agents and background work it starts."
            : !capability || capability.state === "implemented"
              ? "Subagents, background commands and agents, and monitors this conversation starts appear here with their progress and results."
              : `${harnessLabel(provider)} does not report its agents to Mako. ${capabilityText(capability)}`
        }
      />
    )
  // Fins are counted by their own section, as every surface counts them (`rollup`); this line is the rest.
  const running = agents.filter((agent) => !agent.child && isActiveNativeAgent(agent) && !agent.ambient).length + unnamed
  const finished = agents.filter((agent) => !agent.child && !isActiveNativeAgent(agent)).length
  return (
    <div className="flex h-full min-h-0 flex-col">
      {waiting || running > 0 || finished > 0 ? <div className="flex h-7 shrink-0 items-center gap-2 px-3.5 text-label text-faint">
        {waiting ? (
          <span data-background-summary className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <HourglassIcon aria-hidden className="size-3 shrink-0" />
            <span className="truncate">Waiting on {waiting}</span>
          </span>
        ) : running > 0 ? (
          <span className="tabular text-muted-foreground">{running} running</span>
        ) : null}
        {finished > 0 ? <span className="tabular">{finished} finished</span> : null}
        {waiting && conversation ? (
          <button
            type="button"
            disabled={stopping}
            onClick={() => void acp.stopBackground(conversation)}
            className="pressable ml-auto shrink-0 px-1.5 py-0.5 text-label text-faint hover:bg-fill-hover hover:text-foreground disabled:opacity-40"
          >
            {stopping ? "Stopping" : "Stop all"}
          </button>
        ) : null}
      </div> : null}
      <div ref={scroller} data-sheet-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {children.length ? (
          <ApexFinsSection children={children} conversation={conversation} apexTitle={apexTitle} scroller={scroller} open={litChild} onOpen={onOpenChild} />
        ) : null}
        {children.length && (agents.length || unnamed) ? (
          <div className="flex h-7 items-end px-1.5 pb-1 text-label text-faint">In this turn</div>
        ) : null}
        {unnamed > 0 ? (
          <p className="px-2.5 py-2 text-label text-faint">
            {unnamed === 1 ? "1 more task runs" : `${unnamed} more tasks run`} that {provider ? harnessLabel(provider) : "the provider"} counts without naming.
          </p>
        ) : null}
        {agents.slice(0, visible).map((agent) => (
          <AgentRow key={`${agent.bindingId}:${agent.nativeId}`} agent={agent} conversation={conversation} transcript={transcripts} />
        ))}
        {agents.length > visible ? (
          <button
            type="button"
            className="pressable w-full px-3 py-2 text-left text-label text-faint hover:bg-fill-hover hover:text-muted-foreground"
            onClick={() => setVisible((count) => count + 40)}
          >
            Show more
          </button>
        ) : null}
        {roster?.limited ? (
          <p className="px-3 py-2 text-label text-faint">Some older entries are omitted.</p>
        ) : null}
      </div>
    </div>
  )
}

const marks = {
  working: "working",
  waiting: "waiting",
  completed: "complete",
  failed: "failed",
  canceled: "idle",
  unknown: "idle",
} satisfies Record<NativeAgent["state"]["kind"], ActivityState>

/** One entry. Rows are memoized on the entry's identity, which `reconcileRoster` keeps while it is unchanged. */
export const AgentRow = memo(function AgentRow({ agent, conversation, transcript = true }: { agent: NativeAgent; conversation?: string; transcript?: boolean }) {
  useHarnessIdentity()
  const [expanded, setExpanded] = useState(false)
  const [stopping, setStopping] = useState(false)
  const active = isActiveNativeAgent(agent)
  const work = agent.work ?? "agent"
  const said = activity(agent)
  const kind = workKind(agent)
  const facts = [
    kind,
    harnessLabel(agent.provider),
    agent.runsOn ? finTuningLine(agent.runsOn) : agent.model,
    agent.role,
    agent.usage?.toolUses !== undefined ? `${agent.usage.toolUses} ${agent.usage.toolUses === 1 ? "tool use" : "tool uses"}` : undefined,
    agent.usage?.tokens !== undefined ? `${formatTokens(agent.usage.tokens)} tokens` : undefined,
    agent.ambient ? "housekeeping, not counted as work" : undefined,
  ].filter(Boolean)
  const more = Boolean(agent.detail || agent.output || (said && said.length > 120))
  return (
    <article className="contain-turn group/agent relative" data-native-work={work} data-native-state={agent.state.kind}>
      <button
        type="button"
        aria-expanded={more ? expanded : undefined}
        className={cn("pressable flex w-full items-start gap-2.5 px-1.5 py-2 text-left transition-colors duration-100 hover:bg-fill-hover", agent.ambient && "opacity-70")}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="flex h-5 shrink-0 items-center text-muted-foreground">
          {active ? <WorkGlyph work={work} provider={agent.provider} className="size-3.5" /> : <ActivityMark state={marks[agent.state.kind]} />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex h-5 min-w-0 items-center gap-2">
            <span className={cn("min-w-0 flex-1 truncate text-ui font-medium text-foreground", work === "command" && !agent.title && "font-mono")}>
              {agent.title || agent.detail || kind}
            </span>
            <span className={cn("flex shrink-0 items-center gap-1.5 text-label", agent.state.kind === "failed" ? "text-negative" : "text-faint")}>
              {active ? <Shimmer text={labels[agent.state.kind]} /> : labels[agent.state.kind]}
              <Elapsed agent={agent} />
            </span>
            {more ? (
              <ChevronDownIcon className={cn("size-3 shrink-0 text-faint transition-transform duration-150", expanded && "rotate-180")} />
            ) : null}
          </span>
          {said ? (
            <span className={cn("text-ui leading-snug text-muted-foreground", expanded ? "break-words whitespace-pre-wrap" : "line-clamp-2")}>
              {said}
            </span>
          ) : null}
          {expanded && agent.detail ? (
            <span className="mt-1 max-h-40 overflow-y-auto bg-raised px-2 py-1.5 font-mono text-label break-words whitespace-pre-wrap text-muted-foreground">
              {agent.detail}
            </span>
          ) : null}
          {expanded && agent.output ? (
            <span data-native-output className="mt-1 max-h-56 overflow-y-auto bg-raised px-2 py-1.5 font-mono text-label break-words whitespace-pre-wrap text-muted-foreground">
              {agent.output}
            </span>
          ) : null}
          <span className="mt-0.5 flex flex-wrap gap-x-1.5 text-label text-faint">
            {facts.map((fact, index) => (
              <span key={`${index}:${fact}`}>
                {index > 0 ? <span aria-hidden className="mr-1.5 text-faint/50">·</span> : null}
                {fact}
              </span>
            ))}
          </span>
          {agent.runsOn?.rule ? (
            <span data-fin-rule-applied className="flex min-w-0 items-center gap-1 text-label text-faint" title={`Started by your rule: ${agent.runsOn.rule}`}>
              <SignpostIcon aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{agent.runsOn.rule}</span>
            </span>
          ) : null}
          <FinMovedLine agent={agent} />
          {agent.runsOn?.note ? (
            <span data-fin-fell-back className="line-clamp-2 text-label text-caution" title={agent.runsOn.note}>
              {agent.runsOn.note}
            </span>
          ) : null}
        </span>
      </button>
      {transcript && agent.child?.path && agent.child.nativeId ? (
        <button
          type="button"
          data-open-transcript
          onClick={() => openTranscript(agent)}
          className="pressable mb-1.5 ml-[2.375rem] px-1.5 py-0.5 text-label text-muted-foreground hover:bg-fill-hover hover:text-foreground"
        >
          Open transcript
        </button>
      ) : null}
      {active && agent.stoppable && conversation ? (
        <button
          type="button"
          aria-label={`Stop ${agent.title || kind}`}
          title="Stop this one; the rest keeps running"
          disabled={stopping}
          onClick={() => {
            setStopping(true)
            void acp.stopAgent(conversation, agent.nativeId).finally(() => setStopping(false))
          }}
          className="pressable absolute top-2 right-2 flex size-6 items-center justify-center bg-surface text-faint opacity-0 group-hover/agent:opacity-100 hover:bg-fill-hover hover:text-foreground focus-visible:opacity-100 disabled:opacity-40"
        >
          <SquareIcon className="size-2.5 fill-current" strokeWidth={0} />
        </button>
      ) : null}
    </article>
  )
})

/**
 * The composer's doorway to the Agents panel, there while the roster holds
 * anything. It counts what still runs, and wears the hourglass while the
 * turn has ended and that work is what the session waits on. An Apex's Fins
 * are their number and, when any needs the person, the needs pip; the whole
 * line is its name and tooltip.
 */
export function AgentsToggle() {
  useHarnessIdentity()
  const reading = useAcp((state) => {
    const live = activeLiveAcp(state)
    // Its provider's own work; its Fins are its Thread's (`conversationRoster`), whichever of its Sessions is on screen.
    const work = (live?.nativeAgents?.agents ?? []).filter((agent) => !agent.child)
    // An Apex's Fins say how they stand by the Thread's one rollup, as the crew card, the pips and the phone read it;
    // the rest of the roster counts as it runs.
    const children = live?.threadId ? threadRollup(state, live.threadId) : rollup(rosterChildren(live?.nativeAgents))
    const running = work.filter((agent) => isActiveNativeAgent(agent) && !agent.ambient)
    return {
      total: work.length + children.total,
      fins: children.total ? rollupChip(children) : "",
      finsLabel: children.total ? rollupLabel(children) : "",
      finsTotal: children.total,
      needs: children.needs,
      running: running.length,
      // The harnesses at work, as one string so a step elsewhere in the roster re-renders nothing.
      harnesses: [...new Set(running.filter((agent) => (agent.work ?? "agent") === "agent").map((agent) => agent.provider))].slice(0, SHOWN_MARKS).join(" "),
      waiting: Boolean(live && conversationWork(state, live)),
    }
  }, shallowEqual)
  if (!reading.total) return null
  const label = reading.fins || (reading.running ? `${reading.running} running` : `${reading.total} finished`)
  const marks = reading.harnesses && !reading.fins ? reading.harnesses.split(" ") : []
  return (
    <button
      type="button"
      data-agents-toggle
      data-fin-counts={reading.finsLabel || undefined}
      onClick={toggleAgentsPanel}
      aria-label={reading.fins || undefined}
      title={reading.finsLabel ? `${reading.finsLabel}; open the Agents panel` : reading.waiting ? "Background work the session waits on; open the Agents panel" : "Open the Agents panel"}
      className="pressable flex h-7 shrink-0 items-center gap-1.5 px-2 text-ui text-faint hover:bg-fill-hover hover:text-foreground"
    >
      {marks.length ? (
        <span className="flex items-center -space-x-1">
          {marks.map((harness) => (
            <span key={harness} className="flex size-4 items-center justify-center rounded-full bg-surface ring-1 ring-surface">
              <HarnessIcon harness={harness} className="size-3" />
            </span>
          ))}
        </span>
      ) : reading.fins ? (
        <ApexMark className="size-3" />
      ) : reading.waiting ? (
        <HourglassIcon className="size-3" />
      ) : (
        <GitBranchIcon className="size-3" />
      )}
      {reading.fins ? <span className="tabular">{reading.finsTotal}</span> : label}
      {reading.needs ? <span aria-hidden className="fin-pip" data-pip="needs" /> : null}
    </button>
  )
}

/** Harness marks the toggle shows at most, overlapped. */
const SHOWN_MARKS = 3

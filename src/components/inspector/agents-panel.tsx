import { useHarnessIdentity } from "@/lib/harness-label"
import { memo, useMemo, useState } from "react"
import { ChevronDownIcon, EyeIcon, GitBranchIcon, HourglassIcon, SquareIcon, WorkflowIcon } from "lucide-react"
import { acp, activeLiveAcp, useAcp } from "@/state/acp"
import { stage } from "@/state/stage"
import { shallowEqual } from "@/state/store"
import { useThreads } from "@/state/threads"
import { descriptorFor } from "@/state/descriptors"
import { capabilityText } from "@mako/host/contracts/harness-capabilities"
import { backgroundWork, backgroundWorkText } from "@mako/host/contracts/background-work"
import { isActiveNativeAgent, type NativeWork } from "@mako/host/contracts/native-agents"
import { durationText } from "@mako/sessions/events"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import { harnessLabel } from "@/components/rail/harness-meta"
import { ToolGlyph } from "@/components/transcript/tool-views"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { useSecondClock } from "@/components/ui/second-clock"
import { formatTokens } from "@/lib/format"
import { cn } from "@/lib/utils"
import { ActivityMark, type ActivityState } from "@/components/ui/activity-mark"
import { Blank } from "@/components/ui/kit"
import { Shimmer } from "@/components/ui/shimmer"
import type { NativeAgent, NativeAgentRoster } from "@/lib/types"

const labels = {
  working: "Running",
  waiting: "Waiting",
  completed: "Done",
  failed: "Failed",
  canceled: "Stopped",
  unknown: "Status unavailable",
} satisfies Record<NativeAgent["state"]["kind"], string>

const kinds = {
  agent: "Agent",
  workflow: "Workflow",
  command: "Command",
  monitor: "Monitor",
  task: "Task",
} satisfies Record<NativeWork, string>

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

/**
 * The kind's glyph, the one the transcript's tool rows and event lines use
 * for it. An agent's is the mark of the harness that runs it (`provider`),
 * as its row in the transcript shows it; the agent glyph only when none is known.
 */
export function WorkGlyph({ work, provider, className }: { work: NativeWork | undefined; provider?: string; className?: string }) {
  switch (work ?? "agent") {
    case "command":
      return <ToolGlyph kind="shell" className={className} />
    case "monitor":
      return <EyeIcon className={className} />
    case "workflow":
      return <WorkflowIcon className={className} />
    case "task":
      return <HourglassIcon className={className} />
    case "agent":
      return provider ? <HarnessIcon harness={provider} className={className} /> : <ToolGlyph kind="agent" className={className} />
  }
}

/** How long it has run, counting while it runs; one shared clock ticks every row. */
export function Elapsed({ agent, className }: { agent: NativeAgent; className?: string }) {
  const active = isActiveNativeAgent(agent)
  const now = useSecondClock(active)
  const start = agent.startedAt ?? agent.observedAt
  const end = active ? now : (agent.settledAt ?? agent.observedAt)
  const ms = agent.usage?.durationMs !== undefined && !active ? agent.usage.durationMs : end - start
  if (ms < 1_000) return null
  return <span className={cn("tabular shrink-0", className)}>{durationText(ms)}</span>
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
  const roster = useAcp((state) => (key ? activeLiveAcp(state)?.nativeAgents : undefined))
  const provider = useAcp((state) => (key ? activeLiveAcp(state)?.harness : undefined))
  const background = useAcp((state) => {
    const live = key ? activeLiveAcp(state) : undefined
    const work = live ? backgroundWork(live.session, live.nativeAgents) : null
    return { waiting: work ? backgroundWorkText(work) : undefined, unnamed: work?.unnamed ?? 0, stopping: live?.canceling ?? false }
  }, shallowEqual)
  return (
    <AgentRoster key={focus.identity} conversation={key ?? undefined} roster={roster} provider={provider} {...background} />
  )
}

function AgentRoster({
  conversation,
  roster,
  provider,
  waiting,
  unnamed,
  stopping,
}: {
  conversation?: string
  roster?: NativeAgentRoster
  provider?: string
  /** What the session waits on between turns, in words; absent while a turn runs or nothing does. */
  waiting?: string
  /** Work the provider counts without naming it. */
  unnamed: number
  stopping: boolean
}) {
  useHarnessIdentity()
  const [visible, setVisible] = useState(40)
  const capability = useThreads((state) => descriptorFor(state, provider)?.capabilities.nativeAgents)
  const agents = useMemo(() => ordered(roster?.agents ?? []), [roster])
  if (agents.length === 0 && !unnamed)
    return (
      <Blank
        icon={<GitBranchIcon />}
        title={!provider ? "No live conversation" : "Nothing running alongside"}
        body={
          !provider
            ? "Open a live conversation to follow the agents and background work it starts."
            : !capability || capability.state === "implemented"
              ? "Subagents, background commands and monitors the provider starts appear here with their progress and results."
              : `${harnessLabel(provider)} does not report its agents to Mako. ${capabilityText(capability)}`
        }
      />
    )
  const running = agents.filter((agent) => isActiveNativeAgent(agent) && !agent.ambient).length + unnamed
  const finished = agents.filter((agent) => !isActiveNativeAgent(agent)).length
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-hairline px-3 text-label text-faint">
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
            className="pressable ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-label text-faint hover:bg-fill-hover hover:text-foreground disabled:opacity-40"
          >
            {stopping ? "Stopping" : "Stop all"}
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
        {unnamed > 0 ? (
          <p className="px-2.5 py-2 text-label text-faint">
            {unnamed === 1 ? "1 more task runs" : `${unnamed} more tasks run`} that {provider ? harnessLabel(provider) : "the provider"} counts without naming.
          </p>
        ) : null}
        {agents.slice(0, visible).map((agent) => (
          <AgentRow key={`${agent.bindingId}:${agent.nativeId}`} agent={agent} conversation={conversation} />
        ))}
        {agents.length > visible ? (
          <button
            type="button"
            className="pressable w-full rounded-md px-3 py-2 text-left text-label text-faint hover:bg-fill-hover hover:text-muted-foreground"
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
export const AgentRow = memo(function AgentRow({ agent, conversation }: { agent: NativeAgent; conversation?: string }) {
  useHarnessIdentity()
  const [expanded, setExpanded] = useState(false)
  const [stopping, setStopping] = useState(false)
  const active = isActiveNativeAgent(agent)
  const work = agent.work ?? "agent"
  const said = activity(agent)
  const facts = [
    kinds[work],
    harnessLabel(agent.provider),
    agent.model,
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
        className={cn("pressable flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-100 hover:bg-fill-hover", agent.ambient && "opacity-70")}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="flex h-5 shrink-0 items-center text-muted-foreground">
          {active ? <WorkGlyph work={work} provider={agent.provider} className="size-3.5" /> : <ActivityMark state={marks[agent.state.kind]} />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex h-5 min-w-0 items-center gap-2">
            <span className={cn("min-w-0 flex-1 truncate text-ui font-medium text-foreground", work === "command" && !agent.title && "font-mono")}>
              {agent.title || agent.detail || kinds[work]}
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
            <span className="mt-1 max-h-40 overflow-y-auto rounded-md bg-raised px-2 py-1.5 font-mono text-label break-words whitespace-pre-wrap text-muted-foreground">
              {agent.detail}
            </span>
          ) : null}
          {expanded && agent.output ? (
            <span data-native-output className="mt-1 max-h-56 overflow-y-auto rounded-md bg-raised px-2 py-1.5 font-mono text-label break-words whitespace-pre-wrap text-muted-foreground">
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
        </span>
      </button>
      {active && agent.stoppable && conversation ? (
        <button
          type="button"
          aria-label={`Stop ${agent.title || kinds[work]}`}
          title="Stop this one; the rest keeps running"
          disabled={stopping}
          onClick={() => {
            setStopping(true)
            void acp.stopAgent(conversation, agent.nativeId).finally(() => setStopping(false))
          }}
          className="pressable absolute top-2 right-2 flex size-6 items-center justify-center rounded bg-surface text-faint opacity-0 group-hover/agent:opacity-100 hover:bg-fill-hover hover:text-foreground focus-visible:opacity-100 disabled:opacity-40"
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
 * turn has ended and that work is what the session waits on.
 */
export function AgentsToggle() {
  const reading = useAcp((state) => {
    const live = activeLiveAcp(state)
    const agents = live?.nativeAgents?.agents ?? []
    return {
      total: agents.length,
      running: agents.filter((agent) => isActiveNativeAgent(agent) && !agent.ambient).length,
      waiting: Boolean(live && backgroundWork(live.session, live.nativeAgents)),
    }
  }, shallowEqual)
  if (!reading.total) return null
  const label = reading.running ? `${reading.running} running` : `${reading.total} finished`
  return (
    <button
      type="button"
      onClick={() => stage.toggle("agents")}
      title={reading.waiting ? "Background work the session waits on; open the Agents panel" : "Open the Agents panel"}
      className="pressable flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-ui text-faint hover:bg-fill-hover hover:text-foreground"
    >
      {reading.waiting ? <HourglassIcon className="size-3" /> : <GitBranchIcon className="size-3" />}
      {label}
    </button>
  )
}

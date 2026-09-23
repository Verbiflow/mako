import { useState } from "react"
import { GitBranchIcon, ChevronDownIcon } from "lucide-react"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { stage } from "@/state/stage"
import { useThreads } from "@/state/threads"
import { descriptorFor } from "@/state/descriptors"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import { harnessLabel } from "@/components/rail/harness-meta"
import { formatTokens } from "@/lib/format"
import { cn } from "@/lib/utils"
import { ActivityMark, type ActivityState } from "@/components/ui/activity-mark"
import { Blank } from "@/components/ui/kit"
import type { NativeAgent, NativeAgentRoster } from "@/lib/types"

const labels = {
  working: "Working",
  waiting: "Waiting",
  completed: "Completed",
  failed: "Failed",
  canceled: "Stopped",
  unknown: "Status unavailable",
} satisfies Record<NativeAgent["state"]["kind"], string>
function activity(agent: NativeAgent): string {
  switch (agent.state.kind) {
    case "working":
      return agent.state.activity ?? "Working on the task"
    case "waiting":
      return agent.state.reason ?? "Waiting for the provider"
    case "completed":
      return agent.state.summary ?? "Task completed"
    case "failed":
      return agent.state.error
    case "unknown":
      return agent.state.reason
    case "canceled":
      return "Agent stopped"
  }
}

export function AgentsPanel() {
  const focus = useWorkspaceFocus()
  const roster = useAcp((state) =>
    focus.identity === `live:${state.activeKey}`
      ? activeLiveAcp(state)?.nativeAgents
      : undefined
  )
  const provider = useAcp((state) =>
    focus.identity === `live:${state.activeKey}`
      ? activeLiveAcp(state)?.harness
      : undefined
  )
  return (
    <AgentRoster key={focus.identity} roster={roster} provider={provider} />
  )
}

function AgentRoster({
  roster,
  provider,
}: {
  roster?: NativeAgentRoster
  provider?: string
}) {
  const [visible, setVisible] = useState(40)
  const supported = useThreads(
    (state) => descriptorFor(state, provider)?.observesNativeAgents === true
  )
  const agents = roster?.agents ?? []
  const working = agents.filter(
    (agent) => agent.state.kind === "working" || agent.state.kind === "waiting"
  ).length
  if (agents.length === 0)
    return (
      <Blank
        icon={<GitBranchIcon />}
        title={!provider ? "No live conversation" : "No agents yet"}
        body={
          !provider
            ? "Open a live conversation to follow the agents it starts."
            : supported
              ? "Agents the provider starts appear here with their progress and results."
              : `${harnessLabel(provider)} does not report its agents to Mako.`
        }
      />
    )
  const finished = agents.filter(
    (agent) => agent.state.kind === "completed"
  ).length
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-hairline px-3 text-label text-faint">
        <span className="tabular">
          {agents.length} {agents.length === 1 ? "agent" : "agents"}
        </span>
        {working > 0 ? (
          <span className="tabular text-muted-foreground">
            {working} working
          </span>
        ) : null}
        {finished > 0 ? <span className="tabular">{finished} done</span> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
        {agents.slice(0, visible).map((agent) => (
          <AgentRow key={`${agent.bindingId}:${agent.nativeId}`} agent={agent} />
        ))}
        {agents.length > visible ? (
          <button
            type="button"
            className="pressable w-full rounded-md px-3 py-2 text-left text-label text-faint hover:bg-fill-hover hover:text-muted-foreground"
            onClick={() => setVisible((count) => count + 40)}
          >
            Show more agents
          </button>
        ) : null}
        {roster?.limited ? (
          <p className="px-3 py-2 text-label text-faint">
            Some older agent observations are omitted.
          </p>
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

export function AgentRow({ agent }: { agent: NativeAgent }) {
  const [expanded, setExpanded] = useState(false)
  const facts = [
    harnessLabel(agent.provider),
    agent.model,
    agent.role,
    agent.usage?.tokens !== undefined
      ? `${formatTokens(agent.usage.tokens)} tokens`
      : undefined,
    agent.usage?.toolUses !== undefined
      ? `${agent.usage.toolUses} tools used`
      : undefined,
    agent.usage?.durationMs !== undefined
      ? `${Math.round(agent.usage.durationMs / 1000)} s elapsed`
      : undefined,
  ].filter(Boolean)
  return (
    <article className="contain-turn">
      <button
        type="button"
        aria-expanded={expanded}
        className="pressable flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-100 hover:bg-fill-hover"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="flex h-5 shrink-0 items-center text-muted-foreground">
          <ActivityMark state={marks[agent.state.kind]} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex h-5 min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-ui font-medium text-foreground">
              {agent.title}
            </span>
            <span
              className={cn(
                "shrink-0 text-label",
                agent.state.kind === "failed" ? "text-negative" : "text-faint"
              )}
            >
              {labels[agent.state.kind]}
            </span>
            <ChevronDownIcon
              className={cn(
                "size-3 shrink-0 text-faint transition-transform duration-150",
                expanded && "rotate-180"
              )}
            />
          </span>
          <span
            className={cn(
              "text-ui leading-snug text-muted-foreground",
              expanded ? "break-words whitespace-pre-wrap" : "line-clamp-2"
            )}
          >
            {activity(agent)}
          </span>
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
    </article>
  )
}

export function AgentsToggle() {
  const count = useAcp(
    (state) => activeLiveAcp(state)?.nativeAgents?.agents.length ?? 0
  )
  if (!count) return null
  return (
    <button
      type="button"
      onClick={() => stage.toggle("agents")}
      className="pressable flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-ui text-faint hover:bg-fill-hover hover:text-foreground"
    >
      <GitBranchIcon className="size-3" />
      {count} {count === 1 ? "agent" : "agents"}
    </button>
  )
}

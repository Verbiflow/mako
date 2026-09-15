import { useState } from "react"
import { GitBranchIcon, ChevronDownIcon } from "lucide-react"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { stage } from "@/state/stage"
import { useThreads } from "@/state/threads"
import { descriptorFor } from "@/state/descriptors"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import { harnessLabel } from "@/components/rail/harness-meta"
import { formatTokens } from "@/lib/format"
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
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-hairline px-4 py-3">
        <span className="text-ui font-medium">Agents</span>
        {working > 0 ? (
          <span className="text-label text-faint">{working} working</span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {agents.length === 0 ? (
          <p className="px-4 py-6 text-ui leading-relaxed text-faint">
            {!provider
              ? "Open a live conversation to view its agents."
              : supported
                ? "Agents started by the provider appear here with their progress and results."
                : "This provider does not report native agent activity to Mako."}
          </p>
        ) : (
          agents
            .slice(0, visible)
            .map((agent) => (
              <AgentRow
                key={`${agent.bindingId}:${agent.nativeId}`}
                agent={agent}
              />
            ))
        )}
        {agents.length > visible ? (
          <button
            type="button"
            className="pressable w-full px-4 py-3 text-ui text-faint hover:bg-fill-hover hover:text-foreground"
            onClick={() => setVisible((count) => count + 40)}
          >
            Show more agents
          </button>
        ) : null}
        {roster?.limited ? (
          <p className="px-4 py-3 text-label text-faint">
            Some older agent observations are omitted.
          </p>
        ) : null}
      </div>
    </div>
  )
}

export function AgentRow({ agent }: { agent: NativeAgent }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <article className="contain-turn flex flex-col gap-2 border-b border-hairline px-4 py-3">
      <button
        type="button"
        aria-expanded={expanded}
        className="pressable flex items-start gap-3 rounded text-left hover:text-foreground"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="min-w-0 flex-1 text-ui font-medium">
          {agent.title}
        </span>
        <span className="shrink-0 text-label text-faint">
          {labels[agent.state.kind]}
        </span>
        <ChevronDownIcon
          className={`mt-0.5 size-3 shrink-0 text-faint ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      <p
        className={`${expanded ? "break-words whitespace-pre-wrap" : "line-clamp-2"} min-h-10 text-ui text-muted-foreground`}
      >
        {activity(agent)}
      </p>
      <p className="flex min-h-4 flex-wrap gap-x-2 text-label text-faint">
        <span>{harnessLabel(agent.provider)}</span>
        {agent.model ? <span>{agent.model}</span> : null}
        {agent.role ? <span>{agent.role}</span> : null}
        {agent.usage?.tokens !== undefined ? (
          <span>{formatTokens(agent.usage.tokens)} tokens</span>
        ) : null}
        {agent.usage?.toolUses !== undefined ? (
          <span>{agent.usage.toolUses} tools used</span>
        ) : null}
        {agent.usage?.durationMs !== undefined ? (
          <span>{Math.round(agent.usage.durationMs / 1000)} s elapsed</span>
        ) : null}
      </p>
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

import { useMemo, useState } from "react"
import { ChevronRightIcon } from "lucide-react"
import type { ToolCall } from "@/extend/slots"
import type { NativeAgent } from "@/lib/types"
import { callEntryId } from "@/lib/entry-messages"
import { formatDuration } from "@/lib/format"
import { agentGroupWords, rosterStanding } from "@/lib/agent-groups"
import { subagentStanding } from "@/lib/tools"
import { cn } from "@/lib/utils"
import { observeVisibleAnimation } from "@/lib/visible-animation"
import { useAcp } from "@/state/acp"
import { ActivityMark } from "@/components/ui/activity-mark"
import { Collapse } from "@/components/ui/collapse"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { Ticking } from "@/components/ui/ticking"
import { useTranscriptSource } from "./source-context"
import { ToolRow } from "./tool-row"
import { ToolGlyph } from "./tool-views"

const EMPTY_AGENTS: readonly NativeAgent[] = []

/**
 * Agents the model started together, as one row: their harness marks, how
 * many still work and how the rest ended, and one clock from the first
 * start to the last finish. Each agent's standing is the roster's when the
 * roster lists its call, else what its call says. It opens onto each
 * agent's own row. As a running turn's newest step (`live`) its count
 * sweeps and it carries the turn's activity mark.
 */
export function AgentGroup({ calls, provider, live = false }: { calls: readonly ToolCall[]; provider?: string; live?: boolean }) {
  const [open, setOpen] = useState(false)
  const { liveId } = useTranscriptSource()
  // The roster arrives reconciled (`reconcileRoster`): its array changes only when an entry does.
  const roster = useAcp((state) => {
    const conversation = liveId ? state.conversations[liveId] : undefined
    return conversation?.nativeAgents?.agents ?? EMPTY_AGENTS
  })
  const members = useMemo(
    () =>
      calls.map((call) => {
        const native = callEntryId(call.id)
        const agent = roster.find((entry) => entry.toolId === native)
        return { call, agent, standing: (agent && rosterStanding(agent)) ?? subagentStanding(call) }
      }),
    [calls, roster]
  )
  const { title, counts } = agentGroupWords(members.map((member) => member.standing))
  const working = members.some((member) => member.standing === "working" || member.standing === "waiting")
  const starts = members.flatMap((member) => (member.agent?.startedAt !== undefined ? [member.agent.startedAt] : []))
  const began = starts.length ? Math.min(...starts) : undefined
  const ends = members.flatMap((member) => (member.agent?.settledAt !== undefined ? [member.agent.settledAt] : []))
  const ended = !working && ends.length === members.length ? Math.max(...ends) : undefined
  const marks = members.slice(0, 3).map((member) => member.agent?.provider ?? provider).filter((mark): mark is string => Boolean(mark))
  const layer = "absolute inset-0 m-auto size-3.5 [transition:opacity_150ms_var(--ease-out),transform_150ms_var(--ease-out)]"
  return (
    <div data-agent-group={calls.length}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn("pressable group/agents -mx-1.5 flex w-[calc(100%+12px)]", live ? "h-8" : "h-7", "min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-ui transition-colors duration-100 hover:bg-fill-hover")}
      >
        <span className="relative size-3.5 shrink-0">
          <ToolGlyph kind="agent" className={cn(layer, working ? "text-foreground/80" : "text-faint", open ? "opacity-0" : "group-hover/agents:opacity-0")} />
          <ChevronRightIcon aria-hidden className={cn(layer, "text-faint", open ? "rotate-90 opacity-100" : "opacity-0 group-hover/agents:opacity-100")} />
        </span>
        <span ref={live && working ? observeVisibleAnimation : undefined} className={cn("shrink-0", live && working ? "shimmer-text" : "text-muted-foreground")}>
          {title}
        </span>
        {marks.length ? (
          <span aria-hidden className="flex shrink-0 -space-x-1">
            {marks.map((mark, index) => (
              <span key={index} className="flex size-4.5 items-center justify-center rounded-full bg-raised ring-2 ring-surface">
                <HarnessIcon harness={mark} className="size-3" />
              </span>
            ))}
          </span>
        ) : null}
        <span className="min-w-0 truncate text-faint">
          {counts.map(({ word, count }, index) => (
            <span key={word} className={cn(word === "failed" && "text-negative")}>
              {index > 0 ? " · " : ""}
              {count} {word}
            </span>
          ))}
        </span>
        <span className="flex-1" />
        {began !== undefined ? (
          working ? (
            <Ticking words={(now) => formatDuration(now - began)} className="shrink-0 text-label text-faint" />
          ) : ended !== undefined ? (
            <span className="shrink-0 text-label text-faint tabular">{formatDuration(ended - began)}</span>
          ) : null
        ) : null}
        {working ? (
          <span role={live ? undefined : "status"} aria-label={live ? undefined : "Running"} className="shrink-0 text-muted-foreground">
            <ActivityMark state="executing" size={live ? 20 : undefined} />
          </span>
        ) : null}
      </button>
      <Collapse open={open}>
        <div className="mt-0.5 ml-[6.5px] border-l border-hairline pb-1 pl-4">
          {calls.map((call) => (
            <ToolRow key={call.id} call={call} />
          ))}
        </div>
      </Collapse>
    </div>
  )
}

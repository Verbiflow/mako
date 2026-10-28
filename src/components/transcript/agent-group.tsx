import { useContext, useMemo, useState } from "react"
import type { ToolCall } from "@/extend/slots"
import type { NativeAgent } from "@/lib/types"
import { callEntryId } from "@/lib/entry-messages"
import { formatDuration } from "@/lib/format"
import { agentGroupWords, rosterStanding } from "@/lib/agent-groups"
import { subagentStanding } from "@/lib/tools"
import { cn } from "@/lib/utils"
import { useAcp } from "@/state/acp"
import { Collapse } from "@/components/ui/collapse"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { Shimmer } from "@/components/ui/shimmer"
import { HarnessContext, TurnRunningContext, useTranscriptSource } from "./source-context"
import { AgentMark, LeadSlot, RunningFor, ToolRow } from "./tool-row"

const EMPTY_AGENTS: readonly NativeAgent[] = []

/**
 * Agents the model started together, as one row, drawn as any other row of
 * the work: in front, the mark of the harness that runs them; then while
 * any still works and the turn runs, "Running 4 agents" under the sweep,
 * the group's only running signal, and how the rest ended ("1 done"); once
 * none works, "4 agents" and how each ended. A minute in, how long they
 * have run ("for 2m"); settled, from the first start to the last finish.
 * When the agents run on more than one harness, each harness's mark stands
 * after the words. Each agent's standing is the roster's when the roster
 * lists its call, else what its call says. It opens onto each agent's own
 * row, named by what it was asked to do, with its harness's mark.
 */
export function AgentGroup({ calls, provider }: { calls: readonly ToolCall[]; provider?: string }) {
  const [open, setOpen] = useState(false)
  const { liveId } = useTranscriptSource()
  const turnRunning = useContext(TurnRunningContext)
  const answering = useContext(HarnessContext)
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
  const running = working && turnRunning
  const starts = members.flatMap((member) => (member.agent?.startedAt ?? member.call.startedAt) ?? [])
  const began = starts.length ? Math.min(...starts) : undefined
  const ends = members.flatMap((member) => (member.agent?.settledAt ?? member.call.endedAt) ?? [])
  const ended = !working && ends.length === members.length ? Math.max(...ends) : undefined
  const harnesses = [...new Set(members.map((member) => member.agent?.provider ?? provider ?? answering).filter((each): each is string => Boolean(each)))]
  // While they run, "working" is the title's own word; the counts say how the rest ended.
  const shown = running ? counts.filter((count) => count.word !== "working") : counts
  return (
    <div data-agent-group={calls.length}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="pressable group/row -mx-1.5 flex h-7 w-[calc(100%+12px)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-ui transition-colors duration-100 hover:bg-fill-hover"
      >
        <LeadSlot open={open} glyph={<AgentMark harness={harnesses[0]} className={cn("size-3.5", working ? "text-foreground/80" : "text-faint")} />} />
        {running ? <Shimmer text={`Running ${title}`} className="shrink-0" /> : <span className="shrink-0 text-muted-foreground">{title}</span>}
        {harnesses.length > 1 ? (
          <span aria-label={`On ${harnesses.length} harnesses`} className="flex shrink-0 items-center gap-1">
            {harnesses.map((harness) => (
              <HarnessIcon key={harness} harness={harness} className="size-3" />
            ))}
          </span>
        ) : null}
        {shown.length ? (
          <span className="min-w-0 truncate text-faint">
            {shown.map(({ word, count }, index) => (
              <span key={word} className={cn(word === "failed" && "text-negative")}>
                {index > 0 ? " · " : ""}
                {count} {word}
              </span>
            ))}
          </span>
        ) : null}
        {running && began !== undefined ? <RunningFor since={began} /> : null}
        <span className="flex-1" />
        {began !== undefined && ended !== undefined ? <span className="shrink-0 text-label text-faint tabular">{formatDuration(ended - began)}</span> : null}
      </button>
      <Collapse open={open}>
        <div className="flex flex-col">
          {calls.map((call) => (
            <ToolRow key={call.id} call={call} />
          ))}
        </div>
      </Collapse>
    </div>
  )
}

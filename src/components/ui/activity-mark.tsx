import type { OrbState, OrbSize } from "thinking-orbs"
import { Orb } from "@/components/ui/orb/orb"
import { CheckIcon, CircleAlertIcon, EllipsisIcon, PauseIcon, SearchIcon, PencilIcon, TerminalIcon, BrainIcon, TextCursorInputIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AgentActivityKind } from "@/state/agent-activity"

export type ActivityState = AgentActivityKind

/**
 * Work in progress that names no step: the agent between steps, or a turn
 * Mako can only say is "Working". An ellipsis, still, the way a sentence that
 * isn't finished reads: what moves is the sweep over the words beside it,
 * never the mark. Every place that says "working" without an orb draws this.
 */
export const WorkingIcon = EllipsisIcon

const orbStates = {
  working: "working", connecting: "connecting", reasoning: "solving",
  searching: "searching", executing: "weaving", editing: "shaping", responding: "composing",
  waiting: null, failed: null, complete: null, idle: null,
} satisfies Record<ActivityState, OrbState | null>

export function ActivityMark({ className, state = "working", size }: { className?: string; state?: ActivityState; size?: OrbSize }) {
  const orb = orbStates[state]
  if (size && orb)
    return <ThinkingActivity state={orb} kind={state} size={size} className={className} />
  return (
    <span data-state={state} aria-hidden className={cn("activity-mark", size === 64 && "activity-detail", size === 20 && "activity-inline", className)}>
      {state === "failed" ? <CircleAlertIcon />
        : state === "waiting" ? <PauseIcon />
        : state === "complete" ? <CheckIcon />
        : state === "searching" ? <SearchIcon />
        : state === "editing" ? <PencilIcon />
        : state === "executing" ? <TerminalIcon />
        : state === "reasoning" ? <BrainIcon />
        : state === "responding" ? <TextCursorInputIcon />
        : state === "idle" ? <span className="activity-idle" />
        : <WorkingIcon />}
    </span>
  )
}

function ThinkingActivity({ state, kind, size, className }: { state: OrbState; kind: ActivityState; size: OrbSize; className?: string }) {
  return <Orb state={state} size={size} data-size={size} data-state={kind} className={className} />
}

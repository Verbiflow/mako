import type { OrbState, OrbSize } from "thinking-orbs"
import { Orb } from "@/components/ui/orb/orb"
import { CheckIcon, CircleAlertIcon, PauseIcon, SearchIcon, PencilIcon, TerminalIcon, BrainIcon, TextCursorInputIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AgentActivityKind } from "@/state/agent-activity"

export type ActivityState = AgentActivityKind

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
        : <span className="activity-meter"><i /><i /><i /></span>}
    </span>
  )
}

function ThinkingActivity({ state, kind, size, className }: { state: OrbState; kind: ActivityState; size: OrbSize; className?: string }) {
  return <Orb state={state} size={size} data-size={size} data-state={kind} className={className} />
}

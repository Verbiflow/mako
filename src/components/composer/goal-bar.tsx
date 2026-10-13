import { useState } from "react"
import { ChevronDownIcon, TargetIcon } from "lucide-react"
import type { ConversationGoal, GoalCommand } from "@mako/host/contracts/live-goals"
import { Chip, Meter } from "@/components/ui/kit"
import { acp, activeAcp, useAcp } from "@/state/acp"
import { useThreads } from "@/state/threads"
import { formatTokens } from "@/lib/format"
import { harnessLabel } from "@/lib/harness-label"
import { cn } from "@/lib/utils"

const STATUS = {
  active: { label: "Working", tone: "neutral" },
  paused: { label: "Paused", tone: "neutral" },
  blocked: { label: "Needs you", tone: "caution" },
  complete: { label: "Done", tone: "positive" },
  "budget-limited": { label: "Out of budget", tone: "caution" },
  "usage-limited": { label: "Usage limit reached", tone: "caution" },
} as const satisfies Record<ConversationGoal["status"], { label: string; tone: "neutral" | "positive" | "negative" | "caution" }>

const PENDING = {
  set: "Setting…",
  pause: "Pausing…",
  resume: "Resuming…",
  clear: "Clearing…",
} satisfies Record<NonNullable<ConversationGoal["pending"]>, string>

/** The goal of the conversation the composer sends to, with what the user can do about it. */
export function GoalBar() {
  const key = useAcp((state) => activeAcp(state)?.key)
  const goal = useAcp((state) => activeAcp(state)?.goal)
  const harness = useAcp((state) => activeAcp(state)?.harness)
  const livePath = useAcp((state) => activeAcp(state)?.threadPath)
  const viewingPath = useThreads((state) => state.opening?.ref.path ?? state.viewing?.ref.path)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!key || !goal || (viewingPath && viewingPath !== livePath)) return null

  async function send(command: GoalCommand) {
    setBusy(true)
    try {
      await acp.goal(command, key)
    } finally {
      setBusy(false)
    }
  }

  const status = STATUS[goal.status]
  const keeper = goal.by === "harness" && harness
    ? `${harnessLabel(harness)} keeps working toward this goal until it's met.`
    : "Mako continues the conversation after each turn until this goal is met."
  const spent = goal.tokensUsed ?? 0
  const details = [
    goal.turns ? `${goal.turns} ${goal.turns === 1 ? "turn" : "turns"}` : undefined,
    goal.tokenBudget
      ? `${spent.toLocaleString()} of ${goal.tokenBudget.toLocaleString()} tokens`
      : goal.tokensUsed ? `${formatTokens(goal.tokensUsed)} tokens` : undefined,
    goal.seconds ? formatDuration(goal.seconds) : undefined,
  ].filter(Boolean).join(" · ")
  // With a budget, the row keeps to the count against it so the objective has the room.
  const progress = goal.tokenBudget ? `${formatTokens(spent)} / ${formatTokens(goal.tokenBudget)}` : details
  const share = goal.tokenBudget ? spent / goal.tokenBudget : 0
  const note = goal.note ?? (goal.status === "budget-limited" && goal.tokenBudget
    ? `It spent its ${formatTokens(goal.tokenBudget)}-token budget. To keep going, set the goal again with a larger budget.`
    : undefined)
  const disabled = busy || Boolean(goal.pending)
  const canPause = goal.status === "active"
  const canResume = goal.status === "paused" || goal.status === "blocked" || goal.status === "usage-limited"

  return (
    <section aria-label="Goal" data-goal-status={goal.status} className="shrink-0 border-b border-hairline bg-raised/40">
      <div className="flex h-8 items-center gap-2 px-3 text-label text-faint">
        <TargetIcon className={cn("size-3.5 shrink-0", goal.status === "active" && !goal.pending && "text-foreground")} aria-hidden />
        <span className="shrink-0 font-medium text-muted-foreground" title={keeper}>Goal</span>
        <Chip tone={goal.pending ? "neutral" : status.tone} className="shrink-0">
          {goal.pending ? PENDING[goal.pending] : status.label}
        </Chip>
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "Show less of the goal" : "Show the whole goal"}
          onClick={() => setExpanded(!expanded)}
          className="pressable flex min-w-0 flex-1 items-center gap-1 rounded px-1 text-left text-ui text-muted-foreground hover:text-foreground"
        >
          <span className="truncate">{goal.objective}</span>
          <ChevronDownIcon className={cn("size-3 shrink-0", expanded && "rotate-180")} aria-hidden />
        </button>
        {progress ? (
          <span className="hidden shrink-0 items-center gap-1.5 tabular-nums sm:flex" title={details}>
            {goal.tokenBudget ? (
              <Meter
                value={share}
                tone={goal.status === "budget-limited" || share >= 0.9 ? "caution" : "neutral"}
                className="w-10"
              />
            ) : null}
            {progress}
          </span>
        ) : null}
        <div className="flex shrink-0 items-center gap-0.5">
          {canPause ? <GoalButton disabled={disabled} onClick={() => void send({ kind: "pause" })}>Pause</GoalButton> : null}
          {canResume ? <GoalButton disabled={disabled} onClick={() => void send({ kind: "resume" })}>Resume</GoalButton> : null}
          <GoalButton disabled={disabled} onClick={() => void send({ kind: "clear" })}>
            {goal.status === "complete" ? "Dismiss" : "Clear"}
          </GoalButton>
        </div>
      </div>
      {expanded || (note && goal.status !== "active") ? (
        <div className="space-y-1 px-3 pb-2 pl-8.5 text-label">
          {expanded ? <p className="text-ui leading-relaxed whitespace-pre-wrap text-muted-foreground">{goal.objective}</p> : null}
          {note ? <p className={cn("leading-relaxed whitespace-pre-wrap text-faint", !expanded && "line-clamp-2")}>{note}</p> : null}
          {expanded && details ? <p className="text-faint tabular-nums">{details}</p> : null}
          {expanded ? <p className="text-faint">{keeper}</p> : null}
        </div>
      ) : null}
    </section>
  )
}

function GoalButton({ disabled, onClick, children }: { disabled: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="pressable h-6 rounded px-2 text-label text-muted-foreground hover:bg-fill-hover hover:text-foreground disabled:opacity-40"
    >
      {children}
    </button>
  )
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

import { z } from "zod"
import { GOAL_OBJECTIVE_LIMIT, type GoalObservation, type GoalStatus } from "../../contracts/live-goals.js"
import type { JsonObject } from "../../contracts/json.js"

/** Grok's goal statuses (grok 1.0.46); `cleared` is the update that says it has none. */
const GrokGoalStatus = z.enum(["active", "user_paused", "back_off_paused", "no_progress_paused", "infra_paused", "interrupted", "blocked", "failed", "budget_limited", "complete", "cleared"])

const GROK_GOAL_STATUS = {
  active: "active",
  user_paused: "paused",
  back_off_paused: "paused",
  no_progress_paused: "paused",
  infra_paused: "paused",
  interrupted: "paused",
  blocked: "blocked",
  failed: "blocked",
  budget_limited: "budget-limited",
  complete: "complete",
  cleared: null,
} satisfies Record<z.infer<typeof GrokGoalStatus>, GoalStatus | null>

const count = z.number().int().nonnegative().nullish()
const words = z.string().nullish()

/** `goal_updated`, recorded from grok 1.0.46 (`scripts/test-grok-goal-live.ts`). */
const GoalUpdated = z.object({
  objective: z.string(),
  status: GrokGoalStatus,
  tokens_used: count,
  token_budget: count,
  elapsed_ms: count,
  total_worker_rounds: count,
  pause_message: words,
  /** While active, the evidence Grok's evaluator gave after the last round: what is left, or why it looks done. */
  last_event_detail: words,
})

/** The goal a `goal_updated` describes; undefined when its shape or status is one Mako doesn't know. */
export function grokGoal(update: JsonObject): GoalObservation | null | undefined {
  const parsed = GoalUpdated.safeParse(update)
  if (!parsed.success) return undefined
  const goal = parsed.data
  const status = GROK_GOAL_STATUS[goal.status]
  const objective = goal.objective.trim().slice(0, GOAL_OBJECTIVE_LIMIT)
  if (!status || !objective) return null
  const note = (status === "active" ? goal.last_event_detail : goal.pause_message)?.trim().slice(0, 4_000)
  return {
    objective,
    status,
    turns: goal.total_worker_rounds || undefined,
    tokensUsed: goal.tokens_used ?? undefined,
    tokenBudget: goal.token_budget || undefined,
    seconds: goal.elapsed_ms == null ? undefined : Math.round(goal.elapsed_ms / 1000),
    note: note || undefined,
  }
}

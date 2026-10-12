import { z } from "zod"
import type { GoalObservation } from "../../contracts/live-goals.js"
import type { ThreadGoalStatus } from "./generated/v2/ThreadGoalStatus.js"

const CodexGoalStatusSchema = z.enum(["active", "paused", "blocked", "complete", "budgetLimited", "usageLimited"]) satisfies z.ZodType<ThreadGoalStatus>

const CODEX_GOAL_STATUS = {
  active: "active",
  paused: "paused",
  blocked: "blocked",
  complete: "complete",
  budgetLimited: "budget-limited",
  usageLimited: "usage-limited",
} as const satisfies Record<ThreadGoalStatus, GoalObservation["status"]>

/** `ThreadGoal` from the app-server's v2 protocol. */
export const CodexThreadGoalSchema = z.object({
  threadId: z.string(),
  objective: z.string(),
  status: CodexGoalStatusSchema,
  tokenBudget: z.number().nonnegative().nullish(),
  tokensUsed: z.number().nonnegative(),
  timeUsedSeconds: z.number().nonnegative(),
})
export type CodexThreadGoal = z.infer<typeof CodexThreadGoalSchema>

export const CodexGoalSetResultSchema = z.object({ goal: CodexThreadGoalSchema })
export const CodexGoalClearResultSchema = z.object({ cleared: z.boolean() })

export function codexGoalObservation(goal: CodexThreadGoal): GoalObservation {
  return {
    objective: goal.objective,
    status: CODEX_GOAL_STATUS[goal.status],
    tokensUsed: goal.tokensUsed,
    tokenBudget: goal.tokenBudget ?? undefined,
    seconds: goal.timeUsedSeconds,
  }
}

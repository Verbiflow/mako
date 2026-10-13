import type { ConversationGoal, GoalCommand, StartGoal } from "@mako/host/contracts/live-goals"
import { GOAL_OBJECTIVE_LIMIT, readTokenCount } from "@mako/host/contracts/live-goals"
import { descriptorFor } from "@/state/descriptors"
import { threadsStore } from "@/state/thread-store"

/** `/goal` and the words after it, as the composer's own command. */
const GOAL_LINE = /^\/goal(?:\s+([\s\S]*))?$/

/** `--budget 200k` or `--budget=200k` closing the objective. */
const BUDGET = /\s+--budget(?:[=\s]+(\S*))?\s*$/i

export type GoalLine =
  | GoalCommand
  | { kind: "empty" }
  | { kind: "too-long"; length: number }
  | { kind: "bad-budget"; written: string }

/**
 * What a draft asks of the goal, or null when it is an ordinary message.
 * `pause`, `resume` and `clear` alone are those commands; any other words
 * are the objective, whichever harness keeps the goal, and a closing
 * `--budget` is the tokens it may spend.
 */
export function readGoalLine(draft: string): GoalLine | null {
  const match = GOAL_LINE.exec(draft.trim())
  if (!match) return null
  let words = match[1]?.trim() ?? ""
  const command = words.toLowerCase()
  if (command === "pause" || command === "resume" || command === "clear") return { kind: command }
  const budget = BUDGET.exec(` ${words}`)
  const written = budget?.[1] ?? ""
  const tokenBudget = budget ? readTokenCount(written) : undefined
  if (budget) words = ` ${words}`.slice(0, budget.index).trim()
  if (!words) return { kind: "empty" }
  if (budget && tokenBudget === undefined) return { kind: "bad-budget", written }
  if (words.length > GOAL_OBJECTIVE_LIMIT) return { kind: "too-long", length: words.length }
  return tokenBudget === undefined ? { kind: "set", objective: words } : { kind: "set", objective: words, tokenBudget }
}

/** Whose goal a harness's conversations get: its own, or Mako's loop. */
export function goalKeeper(harness: string): ConversationGoal["by"] {
  const goals = descriptorFor(threadsStore.get(), harness)?.features.goals.mako
  return goals?.state === "implemented" && goals.through === "harness" ? "harness" : "mako"
}

/** The goal a starting conversation shows until its harness takes it. */
export function startingGoal(goal: StartGoal, by: ConversationGoal["by"], now: number): ConversationGoal {
  return { ...goal, status: "active", by, setAt: now, updatedAt: now, pending: "set" }
}

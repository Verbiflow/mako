import type { ConversationGoal, GoalCommand } from "@mako/host/contracts/live-goals"
import { GOAL_OBJECTIVE_LIMIT } from "@mako/host/contracts/live-goals"
import { descriptorFor } from "@/state/descriptors"
import { threadsStore } from "@/state/thread-store"

/** `/goal` and the words after it, as the composer's own command. */
const GOAL_LINE = /^\/goal(?:\s+([\s\S]*))?$/

export type GoalLine = GoalCommand | { kind: "empty" } | { kind: "too-long"; length: number }

/**
 * What a draft asks of the goal, or null when it is an ordinary message.
 * `pause`, `resume` and `clear` alone are those commands; any other words
 * are the objective, whichever harness keeps the goal.
 */
export function readGoalLine(draft: string): GoalLine | null {
  const match = GOAL_LINE.exec(draft.trim())
  if (!match) return null
  const words = match[1]?.trim() ?? ""
  if (!words) return { kind: "empty" }
  const command = words.toLowerCase()
  if (command === "pause" || command === "resume" || command === "clear") return { kind: command }
  if (words.length > GOAL_OBJECTIVE_LIMIT) return { kind: "too-long", length: words.length }
  return { kind: "set", objective: words }
}

/** Whose goal a harness's conversations get: its own, or Mako's loop. */
export function goalKeeper(harness: string): ConversationGoal["by"] {
  const goals = descriptorFor(threadsStore.get(), harness)?.features.goals.mako
  return goals?.state === "implemented" && goals.through === "harness" ? "harness" : "mako"
}

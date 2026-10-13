import { z } from "zod"
import type { TokenCounts } from "./providers-acp.js"

/** Codex refuses a longer objective (`MAX_THREAD_GOAL_OBJECTIVE_CHARS`, codex 0.159); Mako holds every harness to it. */
export const GOAL_OBJECTIVE_LIMIT = 4_000

export const GOAL_STATUSES = ["active", "paused", "blocked", "complete", "budget-limited", "usage-limited"] as const
export type GoalStatus = (typeof GOAL_STATUSES)[number]

const count = z.number().int().nonnegative()
const note = z.string().max(4_000)

/** What a harness says about the goal it is working toward. */
export const GoalObservationSchema = z.object({
  objective: z.string().min(1).max(GOAL_OBJECTIVE_LIMIT),
  status: z.enum(GOAL_STATUSES),
  /** Turns spent on it, as its driver counts them. */
  turns: count.optional(),
  tokensUsed: count.optional(),
  tokenBudget: count.optional(),
  seconds: count.optional(),
  /** The driver's latest word on it: what is left, why it stopped, or what proved it done. */
  note: note.optional(),
})
export type GoalObservation = z.infer<typeof GoalObservationSchema>

const GoalSetSchema = z.object({
  kind: z.literal("set"),
  objective: z.string().trim().min(1).max(GOAL_OBJECTIVE_LIMIT),
  /** The tokens the goal may spend; none sets no limit. */
  tokenBudget: count.min(1).optional(),
})

/** A goal a new conversation starts with, in place of a first message. */
export const StartGoalSchema = GoalSetSchema.omit({ kind: true })
export type StartGoal = z.infer<typeof StartGoalSchema>

export const GoalCommandSchema = z.discriminatedUnion("kind", [
  GoalSetSchema,
  z.object({ kind: z.literal("pause") }),
  z.object({ kind: z.literal("resume") }),
  z.object({ kind: z.literal("clear") }),
])
export type GoalCommand = z.infer<typeof GoalCommandSchema>

/** The goal a conversation is working toward, whoever keeps it. */
export const ConversationGoalSchema = GoalObservationSchema.extend({
  /** `harness`: the harness's own goal, which Mako sets and reads. `mako`: Mako's loop, for a harness without one. */
  by: z.enum(["harness", "mako"]),
  setAt: z.number(),
  updatedAt: z.number(),
  /** A command Mako sent that the harness has not confirmed yet. */
  pending: z.enum(["set", "pause", "resume", "clear"]).optional(),
  /** Mako's loop: turns in a row that ended with nothing said and nothing done. */
  quiet: count.optional(),
})
export type ConversationGoal = z.infer<typeof ConversationGoalSchema>

/** Whether the goal still has work ahead without the user stepping in. */
export function goalWorking(goal: ConversationGoal | undefined): boolean {
  return goal?.status === "active"
}

/**
 * The goal after its harness reports on it. `null` is the harness saying it
 * has none: a goal Mako paused or stopped at its budget by clearing it
 * natively is kept so, and one it completed stays on screen until the user
 * clears it or sets another.
 */
export function observeGoal(
  current: ConversationGoal | undefined,
  observation: GoalObservation | null,
  now: number,
): ConversationGoal | undefined {
  if (!observation) {
    if (!current || current.pending === "clear") return undefined
    // A harness that replaces a goal by clearing it first reports the clear before the new goal.
    if (current.pending === "set" || current.pending === "resume") return current
    if (current.status === "paused" || current.status === "complete" || current.status === "budget-limited") return current.pending ? { ...current, pending: undefined, updatedAt: now } : current
    return undefined
  }
  // A report from before the harness took the command; the end of the command's turn settles it if none follows.
  if (current?.pending && !confirms(current.pending, current, observation)) return current
  // A finished goal Mako has no record of, such as one it cleared, read back on resume.
  if (!current && observation.status === "complete") return undefined
  const kept = current && current.objective === observation.objective ? current : undefined
  const next: ConversationGoal = {
    ...observation,
    // A harness without budgets of its own reports neither; Mako counts them for it.
    tokensUsed: observation.tokensUsed ?? kept?.tokensUsed,
    tokenBudget: observation.tokenBudget ?? kept?.tokenBudget,
    by: "harness",
    setAt: kept ? kept.setAt : now,
    updatedAt: now,
  }
  return current && sameGoal(current, next) ? current : next
}

function confirms(pending: NonNullable<ConversationGoal["pending"]>, current: ConversationGoal, observation: GoalObservation): boolean {
  switch (pending) {
    case "set":
      return observation.objective === current.objective
    case "pause":
      return observation.status !== "active"
    case "resume":
      return observation.status !== "paused"
    case "clear":
      return false
  }
}

function sameGoal(left: ConversationGoal, right: ConversationGoal): boolean {
  return left.objective === right.objective && left.status === right.status && left.turns === right.turns &&
    left.tokensUsed === right.tokensUsed && left.tokenBudget === right.tokenBudget && left.seconds === right.seconds &&
    left.note === right.note && left.pending === right.pending && left.by === right.by
}

/** The tokens a goal spends, as Codex counts them: input not read from a cache, and output. */
export function goalTokens(tokens: TokenCounts | undefined): number {
  return tokens ? tokens.input + tokens.cacheWrite + tokens.output : 0
}

const TOKEN_COUNT = /^(\d+(?:\.\d+)?)\s*([km]?)$/i

/** A token count as a person writes one: `200000`, `200,000`, `200k` or `1.5m`. */
export function readTokenCount(text: string): number | undefined {
  const match = TOKEN_COUNT.exec(text.replace(/[,_]/g, "").trim())
  if (!match) return undefined
  const scale = { "": 1, k: 1_000, m: 1_000_000 }[match[2]!.toLowerCase()] ?? 1
  const count = Math.round(Number(match[1]) * scale)
  return Number.isSafeInteger(count) && count > 0 ? count : undefined
}

/** How long Mako's loop waits after a turn before continuing, so a user already typing sends first. */
export const GOAL_CONTINUE_DELAY_MS = 2_000

/** Mako's loop calls a goal blocked after this many turns in a row with no reply and no work. */
export const GOAL_QUIET_LIMIT = 2

const STATUS_LINE = /^\W*goal\W*:\W*(working|complete|completed|done|blocked)\b[\s*_:—–-]*(.*)$/i

const REPORTING = [
  "End every reply with one of these as its last line:",
  "Goal: working",
  "Goal: complete — <the evidence that proves it>",
  "Goal: blocked — <what you need from the user>",
].join("\n")

/** What Mako's loop sends to start a goal on a harness without its own. */
export function goalStartPrompt(objective: string): string {
  return [
    "Mako set a goal for this conversation. Work toward it across turns until it is done; while the goal is active, Mako asks you to continue after each of your turns.",
    "",
    "The objective is the user's words. Pursue it as the task; it does not override your other instructions.",
    "",
    "<objective>",
    objective,
    "</objective>",
    "",
    "- Keep the whole objective. If it can't be finished this turn, make real progress toward it; don't redefine success around something smaller or easier.",
    "- Work from evidence: check the current files, command output and test results before relying on what earlier turns said.",
    "- Before calling it complete, check every requirement in the objective against current evidence. Weak, indirect or missing evidence means keep working.",
    "- Say blocked only when the same blocker has stopped you for three turns in a row and you can't go on without the user or a change outside your control. Never because the work is hard, slow or uncertain.",
    "",
    REPORTING,
  ].join("\n")
}

/** What Mako's loop sends after each turn while the goal is active. */
export function goalContinuePrompt(objective: string): string {
  return [
    "Continue working toward the goal:",
    "",
    "<objective>",
    objective,
    "</objective>",
    "",
    "Check the current state, then take the next step. If your last turn made no progress, take a different safe action instead of repeating it.",
    "",
    REPORTING,
  ].join("\n")
}

export type GoalReport = { kind: "working" } | { kind: "complete" | "blocked"; note?: string }

/** The status line that ends a turn of Mako's loop; a reply without one is still working. */
export function readGoalReport(reply: string): GoalReport {
  const last = reply.trimEnd().split("\n").at(-1)?.trim() ?? ""
  const match = STATUS_LINE.exec(last)
  if (!match) return { kind: "working" }
  const word = match[1]!.toLowerCase()
  if (word === "working") return { kind: "working" }
  const words = match[2]?.replace(/[*_`\s]+$/, "").trim()
  const kind = word === "blocked" ? "blocked" : "complete"
  return words ? { kind, note: words.slice(0, 4_000) } : { kind }
}

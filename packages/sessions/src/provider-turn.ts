/**
 * Turns a provider starts on its own.
 *
 * Claude Code, Grok and OpenCode start a turn when background work finishes,
 * with no prompt from anyone. Each reports the cause: Claude in the summary of
 * its task notification, Grok in a task snapshot, OpenCode in a synthetic
 * message. Mako shows that cause where a prompt would stand, in the same
 * wording for all of them.
 */

import type { TurnCause } from "./events.js"

/**
 * A turn's cause: the provider's sentence, what settled when there is
 * structure behind it, and what the work left to read (an agent's report, a
 * command's last output, a monitor's event) as markdown the line opens onto.
 */
export interface ProviderTurnCause {
  reason: string
  cause?: TurnCause
  body?: string
}

/** The most of a body a turn's cause keeps: a long agent report whole, never a log. */
export const CAUSE_BODY_LIMIT = 48_000

/** `text` cut to `CAUSE_BODY_LIMIT` at a line, saying so, or `undefined` when there's nothing to read. */
export function causeBody(text: string | undefined): string | undefined {
  const whole = text?.trim()
  if (!whole) return undefined
  if (whole.length <= CAUSE_BODY_LIMIT) return whole
  const cut = whole.lastIndexOf("\n", CAUSE_BODY_LIMIT)
  return `${whole.slice(0, cut > CAUSE_BODY_LIMIT / 2 ? cut : CAUSE_BODY_LIMIT).trimEnd()}\n\n…`
}

/** How much of a command's output a turn's cause keeps: its end. */
export const OUTPUT_TAIL_BYTES = 8 * 1024
const OUTPUT_TAIL_LINES = 40

const ESCAPE = String.fromCharCode(27)
const BELL = String.fromCharCode(7)
/** Cursor movement and colour (CSI) and window titles (OSC), which a terminal draws and a reader would see as noise. */
const TERMINAL_CODES = new RegExp(`${ESCAPE}\\[[0-?]*[ -/]*[@-~]|${ESCAPE}\\][^${BELL}${ESCAPE}]*(?:${BELL}|${ESCAPE}\\\\)`, "g")

/**
 * The last lines of a command's output as a person reads them: at most its
 * last 8 KB and 40 lines, starting at a whole line, without terminal codes,
 * a progress bar's line as it last drew it. `cut` says the text already
 * starts mid-output, so its first line may be partial.
 */
export function outputTail(output: string | undefined, cut = false): string | undefined {
  if (!output) return undefined
  let text = output.length > OUTPUT_TAIL_BYTES ? output.slice(-OUTPUT_TAIL_BYTES) : output
  if (cut || text.length < output.length) text = text.slice(text.indexOf("\n") + 1)
  const lines = text
    .replace(TERMINAL_CODES, "")
    .split("\n")
    .map((line) => {
      const drawn = line.replace(/\r+$/, "")
      return drawn.slice(drawn.lastIndexOf("\r") + 1).trimEnd()
    })
  while (lines.length && !lines.at(-1)) lines.pop()
  const tail = lines.slice(-OUTPUT_TAIL_LINES).join("\n")
  return tail.trim() ? tail : undefined
}

/**
 * Output as a fenced block labelled `output`, so markdown draws it as
 * written and says what it is: the fence is longer than any run of
 * backticks inside it.
 */
export function outputBody(output: string | undefined): string | undefined {
  const text = output?.replace(/\s+$/, "")
  if (!text?.trim()) return undefined
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length))
  const fence = "`".repeat(longest + 1)
  return `${fence}output\n${text}\n${fence}`
}

export interface BackgroundCommandOutcome {
  description?: string
  command?: string
  exitCode?: number | null
  signal?: string | null
  stopped?: boolean
  /** Failed without reporting an exit code. */
  failed?: boolean
  /** How long it ran, when the provider says. */
  durationMs?: number
  /** What it printed; the turn opens onto its last lines. */
  output?: string
}

/** Claude's own summary shape: `Background command "…" completed (exit code 0)`. */
export function backgroundCommandLabel(outcome: BackgroundCommandOutcome): string {
  const name = (outcome.description || outcome.command || "").replace(/\s+/g, " ").trim()
  const subject = name ? `Background command "${name.slice(0, 200)}"` : "A background command"
  if (outcome.signal || outcome.stopped) return `${subject} was stopped${outcome.signal ? ` (${outcome.signal})` : ""}`
  if (outcome.exitCode === undefined || outcome.exitCode === null) return `${subject} ${outcome.failed ? "failed" : "finished"}`
  return `${subject} ${outcome.exitCode === 0 ? "completed" : "failed"} (exit code ${outcome.exitCode})`
}

/** `backgroundCommandLabel` with the outcome it words. */
export function backgroundCommandTurn(outcome: BackgroundCommandOutcome): ProviderTurnCause {
  const name = (outcome.description || outcome.command || "").replace(/\s+/g, " ").trim().slice(0, 200)
  const settled: Extract<TurnCause, { kind: "command" }>["outcome"] =
    outcome.signal || outcome.stopped
      ? "stopped"
      : outcome.failed || (outcome.exitCode !== undefined && outcome.exitCode !== null && outcome.exitCode !== 0)
        ? "failed"
        : "finished"
  const cause: TurnCause = { kind: "command", outcome: settled }
  if (name) cause.name = name
  if (outcome.exitCode !== undefined && outcome.exitCode !== null) cause.exitCode = outcome.exitCode
  if (outcome.signal) cause.signal = outcome.signal
  if (outcome.durationMs !== undefined) cause.durationMs = Math.max(0, Math.round(outcome.durationMs))
  const turn: ProviderTurnCause = { reason: backgroundCommandLabel(outcome), cause }
  const body = outputBody(outputTail(outcome.output))
  if (body) turn.body = body
  return turn
}

export interface SubagentOutcome {
  description?: string
  /** The harness's id for the subagent (`TurnCause` agent's `agentId`). */
  id?: string
  state?: "completed" | "cancelled" | "failed"
  /** How long it ran, when the provider says. */
  durationMs?: number
  /** What the agent reported back, as markdown. */
  result?: string
}

/** The same shape for a background subagent: `Subagent "…" completed`. */
export function subagentLabel(outcome: SubagentOutcome): string {
  const name = (outcome.description ?? "").replace(/\s+/g, " ").trim()
  const subject = name ? `Subagent "${name.slice(0, 200)}"` : "A subagent"
  if (outcome.state === "cancelled") return `${subject} was stopped`
  if (outcome.state === "failed") return `${subject} failed`
  return `${subject} ${outcome.state === "completed" ? "completed" : "finished"}`
}

/** `subagentLabel` with the outcome it words. */
export function subagentTurn(outcome: SubagentOutcome): ProviderTurnCause {
  const name = (outcome.description ?? "").replace(/\s+/g, " ").trim().slice(0, 200)
  const cause: TurnCause = {
    kind: "agent",
    outcome: outcome.state === "cancelled" ? "stopped" : outcome.state === "failed" ? "failed" : "finished",
  }
  if (name) cause.name = name
  if (outcome.id) cause.agentId = outcome.id
  if (outcome.durationMs !== undefined) cause.durationMs = Math.max(0, Math.round(outcome.durationMs))
  const turn: ProviderTurnCause = { reason: subagentLabel(outcome), cause }
  const body = causeBody(outcome.result)
  if (body) turn.body = body
  return turn
}

/** A turn Codex starts toward its thread goal, opened by a prompt of its own. */
export const CODEX_GOAL_TURN = "Codex took a turn toward the goal."

/** Codex's goal turn as a cause. */
export const CODEX_GOAL: ProviderTurnCause = { reason: CODEX_GOAL_TURN, cause: { kind: "goal" } }

/** Where a goal stands when a turn toward it starts: what it asks, and what it has spent of its budget. */
export interface GoalStanding {
  objective?: string
  tokensUsed?: number
  /** `null`: the goal has no budget. */
  tokenBudget?: number | null
}

function tokens(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "token" : "tokens"}`
}

/** Codex's goal turn, with the objective it works toward and what it has spent: the objective's first line is the line's detail; a longer objective and the spend open under it. */
export function codexGoalTurn(goal: GoalStanding | undefined): ProviderTurnCause {
  const objective = goal?.objective?.trim()
  if (!objective) return CODEX_GOAL
  const first = objective.split("\n", 1)[0]!.trim().slice(0, 200)
  const spent =
    goal?.tokensUsed === undefined
      ? undefined
      : goal.tokenBudget
        ? `${tokens(goal.tokensUsed)} used of a ${tokens(goal.tokenBudget).replace(/ tokens?$/, "-token")} budget.`
        : `${tokens(goal.tokensUsed)} used so far, with no budget.`
  const turn: ProviderTurnCause = { reason: CODEX_GOAL_TURN, cause: { kind: "goal", objective: first } }
  // The line holds a one-line objective whole; only a longer one opens again, above what the goal has spent.
  const body = causeBody([objective === first ? undefined : objective, spent].filter(Boolean).join("\n\n"))
  if (body) turn.body = body
  return turn
}

/** When a provider started a turn without saying why. */
export const PROVIDER_TURN_FALLBACK = "A background task finished"

/** The fallback as a cause. */
export const UNNAMED_TURN: ProviderTurnCause = { reason: PROVIDER_TURN_FALLBACK, cause: { kind: "task", outcome: "finished" } }

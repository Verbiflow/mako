/**
 * Turns a provider starts on its own.
 *
 * Claude Code, Grok and OpenCode start a turn when background work finishes,
 * with no prompt from anyone. Each reports the cause: Claude in the summary of
 * its task notification, Grok in a task snapshot, OpenCode in a synthetic
 * message. Mako shows that cause where a prompt would stand, in the same
 * wording for all of them.
 */

export interface BackgroundCommandOutcome {
  description?: string
  command?: string
  exitCode?: number | null
  signal?: string | null
  stopped?: boolean
  /** Failed without reporting an exit code. */
  failed?: boolean
}

/** Claude's own summary shape: `Background command "…" completed (exit code 0)`. */
export function backgroundCommandLabel(outcome: BackgroundCommandOutcome): string {
  const name = (outcome.description || outcome.command || "").replace(/\s+/g, " ").trim()
  const subject = name ? `Background command "${name.slice(0, 200)}"` : "A background command"
  if (outcome.signal || outcome.stopped) return `${subject} was stopped${outcome.signal ? ` (${outcome.signal})` : ""}`
  if (outcome.exitCode === undefined || outcome.exitCode === null) return `${subject} ${outcome.failed ? "failed" : "finished"}`
  return `${subject} ${outcome.exitCode === 0 ? "completed" : "failed"} (exit code ${outcome.exitCode})`
}

export interface SubagentOutcome {
  description?: string
  state?: "completed" | "cancelled" | "failed"
}

/** The same shape for a background subagent: `Subagent "…" completed`. */
export function subagentLabel(outcome: SubagentOutcome): string {
  const name = (outcome.description ?? "").replace(/\s+/g, " ").trim()
  const subject = name ? `Subagent "${name.slice(0, 200)}"` : "A subagent"
  if (outcome.state === "cancelled") return `${subject} was stopped`
  if (outcome.state === "failed") return `${subject} failed`
  return `${subject} ${outcome.state === "completed" ? "completed" : "finished"}`
}

/** When a provider started a turn without saying why. */
export const PROVIDER_TURN_FALLBACK = "A background task finished"

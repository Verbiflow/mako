/**
 * Turns a provider starts on its own.
 *
 * Claude Code and Grok start a turn when a background command finishes, with
 * no prompt from anyone. Each reports the cause: Claude in the summary of its
 * task notification, Grok in a task snapshot. Mako shows that cause where a
 * prompt would stand, in the same wording for both.
 */

export interface BackgroundCommandOutcome {
  description?: string
  command?: string
  exitCode?: number | null
  signal?: string | null
  stopped?: boolean
}

/** Claude's own summary shape: `Background command "…" completed (exit code 0)`. */
export function backgroundCommandLabel(outcome: BackgroundCommandOutcome): string {
  const name = (outcome.description || outcome.command || "").replace(/\s+/g, " ").trim()
  const subject = name ? `Background command "${name.slice(0, 200)}"` : "A background command"
  if (outcome.signal || outcome.stopped) return `${subject} was stopped${outcome.signal ? ` (${outcome.signal})` : ""}`
  if (outcome.exitCode === undefined || outcome.exitCode === null) return `${subject} finished`
  return `${subject} ${outcome.exitCode === 0 ? "completed" : "failed"} (exit code ${outcome.exitCode})`
}

/** When a provider started a turn without saying why. */
export const PROVIDER_TURN_FALLBACK = "A background task finished"

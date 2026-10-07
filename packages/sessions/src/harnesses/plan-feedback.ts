/**
 * What an agent is told when the person turns its plan down with words of
 * their own: grok 1.0.46's wording (`revise_plan_message` in
 * `tool_calls.rs`), which Mako sends Claude Code too. The words then sit in
 * the refused plan call's result, live and saved alike, and one reader finds
 * them in either harness's transcript.
 */
const PLAN_FEEDBACK = "The user wants to revise the plan. The user said:\n"

export function planFeedbackMessage(feedback: string): string {
  return `${PLAN_FEEDBACK}${feedback.trim()}`
}

/** The person's words in a refused plan call's result, if they gave any. */
export function planFeedbackOf(result: string | undefined): string | undefined {
  const at = result?.indexOf(PLAN_FEEDBACK) ?? -1
  return at < 0 ? undefined : result!.slice(at + PLAN_FEEDBACK.length).trim() || undefined
}

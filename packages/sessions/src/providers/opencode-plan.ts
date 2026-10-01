export const OPENCODE_PLAN_AGENT = "plan"

/**
 * OpenCode's Plan agent has no plan tool: it is told to discuss the plan in
 * the conversation and to ask its questions with the question tool (opencode
 * 2.0.1). So the reply of a Plan step that ends the turn is its plan. The
 * stored assistant message is the step's `assistantMessageID`, so live and
 * saved history give the card one id.
 */
export function openCodePlan(
  messageId: string,
  agent: string | undefined,
  finish: string | undefined,
  texts: readonly string[]
): { id: string; text: string } | undefined {
  if (agent !== OPENCODE_PLAN_AGENT || finish !== "stop") return undefined
  const text = texts.map((part) => part.trim()).filter(Boolean).join("\n\n")
  return text ? { id: `opencode:${messageId}`, text } : undefined
}

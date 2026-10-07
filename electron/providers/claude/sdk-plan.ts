import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import type { LiveUpdate } from "@mako/sessions/live-content"

const PlanInputSchema = z.object({ plan: z.string().trim().min(1) })
type ClaudeToolCall = Pick<
  Extract<
    SDKAssistantMessage["message"]["content"][number],
    { type: "tool_use" }
  >,
  "name" | "input" | "id"
>
export function claudeProposedPlan({
  name,
  input,
  id,
}: ClaudeToolCall): LiveUpdate[] {
  if (name !== "ExitPlanMode") return []
  const parsed = PlanInputSchema.safeParse(input)
  return parsed.success
    ? [
        {
          kind: "proposed-plan",
          id,
          text: parsed.data.plan,
          status: "proposed",
          replace: true,
        },
      ]
    : []
}

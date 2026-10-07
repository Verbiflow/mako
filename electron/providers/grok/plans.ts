import { z } from "zod"
import { grokPlanId, grokProposedPlan } from "@mako/sessions/harnesses"
import { PLAN_APPROVAL_TITLE } from "../../acp-decoder.js"
import type { JsonObject } from "../../codex-app-json.js"
import type { AcpAsk, AcpVendorRequest, AcpVendorRequests } from "../acp-source.js"
import { folderTrustRequest, GROK_FOLDER_TRUST_METHOD } from "./folder-trust.js"
import { GROK_QUESTION_METHOD, questionRequest } from "./questions.js"

/**
 * The request Grok's plan mode waits on, recorded 2026-09-30 from grok
 * 1.0.44 against a scripted model; the plan itself is read from its updates
 * (`GROK_ACP_HOOKS.plans`). After its `exit_plan_mode` tool call, Grok sends
 * `_x.ai/exit_plan_mode` with the plan file's content (null when the file is
 * empty). The answer's `outcome` decides (`ExitPlanModeExtResponse`,
 * xai-org/grok-build 1.0.45): `approved` leaves plan mode and builds,
 * `abandoned` leaves it without building, and `cancelled`, with the
 * person's `feedback` when they typed some, keeps planning. With no answer
 * Grok cancels the turn.
 */
export const GROK_EXIT_PLAN_METHOD = "_x.ai/exit_plan_mode"

const ExitPlanRequestSchema = z.object({
  sessionId: z.string(),
  toolCallId: z.string(),
  planContent: z.string().nullish(),
})

export const grokRequests: AcpVendorRequests = {
  methods: new Set([GROK_EXIT_PLAN_METHOD, GROK_QUESTION_METHOD, GROK_FOLDER_TRUST_METHOD]),
  decode: (method, params) => method === GROK_EXIT_PLAN_METHOD ? exitPlanRequest(params)
    : method === GROK_QUESTION_METHOD ? questionRequest(params)
    : method === GROK_FOLDER_TRUST_METHOD ? folderTrustRequest(params) : undefined,
}

function exitPlanRequest(params: JsonObject): AcpVendorRequest | undefined {
  const parsed = ExitPlanRequestSchema.safeParse(params)
  if (!parsed.success) return undefined
  const { sessionId, toolCallId, planContent } = parsed.data
  const plan = grokPlanId(sessionId, toolCallId)
  const request: AcpAsk["request"] = {
    title: PLAN_APPROVAL_TITLE,
    kind: "switch_mode",
    options: [
      { optionId: "approved", name: "Yes, build it", kind: "allow_once" },
      { optionId: "keep-planning", name: "No, keep planning", kind: "reject_once" },
      { optionId: "abandoned", name: "Abandon the plan", kind: "reject_always" },
    ],
    implementsPlan: { plan, approve: "approved" },
  }
  // With no plan file Grok tells the model to ask instead, and drops the feedback.
  if (planContent != null) request.feedbackOption = "keep-planning"
  return {
    sessionId,
    updates: grokProposedPlan(plan, planContent ?? ""),
    ask: {
      request,
      answers: [
        { optionId: "approved", result: { outcome: "approved" } },
        { optionId: "keep-planning", result: { outcome: "cancelled" } },
        { optionId: "abandoned", result: { outcome: "abandoned" } },
      ],
      feedback: (text) => ({ outcome: "cancelled", feedback: text }),
      dismissed: { outcome: "cancelled" },
    },
  }
}

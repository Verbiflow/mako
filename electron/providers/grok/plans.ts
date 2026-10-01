import type { SessionUpdate } from "@agentclientprotocol/sdk"
import { z } from "zod"
import type { JsonObject } from "../../codex-app-json.js"
import type { LiveUpdate } from "../../contracts/live-content.js"
import type { AcpPlanDecoder, AcpVendorRequest, AcpVendorRequests } from "../acp-source.js"

/**
 * Grok's plan mode, recorded 2026-09-30 from grok 1.0.44 against a scripted
 * model, with no real usage. The agent writes `plan.md` in the session's
 * folder, then calls `exit_plan_mode`: a tool call carrying the model's own
 * copy as `planContent`, then the request `_x.ai/exit_plan_mode` with the
 * file's content (null when the file is empty). The answer's `outcome`
 * decides: `approved` leaves plan mode and builds, `abandoned` leaves it
 * without building, and anything else keeps planning. With no answer Grok
 * cancels the turn. An approved call completes with the plan as
 * `rawOutput.PlanReady.plan_content`, which a reloaded session replays.
 */
export const GROK_EXIT_PLAN_METHOD = "_x.ai/exit_plan_mode"

const ExitPlanCallSchema = z.object({
  toolCallId: z.string(),
  rawInput: z.object({ planContent: z.string() }),
  _meta: z.object({ "x.ai/tool": z.object({ name: z.literal("exit_plan_mode") }) }),
})
const PlanReadySchema = z.object({
  toolCallId: z.string(),
  rawOutput: z.object({ type: z.literal("ExitPlanMode"), PlanReady: z.object({ plan_content: z.string() }) }),
})
const ExitPlanRequestSchema = z.object({
  sessionId: z.string(),
  toolCallId: z.string(),
  planContent: z.string().nullish(),
})

const grokPlanId = (sessionId: string, toolCallId: string) => `grok:${sessionId}:${toolCallId}`

function proposedPlan(id: string, text: string): LiveUpdate[] {
  return text.trim() ? [{ kind: "proposed-plan", id, text, status: "proposed", replace: true }] : []
}

export const grokPlans = (): AcpPlanDecoder => ({
  update(update: SessionUpdate, sessionId: string): LiveUpdate[] {
    if (update.sessionUpdate === "tool_call") {
      const call = ExitPlanCallSchema.safeParse(update)
      return call.success ? proposedPlan(grokPlanId(sessionId, call.data.toolCallId), call.data.rawInput.planContent) : []
    }
    if (update.sessionUpdate !== "tool_call_update") return []
    const ready = PlanReadySchema.safeParse(update)
    return ready.success ? proposedPlan(grokPlanId(sessionId, ready.data.toolCallId), ready.data.rawOutput.PlanReady.plan_content) : []
  },
})

export const grokRequests: AcpVendorRequests = {
  methods: new Set([GROK_EXIT_PLAN_METHOD]),
  decode: (method, params) => method === GROK_EXIT_PLAN_METHOD ? exitPlanRequest(params) : undefined,
}

function exitPlanRequest(params: JsonObject): AcpVendorRequest | undefined {
  const parsed = ExitPlanRequestSchema.safeParse(params)
  if (!parsed.success) return undefined
  const { sessionId, toolCallId, planContent } = parsed.data
  const plan = grokPlanId(sessionId, toolCallId)
  return {
    sessionId,
    updates: proposedPlan(plan, planContent ?? ""),
    ask: {
      request: {
        title: "Build the proposed plan?",
        kind: "switch_mode",
        options: [
          { optionId: "approved", name: "Yes, build it", kind: "allow_once" },
          { optionId: "keep-planning", name: "No, keep planning", kind: "reject_once" },
          { optionId: "abandoned", name: "Abandon the plan", kind: "reject_always" },
        ],
        implementsPlan: { plan, approve: "approved" },
      },
      answers: [
        { optionId: "approved", result: { outcome: "approved" } },
        { optionId: "keep-planning", result: { outcome: "rejected" } },
        { optionId: "abandoned", result: { outcome: "abandoned" } },
      ],
      dismissed: { outcome: "rejected" },
    },
  }
}

import type { RequestPermissionRequest, SessionUpdate } from "@agentclientprotocol/sdk"
import { DEVIN_PLAN_APPROVE, DevinExitPlanMetaSchema, DevinPlanCallSchema, DevinPlanTracker } from "@mako/sessions"
import type { LiveUpdate } from "../../contracts/live-content.js"
import type { AcpPlanApproval, AcpPlanDecoder } from "../acp-source.js"

/**
 * Devin's plan handover over ACP, tracked as saved history tracks it
 * (`packages/sessions/src/providers/devin-plans.ts`). Mako's Build takes
 * accept-edits, the level a Devin session runs at by default.
 */
export class DevinPlans implements AcpPlanDecoder {
  private readonly tracker = new DevinPlanTracker()

  update(update: SessionUpdate, sessionId: string): LiveUpdate[] {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return []
    const plan = this.tracker.observe(DevinPlanCallSchema.safeParse(update).data, sessionId)
    return plan ? [{ kind: "proposed-plan", id: plan.id, text: plan.text, status: "proposed", replace: true }] : []
  }

  approval(request: RequestPermissionRequest): AcpPlanApproval | undefined {
    const meta = DevinExitPlanMetaSchema.safeParse(request.toolCall._meta).data
    const plan = this.tracker.building(request.toolCall.toolCallId, meta?.["cognition.ai/planFilePath"])
    const approve = DEVIN_PLAN_APPROVE.find((id) => request.options.some((option) => option.optionId === id))
    return plan && approve ? { plan, approve } : undefined
  }
}

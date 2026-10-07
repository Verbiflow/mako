import type { RequestPermissionRequest } from "@agentclientprotocol/sdk"
import { DEVIN_PLAN_APPROVE, DevinExitPlanMetaSchema, DevinPlanUpdates } from "@mako/sessions"
import type { AcpPlanApproval, AcpPlanDecoder } from "../acp-source.js"

/**
 * Devin's plan handover over ACP: the proposed plans its saved history reads
 * too (`DevinPlanUpdates`), and the `exit_plan_mode` permission request whose
 * approval builds one. Mako's Build takes accept-edits, the level a Devin
 * session runs at by default.
 */
export class DevinPlans extends DevinPlanUpdates implements AcpPlanDecoder {
  approval(request: RequestPermissionRequest): AcpPlanApproval | undefined {
    const meta = DevinExitPlanMetaSchema.safeParse(request.toolCall._meta).data
    const plan = this.tracker.building(request.toolCall.toolCallId, meta?.["cognition.ai/planFilePath"])
    const approve = DEVIN_PLAN_APPROVE.find((id) => request.options.some((option) => option.optionId === id))
    return plan && approve ? { plan, approve } : undefined
  }
}

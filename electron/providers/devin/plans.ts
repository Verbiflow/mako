import type { RequestPermissionRequest, SessionUpdate } from "@agentclientprotocol/sdk"
import { z } from "zod"
import type { LiveUpdate } from "../../contracts/live-content.js"
import type { AcpPlanApproval, AcpPlanDecoder } from "../acp-source.js"

/**
 * Devin's plan mode, read from devin 3000.10.23's saved sessions and binary.
 * The agent writes the plan with `write_plan`, which Devin renders to
 * `~/.devin/plans/plan-<id>.md` and reports as an edit tool call marked
 * `cognition.ai/isPlanFileEdit` whose diff holds the whole file. It may
 * rewrite the plan several times, then calls `exit_plan_mode` (kind
 * `switch_mode`, marked `cognition.ai/isExitPlan` with the plan file's path),
 * which asks permission. Its build choices are `plan_normal`,
 * `plan_accept_edits` and `plan_bypass`; Mako's Build takes accept-edits,
 * the level a Devin session runs at by default.
 */
const APPROVE = ["plan_accept_edits", "plan_normal", "plan_bypass"]

const DiffSchema = z.object({ type: z.literal("diff"), path: z.string(), newText: z.string() })
const PlanFileEditSchema = z.object({
  toolCallId: z.string(),
  content: z.array(z.json()).nullish(),
  _meta: z.object({ "cognition.ai/isPlanFileEdit": z.literal(true) }),
})
const ExitMetaSchema = z.object({
  "cognition.ai/isExitPlan": z.literal(true),
  "cognition.ai/planFilePath": z.string(),
})
const ExitPlanSchema = z.object({
  toolCallId: z.string(),
  rawInput: z.object({ plan: z.string().optional() }).nullish(),
  _meta: ExitMetaSchema,
})
const ToolEndSchema = z.object({ toolCallId: z.string(), status: z.enum(["completed", "failed"]) })

export class DevinPlans implements AcpPlanDecoder {
  /** Each plan file's card while it is being proposed; an ended `exit_plan_mode` closes it. */
  private readonly open = new Map<string, string>()
  /** Each running `exit_plan_mode` call's plan file. */
  private readonly exits = new Map<string, string>()

  update(update: SessionUpdate, sessionId: string): LiveUpdate[] {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return []
    const edit = PlanFileEditSchema.safeParse(update)
    if (edit.success) {
      const diff = edit.data.content?.map((part) => DiffSchema.safeParse(part)).find((part) => part.success)?.data
      return diff ? [this.plan(diff.path, `devin:${sessionId}:${edit.data.toolCallId}`, diff.newText)] : []
    }
    const exit = ExitPlanSchema.safeParse(update)
    if (exit.success) {
      const path = exit.data._meta["cognition.ai/planFilePath"]
      this.exits.set(exit.data.toolCallId, path)
      // A plan written without `write_plan` reaches Mako only as the call's own copy.
      const text = exit.data.rawInput?.plan?.trim()
      return this.open.has(path) || !text ? [] : [this.plan(path, `devin:${sessionId}:${exit.data.toolCallId}`, text)]
    }
    const ended = ToolEndSchema.safeParse(update)
    const path = ended.success ? this.exits.get(ended.data.toolCallId) : undefined
    if (ended.success && path !== undefined) {
      this.exits.delete(ended.data.toolCallId)
      this.open.delete(path)
    }
    return []
  }

  approval(request: RequestPermissionRequest): AcpPlanApproval | undefined {
    const path = this.exits.get(request.toolCall.toolCallId) ??
      ExitMetaSchema.safeParse(request.toolCall._meta).data?.["cognition.ai/planFilePath"]
    const plan = path === undefined ? undefined : this.open.get(path)
    const approve = APPROVE.find((id) => request.options.some((option) => option.optionId === id))
    return plan && approve ? { plan, approve } : undefined
  }

  private plan(path: string, id: string, text: string): LiveUpdate {
    const card = this.open.get(path) ?? id
    this.open.set(path, card)
    return { kind: "proposed-plan", id: card, text, status: "proposed", replace: true }
  }
}

import { z } from "zod"

/**
 * Devin's plan mode, read from devin 3000.10.23's saved sessions and binary.
 * The agent writes the plan with `write_plan`, which Devin renders to
 * `~/.devin/plans/plan-<id>.md` and reports as an edit tool call marked
 * `cognition.ai/isPlanFileEdit` whose diff holds the whole file, headed by
 * front matter. It may rewrite the plan several times, then calls
 * `exit_plan_mode` (kind `switch_mode`, marked `cognition.ai/isExitPlan`
 * with the plan file's path), which asks permission. Its binary knows the
 * build choices `plan_normal`, `plan_accept_edits` and `plan_bypass`.
 *
 * Captured 2026-09-30 through Mako (`devin/plan-approved.json`): the
 * permission request's tool call carries only the `exit_plan_mode` call's
 * id, so the plan is found through that call; a session started in Plan was
 * offered `plan_accept_edits`, `plan_bypass` and `reject_once`; and the
 * approval is followed by `current_mode_update` to the chosen mode. The CLI
 * keeps each call's ACP JSON in `tool_call_state`, so its saved sessions
 * read the same.
 *
 * The live decoder (`electron/providers/devin/plans.ts`) and both history
 * readers track plans here, so a card has one id and one text everywhere.
 */
export const DEVIN_PLAN_APPROVE = ["plan_accept_edits", "plan_normal", "plan_bypass"] as const

/** Devin heads the plan file with its agent, session and creation time. */
const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/

const DiffSchema = z.object({ type: z.literal("diff"), path: z.string(), newText: z.string() })
const PlanFileEditSchema = z.object({
  toolCallId: z.string(),
  content: z.array(z.json()).nullish(),
  _meta: z.object({ "cognition.ai/isPlanFileEdit": z.literal(true) }),
}).transform(({ toolCallId, content }) => ({
  kind: "plan-edit" as const,
  toolCallId,
  diff: content?.map((part) => DiffSchema.safeParse(part)).find((part) => part.success)?.data,
}))
/** The `_meta` of Devin's `exit_plan_mode` call and of the permission request it raises. */
export const DevinExitPlanMetaSchema = z.object({
  "cognition.ai/isExitPlan": z.literal(true),
  "cognition.ai/planFilePath": z.string(),
})
const ExitPlanSchema = z.object({
  toolCallId: z.string(),
  rawInput: z.object({ plan: z.string().optional() }).nullish(),
  _meta: DevinExitPlanMetaSchema,
}).transform(({ toolCallId, rawInput, _meta }) => ({
  kind: "plan-exit" as const,
  toolCallId,
  path: _meta["cognition.ai/planFilePath"],
  text: rawInput?.plan?.trim() ?? "",
}))
const ToolEndSchema = z.object({ toolCallId: z.string(), status: z.enum(["completed", "failed"]) })
  .transform(({ toolCallId }) => ({ kind: "tool-end" as const, toolCallId }))

/** An ACP `tool_call` or `tool_call_update`, live or saved, as far as plans need it. */
export const DevinPlanCallSchema = z.union([PlanFileEditSchema, ExitPlanSchema, ToolEndSchema])
export type DevinPlanCall = z.infer<typeof DevinPlanCallSchema>

export interface DevinProposedPlan {
  id: string
  text: string
}

/** One session's plans, fed its ACP tool calls and their updates in order. */
export class DevinPlanTracker {
  /** Each plan file's card while it is being proposed; an ended `exit_plan_mode` closes it. */
  private readonly open = new Map<string, string>()
  /** Each running `exit_plan_mode` call's plan file. */
  private readonly exits = new Map<string, string>()

  /** The plan a tool call or update proposes, or revises under the same card. */
  observe(call: DevinPlanCall | undefined, sessionId: string): DevinProposedPlan | undefined {
    switch (call?.kind) {
      case "plan-edit":
        return call.diff ? this.plan(call.diff.path, `devin:${sessionId}:${call.toolCallId}`, call.diff.newText) : undefined
      case "plan-exit":
        this.exits.set(call.toolCallId, call.path)
        // A plan written without `write_plan` reaches Mako only as the call's own copy.
        return this.open.has(call.path) || !call.text ? undefined : this.plan(call.path, `devin:${sessionId}:${call.toolCallId}`, call.text)
      case "tool-end": {
        const path = this.exits.get(call.toolCallId)
        if (path === undefined) return undefined
        this.exits.delete(call.toolCallId)
        this.open.delete(path)
        return undefined
      }
      default:
        return undefined
    }
  }

  /** The card an `exit_plan_mode` permission builds: by the call it answers, else the plan file it names. */
  building(toolCallId: string, planFilePath: string | undefined): string | undefined {
    const path = this.exits.get(toolCallId) ?? planFilePath
    return path === undefined ? undefined : this.open.get(path)
  }

  private plan(path: string, id: string, text: string): DevinProposedPlan {
    const card = this.open.get(path) ?? id
    this.open.set(path, card)
    return { id: card, text: text.replace(FRONT_MATTER, "") }
  }
}

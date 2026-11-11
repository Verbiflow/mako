import { z } from "zod"
import { ThreadIdSchema } from "./thread-identity.js"

/** An explicit immutable target, never inferred from report prose or delivery. */
export const ReportActionTargetSchema = z.object({ ref: z.string().trim().min(1).max(600), version: z.string().trim().min(1).max(200) }).strict()
export type ReportActionTarget = z.infer<typeof ReportActionTargetSchema>

export const ReportDispositionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("resolve"), evidence: z.string().trim().min(1).max(600) }).strict(),
  z.object({ kind: z.literal("reclaim"), reason: z.string().trim().min(1).max(600) }).strict(),
  z.object({ kind: z.literal("dismiss"), reason: z.string().trim().min(1).max(600) }).strict(),
  z.object({ kind: z.literal("defer"), reason: z.string().trim().min(1).max(600), resume: z.string().trim().min(1).max(600) }).strict(),
  z.object({ kind: z.literal("supersede"), report: z.string().min(1).max(600), reason: z.string().trim().min(1).max(600) }).strict(),
  z.object({ kind: z.literal("dispatch"), to: z.string().min(1).max(200), request: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("handoff"), to: z.string().min(1).max(200), request: z.string().min(1).max(200) }).strict(),
])
export type ReportDisposition = z.infer<typeof ReportDispositionSchema>

/** Follow-through belongs to this report and target, independently of the report outbox. */
export const ReportActionSchema = z.object({
  report: z.string().min(1).max(600),
  child: ThreadIdSchema,
  parent: ThreadIdSchema,
  /** Current custodian; parent retains final disposition authority. No native outcome resolves work. */
  owner: ThreadIdSchema,
  custody: z.object({ kind: z.enum(["dispatch", "handoff"]), to: ThreadIdSchema, request: z.string().min(1).max(200) }).optional(),
  target: ReportActionTargetSchema,
  action: z.string().trim().min(1).max(400),
  version: z.number().int().positive(),
  at: z.number(),
  updatedAt: z.number(),
  disposition: z.union([z.object({ kind: z.literal("pending") }), ReportDispositionSchema]),
})
export type ReportAction = z.infer<typeof ReportActionSchema>
export interface ReportActionsPage { items: ReportAction[]; total: number; next?: string }

export function pendingReportAction(action: ReportAction): boolean {
  return ["pending", "defer", "reclaim", "dispatch", "handoff"].includes(action.disposition.kind)
}

/** Shared by the common Fin brief and every harness's orchestration instructions. */
export const REPORT_FOLLOW_UP_INSTRUCTIONS = "Local done/failed result leaving a next action: include action plus followUp:{ref,version} naming its stable target/version, such as a PR and exact SHA. Informational completion and progress omit followUp; questions/person decisions use their retained ask. Dispatch/handoff retains pending custody; source Apex explicitly resolves, dismisses or supersedes the exact action."

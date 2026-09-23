import { z } from "zod"
import { PromptAttachmentSchema } from "./prompt-attachments.js"

export const LiveActionInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("steer"),
    id: z.string().uuid(),
    requestId: z.string().uuid(),
    text: z.string().min(1).max(1_000_000),
    attachments: z.array(PromptAttachmentSchema).max(100),
  }),
  z.object({
    kind: z.literal("steer-queued"),
    id: z.string().uuid(),
    requestId: z.string().uuid(),
    queuedRequestId: z.string().uuid(),
    text: z.string().min(1).max(1_000_000),
    attachments: z.array(PromptAttachmentSchema).max(100),
  }),
  z.object({ kind: z.literal("compact"), id: z.string().uuid(), requestId: z.string().uuid().optional() }),
])
export type LiveActionInput = z.infer<typeof LiveActionInputSchema>
export const LiveActionResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("completed") }),
  z.object({ kind: z.literal("failed"), reason: z.string() }),
  z.object({ kind: z.literal("uncertain"), reason: z.string() }),
])
export type LiveActionResult = z.infer<typeof LiveActionResultSchema>
export const LiveActionSchema = z.object({
  input: LiveActionInputSchema,
  digest: z.string(),
  bindingId: z.string().uuid(),
  createdAt: z.number(),
  /** Host-owned queue state restored only after an authoritative refusal. */
  queueStatus: z.enum(["queued", "held"]).optional(),
  state: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("dispatching") }),
    z.object({ kind: z.literal("accepted") }),
    z.object({ kind: z.literal("completed") }),
    z.object({ kind: z.literal("failed"), reason: z.string() }),
    z.object({ kind: z.literal("not-accepted"), reason: z.string() }),
    z.object({ kind: z.literal("uncertain"), reason: z.string() }),
    z.object({
      kind: z.literal("acknowledged"),
      // Older journals stored only the kind; never invent their lost outcome.
      receipt: z.object({
        at: z.number().finite(),
        outcome: z.object({ kind: z.literal("uncertain"), reason: z.string() }),
      }).optional(),
    }),
  ]),
})
export type LiveAction = z.infer<typeof LiveActionSchema>

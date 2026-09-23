import { z } from "zod"

/** Delivery evidence is independent of whether the native execution succeeded. */
export const PromptDeliveryEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prepared") }),
  z.object({
    kind: z.literal("submitted"),
    source: z.enum(["sdk-input", "transport-call"]),
    correlationId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("accepted"),
    source: z.enum(["native-response", "native-echo"]),
    referenceId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("not-accepted"),
    source: z.literal("preflight"),
    reason: z.string(),
  }),
  z.object({ kind: z.literal("uncertain"), reason: z.string() }),
])
export type PromptDeliveryEvidence = z.infer<
  typeof PromptDeliveryEvidenceSchema
>
export const PromptDeliverySchema = z.object({
  attemptId: z.string().uuid(),
  bindingId: z.string(),
  ownerEpoch: z.string(),
  evidence: PromptDeliveryEvidenceSchema,
})
export type PromptDelivery = z.infer<typeof PromptDeliverySchema>

/** No persisted field means legacy/unknown, never implied native acceptance. */
export function advancePromptDelivery(
  previous: PromptDeliveryEvidence,
  next: PromptDeliveryEvidence
): PromptDeliveryEvidence {
  // A late transport failure cannot undo an authoritative receipt. Likewise,
  // a preflight refusal cannot later become a send within the same attempt.
  if (previous.kind === "accepted" || previous.kind === "not-accepted")
    return previous
  if (next.kind === "prepared") return previous
  if (previous.kind === "uncertain" && next.kind === "submitted")
    return previous
  if (previous.kind !== "prepared" && next.kind === "not-accepted")
    return previous
  return next
}

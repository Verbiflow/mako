import { z } from "zod"

/** Provider-owned occurrence, scoped to the native observer's lifetime. */
export const NativeApprovalIdentitySchema = z.object({
  scope: z.string().uuid(),
  sessionId: z.string().min(1).max(512),
  requestId: z.string().min(1).max(512),
})
export type NativeApprovalIdentity = z.infer<typeof NativeApprovalIdentitySchema>

/** The native runtime recorded this decision. It does not prove tool execution. */
export const NativeApprovalDecisionSchema = z.object({
  identity: NativeApprovalIdentitySchema,
  answerDigest: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: z.number().finite(),
})
export type NativeApprovalDecision = z.infer<typeof NativeApprovalDecisionSchema>

/** Host-owned identity; native request IDs can be reused by later connections. */
export const ApprovalOriginSchema = z.object({
  native: NativeApprovalIdentitySchema.optional(),
  nativeRequestId: z.string(),
  observationId: z.string().optional(),
  bindingId: z.string(),
  epoch: z.string(),
  generation: z.number().int(),
  connectionGeneration: z.number().int(),
  runId: z.string().optional(),
})
export type ApprovalOrigin = z.infer<typeof ApprovalOriginSchema>

/** Evidence at the adapter boundary; none of these proves native acceptance. */
export const ApprovalSubmissionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("submitted"), source: z.enum(["callback", "transport-write"]) }),
  z.object({ kind: z.literal("not-submitted"), pending: z.boolean(), reason: z.enum(["request-ended", "invalid-answer"]) }),
  z.object({ kind: z.literal("uncertain"), reason: z.string() }),
])
export type ApprovalSubmission = z.infer<typeof ApprovalSubmissionSchema>

/** A request ended; this does not prove which answer, if any, was consumed. */
export const ApprovalEndSourceSchema = z.enum(["native-resolution", "request-aborted", "connection-close"])
export type ApprovalEndSource = z.infer<typeof ApprovalEndSourceSchema>

export const ApprovalResponseSchema = z.object({
  id: z.string().uuid(),
  origin: ApprovalOriginSchema,
  digest: z.string(),
  /** Provider's encoded answer, frozen before dispatch; original digest still deduplicates UI intent. */
  nativeAnswerDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  createdAt: z.number(),
  ended: z.object({ source: ApprovalEndSourceSchema, observedAt: z.number() }).optional(),
  nativeDecision: NativeApprovalDecisionSchema.optional(),
  state: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("dispatching") }),
    // Only the adapter call returned. This does not prove native acceptance.
    z.object({ kind: z.literal("submitted"), source: z.enum(["callback", "transport-write"]).optional() }),
    z.object({ kind: z.literal("not-submitted"), pending: z.boolean(), reason: z.enum(["request-ended", "invalid-answer"]) }),
    z.object({ kind: z.literal("uncertain"), reason: z.string() }),
  ]),
}).superRefine((receipt, context) => {
  if (receipt.nativeDecision && !sameNativeApproval(receipt.origin.native, receipt.nativeDecision.identity))
    context.addIssue({ code: "custom", path: ["nativeDecision"], message: "Native decision belongs to another approval occurrence" })
})
export type ApprovalResponse = z.infer<typeof ApprovalResponseSchema>

export function nativeApprovalMatchesAnswer(receipt: ApprovalResponse): boolean {
  return receipt.nativeDecision?.answerDigest === (receipt.nativeAnswerDigest ?? receipt.digest)
}

export function describeApprovalResponse(receipt: ApprovalResponse, questionAvailable = false) {
  if (receipt.nativeDecision) return nativeApprovalMatchesAnswer(receipt)
    ? { title: "Agent recorded your answer", guidance: "The agent confirmed this decision for this approval. This does not confirm that the operation finished.", tone: "info" as const }
    : { title: "Agent recorded a different decision", guidance: "This approval was resolved with a different decision. Mako won’t resend your answer. Check the conversation before continuing.", tone: "caution" as const }
  switch (receipt.state.kind) {
    case "dispatching":
      return { title: "Sending your answer", guidance: "Your answer is saved. Waiting for the connection to confirm submission.", tone: "progress" as const }
    case "submitted":
      return { title: "Answer submitted", guidance: receipt.state.source
        ? "Your answer was handed to the agent connection. The agent has not confirmed receiving it."
        : "Mako recorded submission, but this older receipt has no transport confirmation.", tone: "info" as const }
    case "uncertain":
      return { title: "Answer delivery unknown", guidance: "Your answer may have reached the agent. Mako won’t send it again. Check the conversation before continuing.", tone: "caution" as const }
    case "not-submitted":
      return receipt.state.pending
        ? { title: "Answer needs a correction", guidance: questionAvailable
          ? "Your answer was not sent. Review the question and answer again."
          : "Your answer was not sent. The question is no longer shown here; check the conversation.", tone: "caution" as const }
        : { title: "Approval is no longer waiting", guidance: "Your answer was not sent. This request is no longer pending.", tone: "info" as const }
  }
}

export function sameApprovalOrigin(a: ApprovalOrigin, b: ApprovalOrigin): boolean {
  return sameNativeApproval(a.native, b.native) && a.nativeRequestId === b.nativeRequestId && a.observationId === b.observationId && a.bindingId === b.bindingId && a.epoch === b.epoch &&
    a.generation === b.generation && a.connectionGeneration === b.connectionGeneration && a.runId === b.runId
}

export function sameNativeApproval(a: NativeApprovalIdentity | undefined, b: NativeApprovalIdentity | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined && a.scope === b.scope && a.sessionId === b.sessionId && a.requestId === b.requestId
}

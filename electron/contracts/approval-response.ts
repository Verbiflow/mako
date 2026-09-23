import { z } from "zod"

/** Host-owned identity; native request IDs can be reused by later connections. */
export const ApprovalOriginSchema = z.object({
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
  createdAt: z.number(),
  ended: z.object({ source: ApprovalEndSourceSchema, observedAt: z.number() }).optional(),
  state: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("dispatching") }),
    // Only the adapter call returned. This does not prove native acceptance.
    z.object({ kind: z.literal("submitted"), source: z.enum(["callback", "transport-write"]).optional() }),
    z.object({ kind: z.literal("not-submitted"), pending: z.boolean(), reason: z.enum(["request-ended", "invalid-answer"]) }),
    z.object({ kind: z.literal("uncertain"), reason: z.string() }),
  ]),
})
export type ApprovalResponse = z.infer<typeof ApprovalResponseSchema>

export function describeApprovalResponse(receipt: ApprovalResponse, questionAvailable = false) {
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
  return a.nativeRequestId === b.nativeRequestId && a.observationId === b.observationId && a.bindingId === b.bindingId && a.epoch === b.epoch &&
    a.generation === b.generation && a.connectionGeneration === b.connectionGeneration && a.runId === b.runId
}

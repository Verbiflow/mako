import { z } from "zod"
import type { PromptDelivery, PromptDeliveryEvidence } from "./prompt-delivery.js"

/** A run/turn receipt is not necessarily the stored user's message ID. */
export const NativePromptIdentityCapabilitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted-message-id"), evidence: z.string().min(1) }),
  z.object({ kind: z.literal("unavailable"), reason: z.string().min(1) }),
])
export type NativePromptIdentityCapability = z.infer<typeof NativePromptIdentityCapabilitySchema>

export const NO_NATIVE_PROMPT_IDENTITY = {
  kind: "unavailable",
  reason: "Transport acceptance does not establish a stored user-message ID. Native/request correspondence needs separate verified evidence.",
} as const

/** Retained from this exact dispatch; never reconstructed from prompt words. */
export const NativePromptReferenceSchema = z.object({
  bindingId: z.string().min(1),
  attemptId: z.string().uuid(),
  provider: z.string().min(1),
  nativeId: z.string().min(1),
  path: z.string().min(1),
  messageId: z.string().min(1),
})
export type NativePromptReference = z.infer<typeof NativePromptReferenceSchema>

export function nativePromptReference(
  capability: NativePromptIdentityCapability | undefined,
  evidence: PromptDeliveryEvidence,
  scope: { bindingId: string; attemptId: string; provider: string; nativeId?: string; path?: string }
): NativePromptReference | undefined {
  if (capability?.kind !== "accepted-message-id" || evidence.kind !== "accepted" ||
      !evidence.referenceId || !scope.nativeId || !scope.path) return
  return NativePromptReferenceSchema.parse({ ...scope, messageId: evidence.referenceId })
}

/** Only unique, source-scoped retained correspondences can name a prompt. */
export function nativePromptRequestIds(
  source: { harness: string; nativeId: string; path: string },
  requests: readonly { id: string; nativePrompt?: NativePromptReference; nativeDelivery?: PromptDelivery }[]
): Map<string, string> {
  const ids = new Map<string, string>()
  const ambiguous = new Set<string>()
  const seenRequests = new Map<string, string>()
  const ambiguousRequests = new Set<string>()
  for (const request of requests) {
    const prompt = request.nativePrompt
    const delivery = request.nativeDelivery
    if (!prompt || prompt.provider !== source.harness || prompt.nativeId !== source.nativeId || prompt.path !== source.path ||
        delivery?.evidence.kind !== "accepted" || delivery.evidence.referenceId !== prompt.messageId ||
        delivery.attemptId !== prompt.attemptId || delivery.bindingId !== prompt.bindingId) continue
    if (ids.has(prompt.messageId) && ids.get(prompt.messageId) !== request.id) ambiguous.add(prompt.messageId)
    ids.set(prompt.messageId, request.id)
    const seen = seenRequests.get(request.id)
    if (seen && seen !== prompt.messageId) ambiguousRequests.add(request.id)
    seenRequests.set(request.id, prompt.messageId)
  }
  for (const id of ambiguous) ids.delete(id)
  for (const [id, request] of ids) if (ambiguousRequests.has(request)) ids.delete(id)
  return ids
}

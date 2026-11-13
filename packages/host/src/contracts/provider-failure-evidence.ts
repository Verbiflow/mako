import { z } from "zod"

/** A provider-boundary verdict based on credential/response facts, never on the authentication-looking wrapper. */
export const ProviderFailureEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("auth"), source: z.enum(["credential-missing", "refresh-failed", "provider-auth-error"]) }),
  z.object({ kind: z.literal("provider-unavailable"), source: z.enum(["credential-current", "gateway-response", "unconfirmed-auth"]) }),
])
export type ProviderFailureEvidence = z.infer<typeof ProviderFailureEvidenceSchema>

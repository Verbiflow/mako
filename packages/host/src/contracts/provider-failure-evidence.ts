import { HOST_FAILURE_KINDS, PROVIDER_FAILURE_KINDS } from "./provider-failure.js"
import { z } from "zod"

/** A verdict with its origin: typed host facts, native protocol facts, or text admitted by a native transport. */
const CurrentFailureEvidenceSchema = z.union([
  z.object({ kind: z.literal("rate-limited"), source: z.literal("native-limit") }),
  z.object({ kind: z.enum(PROVIDER_FAILURE_KINDS), source: z.literal("native-error") }),
  z.object({ kind: z.enum(HOST_FAILURE_KINDS), source: z.literal("host") }),
  z.object({ kind: z.enum(PROVIDER_FAILURE_KINDS), source: z.literal("provider-text") }),
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("auth"), source: z.enum(["credential-missing", "refresh-failed", "provider-auth-error"]) }),
    z.object({ kind: z.literal("permission"), source: z.literal("provider-permission-error") }),
    z.object({ kind: z.literal("unknown"), source: z.literal("provider-error") }),
    z.object({ kind: z.literal("provider-unavailable"), source: z.enum(["credential-current", "gateway-response", "unconfirmed-auth"]) }),
  ]),
])
/** Older journals read the fallback; current readers recover its exact origin/kind. */
const ExactFailureEvidenceSchema = z.object({ exact: CurrentFailureEvidenceSchema })
const UnknownExactFailureSchema = z.object({ exact: z.unknown().refine(value => value !== undefined) })
export const ProviderFailureEvidenceSchema = z.preprocess(value => {
  const exact = ExactFailureEvidenceSchema.safeParse(value)
  return exact.success ? exact.data.exact : UnknownExactFailureSchema.safeParse(value).success ? { kind: "unknown", source: "host" } : value
}, CurrentFailureEvidenceSchema)
export type ProviderFailureEvidence = z.infer<typeof ProviderFailureEvidenceSchema>

/** Existing binaries can parse the request/session without knowing the new evidence variants. */
export function storedFailureEvidence(evidence: ProviderFailureEvidence) {
  return evidence.source === "host" || evidence.source === "provider-text" || evidence.source === "native-limit" || evidence.source === "native-error"
    ? { kind: "unknown" as const, source: "provider-error" as const, exact: evidence }
    : evidence
}

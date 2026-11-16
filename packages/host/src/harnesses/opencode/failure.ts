import { providerTextEvidence } from "../../contracts/provider-failure.js"
import type { ProviderFailureEvidence } from "../../contracts/provider-failure-evidence.js"

/** Execution errors retain OpenCode's native type, before prose supplies any fallback. */
export function openCodeFailureEvidence(error: { type: string; message: string }): ProviderFailureEvidence {
  return error.type === "provider.rate-limit" ? { kind: "rate-limited", source: "native-limit" } : providerTextEvidence(error.message)
}

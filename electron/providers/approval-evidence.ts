import { createHash } from "node:crypto"
import type { LivePermissionResponse } from "@mako/host/contracts/providers-acp"

/** The host and native adapters compare decisions without retaining answer text. */
export function approvalAnswerDigest(response: LivePermissionResponse): string {
  const canonical = response.kind === "choice" ? { kind: response.kind, optionId: response.optionId } : {
    kind: response.kind,
    answers: Object.fromEntries(Object.entries(response.answers).sort(([a], [b]) => a.localeCompare(b))),
  }
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
}

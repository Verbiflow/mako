import { numberValue, objectValue, stringValue } from "../../base/json-values.js"
import type { JsonValue } from "../../contracts/json.js"
import { providerTextEvidence, type ProviderFailureKind } from "../../contracts/provider-failure.js"
import type { ProviderFailureEvidence } from "../../contracts/provider-failure-evidence.js"

/** CodexErrorInfo's app-server variants; rollout spellings may use underscores or hyphens. */
export function codexFailureEvidence(message: string | undefined, info: JsonValue | undefined): ProviderFailureEvidence {
  const scalar = stringValue(info)
  const keys = Object.keys(objectValue(info) ?? {})
  const variant = scalar ?? (keys.length === 1 ? keys[0] : undefined)
  const kind = variant?.replace(/[_-]/g, "").toLowerCase()
  if (scalar && (kind === "usagelimitexceeded" || kind === "ratelimitexceeded")) return { kind: "rate-limited", source: "native-limit" }
  if (scalar && kind === "unauthorized") return { kind: "auth", source: "native-error" }
  if (scalar && kind === "contextwindowexceeded") return { kind: "context-exhausted", source: "native-error" }
  if (scalar && (kind === "internalservererror" || kind === "serveroverloaded")) return { kind: "provider-unavailable", source: "native-error" }
  // Only these variants own httpStatusCode in the native protocol; a future object's arbitrary field is not evidence.
  if (variant && (kind === "httpconnectionfailed" || kind === "responsestreamconnectionfailed" || kind === "responsestreamdisconnected" || kind === "responsetoomanyfailedattempts")) {
    const status = numberValue(objectValue(objectValue(info)?.[variant])?.httpStatusCode)
    if (status === 429) return { kind: "rate-limited", source: "native-limit" }
    const failure: ProviderFailureKind | undefined = status === 401 ? "auth" : status === 403 ? "permission" : status !== undefined && Number.isInteger(status) && status >= 500 && status <= 599 ? "provider-unavailable" : undefined
    if (failure) return { kind: failure, source: "native-error" }
  }
  return providerTextEvidence(message)
}

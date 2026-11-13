import { z } from "zod"
import type { ProviderFailureEvidence } from "../../contracts/provider-failure-evidence.js"
import type { ClaudeCredentialState } from "./accounts.js"

const ErrorDetailSchema = z.looseObject({ type: z.string().optional(), code: z.string().optional(), message: z.string().optional() })
const ProviderErrorSchema = z.looseObject({
  type: z.string().optional(),
  error: z.union([z.string().transform(code => ({ code })), ErrorDetailSchema]).pipe(ErrorDetailSchema).optional(),
})
const AUTH_ERROR = /^(?:authentication_error|invalid_token|token_revoked|invalid_api_key)$/
const REFRESH_FAILED = "Failed to authenticate: OAuth session expired and could not be refreshed"

export function claudeRejectedCredential(message: string): boolean {
  const start = message.indexOf("{")
  const body = start < 0 ? "" : message.slice(start)
  try {
    const parsed = ProviderErrorSchema.safeParse(JSON.parse(body))
    if (parsed.success) {
      const error = parsed.data.error
      const codes = [error?.type, error?.code, parsed.data.type]
      if (codes.some(code => code !== undefined && AUTH_ERROR.test(code))) return true
      if (error?.message && /^(?:invalid (?:access )?token|invalid api key|(?:oauth )?access token (?:has been |is )?revoked|token (?:has been |is )?revoked)\b/i.test(error.message)) return true
    }
  } catch { /* The CLI may have received an HTML response, not the provider's JSON. */ }
  return /^(?:Failed to authenticate[.:]\s*)?(?:API Error:\s*)?401\s+OAuth access token has been revoked\.?$/i.test(message)
}

/** Only status plus HTML structure establishes a gateway response; no proxy name or arbitrary denial text does. */
function gatewayResponse(message: string): boolean {
  const response = message.replace(/^Failed to authenticate[.:]\s*/i, "")
  return /^(?:API Error:\s*)?(?:403|5\d\d)\b[^<\r\n]*<(?:!doctype\s+html\b|html\b|head\b|title\b|body\b)/i.test(response)
}

/** Called only for a native authentication-looking failure, with the credentials of that exact SDK launch scope. */
export function claudeFailureEvidence(message: string, state: ClaudeCredentialState | undefined, now = Date.now()): ProviderFailureEvidence {
  if (claudeRejectedCredential(message)) return { kind: "auth", source: "provider-auth-error" }
  if (state?.store === "none" || (state && state.store !== "unreadable" && (!state.access || state.refresh !== "present")))
    return { kind: "auth", source: "credential-missing" }
  if (state && state.store !== "unreadable") {
    if (state.access && state.refresh === "present" && state.expiresAt && Date.parse(state.expiresAt) > now)
      return { kind: "provider-unavailable", source: "credential-current" }
    if (state.expiresAt && Date.parse(state.expiresAt) <= now && (message === REFRESH_FAILED || (state.refreshExpiresAt && Date.parse(state.refreshExpiresAt) <= now)))
      return { kind: "auth", source: "refresh-failed" }
  }
  if (message === REFRESH_FAILED) return { kind: "auth", source: "refresh-failed" }
  if (gatewayResponse(message)) return { kind: "provider-unavailable", source: "gateway-response" }
  // An unreadable/unknown store or a stale access token alone does not establish that signing in is required.
  return { kind: "provider-unavailable", source: "unconfirmed-auth" }
}

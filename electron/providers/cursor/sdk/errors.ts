import {
  AgentBusyError, AgentNotFoundError, AuthenticationError, ConfigurationError,
  CursorSdkError, NetworkError, RateLimitError,
} from "@cursor/sdk"
import { z } from "zod"
import { CursorNetworkCauseSchema, type SdkWireError } from "./wire.js"

const CauseSchema = z.object({
  code: CursorNetworkCauseSchema.optional().catch(undefined),
  cause: z.unknown().optional(),
})

function networkCauses(error: NetworkError): NonNullable<SdkWireError["networkCauses"]> {
  const codes = new Set<NonNullable<SdkWireError["networkCauses"]>[number]>()
  const seen = new Set<unknown>()
  const visit = (cause: unknown, depth: number): void => {
    const parsed = CauseSchema.safeParse(cause)
    if (!parsed.success || seen.has(cause) || depth > 4 || seen.size >= 16) return
    seen.add(cause)
    if (parsed.data.code && codes.size < 8) codes.add(parsed.data.code)
    if (parsed.data.cause) visit(parsed.data.cause, depth + 1)
    if (cause instanceof AggregateError) for (const nested of cause.errors.slice(0, 8)) visit(nested, depth + 1)
  }
  visit(error, 0)
  return [...codes]
}

export function cursorSdkWireError(cause: unknown): SdkWireError {
  if (cause instanceof AuthenticationError)
    return { message: cause.message, kind: "authentication", code: cause.code, retryable: false }
  if (cause instanceof RateLimitError)
    return { message: cause.message, kind: "rate-limit", code: cause.code, retryable: true }
  if (cause instanceof AgentBusyError)
    return { message: cause.message, kind: "busy", code: cause.code, retryable: false }
  if (cause instanceof AgentNotFoundError)
    return { message: cause.message, kind: "not-found", code: cause.code, retryable: false }
  if (cause instanceof ConfigurationError)
    return { message: cause.message, kind: "configuration", code: cause.code, retryable: false }
  if (cause instanceof NetworkError)
    return { message: cause.message, kind: "network", code: cause.code, retryable: true, networkCauses: networkCauses(cause) }
  if (cause instanceof CursorSdkError)
    return { message: cause.message, kind: "unknown", code: cause.code, retryable: cause.isRetryable }
  if (cause instanceof Error) return { message: cause.message, kind: "unknown" }
  return { message: String(cause), kind: "unknown" }
}


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

function networkCauses(error: Error): NonNullable<SdkWireError["networkCauses"]> {
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

const STACK_FRAMES = 8

/** Connect's status names by number: a ConnectError carries only the number. */
const CONNECT_CODES = [
  "ok", "canceled", "unknown", "invalid_argument", "deadline_exceeded", "not_found",
  "already_exists", "permission_denied", "resource_exhausted", "failed_precondition",
  "aborted", "out_of_range", "unimplemented", "internal", "unavailable", "data_loss",
  "unauthenticated",
]

const CrashCodeSchema = z.object({
  code: z.union([
    z.string(),
    z.number().int().transform((code) => CONNECT_CODES[code] ?? `code ${code}`),
  ]).optional().catch(undefined),
})

/** Says where a fatal error was thrown, never what it said: a message can quote provider input. */
export function crashSummary(cause: unknown): string {
  if (!(cause instanceof Error)) return `a thrown ${Object.prototype.toString.call(cause).slice(8, -1).toLowerCase()}`
  const named = CrashCodeSchema.safeParse(cause).data?.code
  const causes = networkCauses(cause)
  const frames = (cause.stack ?? "")
    .split("\n")
    .filter((line) => line.trimStart().startsWith("at "))
    .slice(0, STACK_FRAMES)
    .map((line) => line.trim().slice(3).replace(/(?:file:\/\/)?\/[^\s()]*\/((?:node_modules|dist-electron)\/)/g, "$1"))
  const head = [cause.name, named, causes.length > 0 ? `(${causes.join(", ")})` : undefined].filter(Boolean).join(" ")
  return [head, ...frames].join(" | ")
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


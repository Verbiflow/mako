import { turnFailedEvent, type TranscriptEvent } from "../events.js"
import { backgroundCommandLabel, PROVIDER_TURN_FALLBACK, subagentLabel } from "../provider-turn.js"

/** A synthetic message OpenCode writes to a session, live or stored; all but its text and description come from its metadata. */
export interface OpenCodeNotice {
  text?: string
  description?: string
  source?: string
  state?: string
  /** A background command's exit code, absent for one cancelled or removed. */
  exit?: number
  /** The signal that killed a background command (OpenCode 2.0.27 on). */
  signal?: string
}

/**
 * OpenCode writes a synthetic message to a session when work it left
 * running ends, and runs a turn on it if the session is idle:
 * - `metadata.source` "shell": a background command, state "completed",
 *   "error" or "cancelled", text `<shell id="…" state="…" command="…">output…</shell>`.
 *   Its exit and signal come from the metadata: the text's closing line is
 *   OpenCode's prose, reworded in 2.0.27;
 * - "subagent": a background subagent, state "completed" or "cancelled";
 * - none: its own notice, such as "The server restarted while you were working. …".
 */
export function openCodeNoticeLabel(notice: OpenCodeNotice): string {
  const { source, state } = notice
  const text = notice.text ?? ""
  if (source === "subagent")
    return subagentLabel({
      description: notice.description,
      state: state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : state === "error" ? "failed" : undefined,
    })
  if (source === "shell") {
    return backgroundCommandLabel({
      description: notice.description,
      command: /^<shell\b[^>]*\bcommand="([^"]*)"/.exec(text)?.[1],
      exitCode: notice.exit,
      signal: notice.signal,
      stopped: state === "cancelled",
      failed: state === "error",
    })
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 500) || PROVIDER_TURN_FALLBACK
}

/**
 * A synthetic message that only instructs the model, like the
 * `<system-reminder>` Plan mode writes ahead of each prompt. It isn't a
 * notice and opens no turn.
 */
export function isOpenCodeInstruction(notice: OpenCodeNotice): boolean {
  return notice.source === undefined && /^\s*<system-reminder>/.test(notice.text ?? "")
}

/** An error that ended an OpenCode turn, by its type (OpenCode 2) or name (OpenCode 1), live or stored. */
export function openCodeTurnFailed(kind: string | undefined, message: string): TranscriptEvent {
  const line = message.trim().split("\n", 1)[0]!.trim()
  return turnFailedEvent(kind ? failureClass(kind) : line.length > 160 ? `${line.slice(0, 159)}…` : line, message)
}

/** OpenCode 2 error types and OpenCode 1 error names, in plain words. */
const FAILURE_CLASSES = new Map([
  ["provider.invalid-output", "Invalid model response"],
  ["provider.invalid-request", "Request rejected"],
  ["provider.rate-limit", "Rate limited"],
  ["provider.quota", "Quota exceeded"],
  ["provider.auth", "Authentication failed"],
  ["provider.content-filter", "Blocked by content filter"],
  ["provider.transport", "Connection failed"],
  ["provider.connect", "Connection failed"],
  ["provider.no-route", "Model unavailable"],
  ["provider.unsupported-operation", "Not supported by the provider"],
  ["provider.internal", "Provider error"],
  ["provider.error", "Provider error"],
  ["provider.unknown", "Provider error"],
  ["ProviderAuthError", "Authentication failed"],
  ["APIError", "Provider error"],
  ["MessageOutputLengthError", "Output too long"],
  ["ContextOverflowError", "Context too long"],
  ["StructuredOutputError", "Invalid structured output"],
  ["UnknownError", "Unknown error"],
])

function failureClass(kind: string): string {
  const known = FAILURE_CLASSES.get(kind)
  if (known) return known
  const words = kind.replace(/Error$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ").trim().toLowerCase()
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Error"
}

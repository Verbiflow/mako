import { event, turnFailedEvent, usageLimitEvent, type TranscriptEvent } from "../events.js"
import { backgroundCommandTurn, PROVIDER_TURN_FALLBACK, subagentTurn, UNNAMED_TURN, type ProviderTurnCause } from "../provider-turn.js"

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
  return openCodeNoticeTurn(notice).reason
}

/**
 * What OpenCode says inside its `<shell>` or `<subagent>` notice, without
 * its own closing words, which the line already says ("Command exited with
 * code 1.", "Killed by SIGKILL", "(no output)", "Subagent cancelled").
 */
function noticeContent(text: string, tag: "shell" | "subagent"): string | undefined {
  const inner = NOTICE_CONTENT[tag].exec(text)?.[1]
  if (!inner) return undefined
  const lines = inner.split("\n")
  while (lines.length && (!lines.at(-1)!.trim() || OPENCODE_CLOSING.test(lines.at(-1)!.trim()))) lines.pop()
  const kept = lines.join("\n").trim()
  return kept || undefined
}

/** The tag's content; its attributes are quoted and may hold `>` (`command="make > build.log 2>&1"`). */
const NOTICE_CONTENT = {
  shell: /^\s*<shell\b(?:[^>"]|"[^"]*")*>\n?([\s\S]*?)\n?<\/shell>\s*$/,
  subagent: /^\s*<subagent\b(?:[^>"]|"[^"]*")*>\n?([\s\S]*?)\n?<\/subagent>\s*$/,
} as const

const OPENCODE_CLOSING = /^(?:\(no output\)|(?:Command )?exited with code -?\d+\.?|Killed by \w+\.?|Cancelled\.?|Command failed\.?|Subagent cancelled\.?)$/i

/** `openCodeNoticeLabel` with what settled, when the notice names work OpenCode ran, and what it printed or reported. */
export function openCodeNoticeTurn(notice: OpenCodeNotice): ProviderTurnCause {
  const { source, state } = notice
  const text = notice.text ?? ""
  if (source === "subagent")
    return subagentTurn({
      description: notice.description,
      state: state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : state === "error" ? "failed" : undefined,
      result: noticeContent(text, "subagent"),
    })
  if (source === "shell") {
    return backgroundCommandTurn({
      description: notice.description,
      command: /^<shell\b[^>]*\bcommand="([^"]*)"/.exec(text)?.[1],
      exitCode: notice.exit,
      signal: notice.signal,
      stopped: state === "cancelled",
      failed: state === "error",
      output: noticeContent(text, "shell"),
    })
  }
  const words = text.replace(/\s+/g, " ").trim().slice(0, 500)
  return words && words !== PROVIDER_TURN_FALLBACK ? { reason: words } : UNNAMED_TURN
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
  const failed = turnFailedEvent(kind ? failureClass(kind) : line.length > 160 ? `${line.slice(0, 159)}…` : line, message)
  return kind !== undefined && USAGE_LIMITS.has(kind) ? usageLimitEvent(failed) : failed
}

/**
 * The attempt OpenCode scheduled after a step's error, live
 * (`session.retry.scheduled`) or stored (a v2 step's `retry`, a v1 `retry`
 * part), so a retry the window saw is the marker its history keeps.
 */
export function openCodeRetried(attempt: number | undefined, message: string): TranscriptEvent | undefined {
  if (attempt === undefined && !message) return undefined
  const first = message.trim().split("\n", 1)[0]!.trim()
  const line = first.length > 160 ? `${first.slice(0, 159)}…` : first
  const detail = [attempt === undefined ? undefined : `attempt ${attempt}`, line].filter(Boolean).join(" · ")
  return { ...event("Retried", detail, line === message.trim() ? undefined : message), tone: "warning" }
}

/** The error types that are the account's usage limit refusing the turn. */
const USAGE_LIMITS = new Set(["provider.rate-limit", "provider.quota"])

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

/**
 * The markers a transcript draws between content — a compaction, a failed
 * turn, a provider notice. Live drivers and history readers build them here,
 * so a marker reads the same live and saved, on every harness.
 */

export type EventTone = "warning" | "error"

export interface TranscriptEvent {
  /** Short, and the same words for the same fact on every harness. */
  label: string
  /** One line beside the label. */
  detail?: string
  /** Long text the reader opens on demand: a compaction summary, an error body. */
  body?: string
  tone?: EventTone
  /**
   * A fact about how the harness is set up rather than about this
   * conversation's work: an MCP server that did not start, a configuration
   * warning, a setting imported from another tool. Every session start
   * reports it again, so a conversation keeps the first of each (same label
   * and detail) and the transcript gathers them into one row.
   */
  setup?: boolean
}

export const MCP_SERVER_FAILED = "MCP server failed"

/**
 * Why an MCP server did not start, in the words every harness shares, first
 * match wins. Each harness words the same failure its own way (Codex's
 * "handshaking with MCP server failed", OpenCode's "MCP error -32000:
 * Connection closed", Grok's "handshake failed"); its own text stays in the
 * marker's body.
 */
const MCP_REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:sign[ -]?in|log[ -]?in|(?:re)?authentication|auth(?:orization)?)[ _-]required\b|\bneeds?[ _-]auth\b|\bunauthori[sz]ed\b|\b401\b/i, "sign-in required"],
  [/\bsetup[ _-]required\b/i, "setup required"],
  [/could not be launched|\bENOENT\b|\bEACCES\b|NotFound: ChildProcess\.spawn|cannot find binary|command not found|executable not found|no such file or directory|\bspawn\b.*\bE[A-Z]{3,}\b/i, "could not be launched"],
  [/\btimed? ?out\b|\btimeout\b|deadline exceeded/i, "timed out"],
  [/could not connect|handshak|initiali[sz]e response|connection (?:closed|refused|reset)|transport (?:closed|error)|send message error|\bEPIPE\b|\bECONNRE(?:SET|FUSED)\b|process exited|exited with (?:code|status)|-32000\b/i, "could not connect"],
]

/** An MCP server the harness could not start, in the same words on every harness. */
export function mcpServerFailedEvent(server: string, reason?: string): TranscriptEvent {
  const whole = reason?.trim() ?? ""
  const shared = MCP_REASONS.find(([pattern]) => pattern.test(whole))?.[1]
  const line = shared ?? whole.split("\n", 1)[0]!.trim()
  const short = line.length > DETAIL_LENGTH ? `${line.slice(0, DETAIL_LENGTH - 1).trimEnd()}…` : line
  return {
    ...event(MCP_SERVER_FAILED, short ? `${server} · ${short}` : server, short === whole ? undefined : whole),
    tone: "warning",
    setup: true,
  }
}

/** A setup notice for one already kept: the same fact from a later session start. */
export function sameSetupEvent(left: TranscriptEvent, right: TranscriptEvent): boolean {
  return Boolean(left.setup && right.setup) && left.label === right.label && left.detail === right.detail
}

export const CONTEXT_COMPACTED = "Context compacted"
export const COMPACTION_FAILED = "Compaction failed"
export const TURN_FAILED = "Turn failed"
export const INTERRUPTED = "Interrupted"

export interface Compaction {
  trigger?: "automatic" | "manual"
  tokensBefore?: number
  tokensAfter?: number
  /** What the provider kept of the earlier conversation, when it says. */
  summary?: string
  /** How long compacting took, from the provider or from when it said it started. */
  durationMs?: number
}

export function compactionEvent(compaction: Compaction = {}): TranscriptEvent {
  const { trigger, tokensBefore, tokensAfter, durationMs } = compaction
  const tokens = tokensBefore
    ? tokensAfter !== undefined
      ? `${tokenCount(tokensBefore)} → ${tokenCount(tokensAfter)} tokens`
      : `from ${tokenCount(tokensBefore)} tokens`
    : undefined
  const took = durationMs !== undefined && durationMs >= 1000 ? `took ${durationText(durationMs)}` : undefined
  return event(CONTEXT_COMPACTED, [trigger && TRIGGER[trigger], tokens, took].filter(Boolean).join(" · "), compaction.summary)
}

/** Elapsed time at the precision a person reads it: "8s", "1m 04s", "1h 02m". */
export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

export function compactionFailedEvent(reason?: string): TranscriptEvent {
  return { ...event(COMPACTION_FAILED, reason), tone: "warning" }
}

export function turnFailedEvent(reason?: string, body?: string): TranscriptEvent {
  return { ...event(TURN_FAILED, reason, body), tone: "error" }
}

/** A marker whose empty detail and body are left out, so saved entries stay small. */
export function event(label: string, detail?: string, body?: string): TranscriptEvent {
  const marker: TranscriptEvent = { label }
  const line = detail?.trim()
  const text = body?.trim()
  if (line) marker.detail = line
  if (text) marker.body = text
  return marker
}

/**
 * A marker for a provider's message of any length: its first line beside the
 * label, and the whole message to open when there is more than that line.
 */
export function messageEvent(label: string, message: string | undefined, tone?: EventTone): TranscriptEvent {
  const text = message?.trim() ?? ""
  const newline = text.indexOf("\n")
  const first = (newline === -1 ? text : text.slice(0, newline)).trim()
  const line = first.length > DETAIL_LENGTH ? `${first.slice(0, DETAIL_LENGTH - 1).trimEnd()}…` : first
  const marker = event(label, line, line === text ? undefined : text)
  if (tone) marker.tone = tone
  return marker
}

/** Longer first lines are cut here, and the whole message becomes the body. */
const DETAIL_LENGTH = 160

/** The provider moved the conversation to another model; `from` is left out when it isn't known. */
export function modelChangedEvent(from: string | undefined, to: string | undefined, reason?: string, body?: string): TranscriptEvent {
  const models = from && to ? `${from} → ${to}` : to
  return event("Model changed", [models, reason].filter(Boolean).join(" · "), body)
}

/** A native code as words: `rate_limit_exceeded` or `ServerError` reads "Rate limit exceeded", "Server error". */
export function plainWords(code: string): string {
  if (/\s/.test(code)) return code
  const words = code.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_.-]+/g, " ").trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The one-line text a marker reads as where only text fits: copy, export, search. */
export function eventText(entry: Pick<TranscriptEvent, "label" | "detail">): string {
  return entry.detail ? `${entry.label} — ${entry.detail}` : entry.label
}

const TRIGGER = { automatic: "Automatic", manual: "Manual" } as const

function tokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
}

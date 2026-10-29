/**
 * The markers a transcript draws between content — a compaction, a failed
 * turn, a provider notice. Live drivers and history readers build them here,
 * so a marker reads the same live and saved, on every harness.
 */

import { z } from "zod"
/**
 * The native record a marker stands for, and where what it shows was read,
 * so a marker can be traced to its record (`npm run decode -- --events`):
 * `via: "wire"` is a marker built from what the live wire said when no
 * stored record could be read, and `body` names the file a body came from
 * when the record itself doesn't hold it (a command's output file, or the
 * copy kept of it once that file is gone, `KeptOutputs`).
 */
export const NativeEventSourceSchema = z.object({
  harness: z.string().min(1),
  record: z.string().min(1),
  via: z.literal("wire").optional(),
  body: z.enum(["output-file", "kept-copy"]).optional(),
})
export type NativeEventSource = z.infer<typeof NativeEventSourceSchema>
export type EventTone = "warning" | "error"

/**
 * What settled when a provider reports background work it was running: the
 * cause of a turn it starts on its own, or a marker inside one. The label
 * keeps the provider's own sentence; this is what the transcript words its
 * line from, so it never parses that sentence.
 */
/** How long the work ran, when the provider says or both its ends are on record. */
const durationMs = z.number().int().nonnegative().optional()

/**
 * A usage limit of the account that refused work: a rate limit, a quota, a
 * plan's window. `window` is the harness's name for it in Mako's words
 * ("5-hour limit"), `resetsAt` when it lifts (epoch milliseconds), each only
 * when the harness says. One limit refuses every turn and every background
 * agent of the account until it lifts, so the transcript says it once for
 * all the work it stopped (`sameUsageLimit`).
 */
export const UsageLimitSchema = z.object({
  window: z.string().optional(),
  resetsAt: z.number().nonnegative().optional(),
})
export type UsageLimit = z.infer<typeof UsageLimitSchema>

export const TurnCauseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command"),
    /** The command's description, else the command line. */
    name: z.string().optional(),
    /** `unfinished`: it was still running when the session it belonged to ended. */
    outcome: z.enum(["finished", "failed", "stopped", "unfinished"]),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    durationMs,
  }),
  z.object({
    kind: z.literal("agent"),
    name: z.string().optional(),
    /**
     * The harness's id for the agent, when its word carries one: the native
     * id its child transcript is listed by, or the id of the call that
     * started it. Two agents can share a name; they never share this.
     */
    agentId: z.string().optional(),
    outcome: z.enum(["finished", "failed", "stopped"]),
    durationMs,
    /** A usage limit ended it, when the harness says so; the rest of what it said is the event's body. */
    limit: UsageLimitSchema.optional(),
  }),
  /** A watch the agent left running (Claude Code's Monitor): one of its events, or its end. */
  z.object({
    kind: z.literal("monitor"),
    name: z.string().optional(),
    outcome: z.enum(["event", "ended"]),
    /** The first line of what it reported; the whole report is the event's body. */
    output: z.string().optional(),
  }),
  /** Background work the provider doesn't say more about. */
  z.object({
    kind: z.literal("task"),
    name: z.string().optional(),
    outcome: z.enum(["finished", "progress"]),
    durationMs,
  }),
  /** The provider took its next turn toward a goal it holds. */
  z.object({
    kind: z.literal("goal"),
    /** The goal's objective, its first line; the whole objective is the event's body. */
    objective: z.string().optional(),
  }),
])
export type TurnCause = z.infer<typeof TurnCauseSchema>

/**
 * A provider's retries of the model, measured by Mako as they streamed: how
 * many it made, from its first retry notice to the answer that ended them
 * (`recovered`) or the failure it gave up on. Mako draws one marker for them
 * (`retriesEvent`); no harness's record keeps that measure.
 */
export const RetriesSchema = z.object({
  count: z.number().int().positive(),
  outcome: z.enum(["recovered", "gave-up"]),
  durationMs,
})
export type Retries = z.infer<typeof RetriesSchema>

export interface TranscriptEvent {
  /** Native identity, when the source provides one. Never a generated replay ID. */
  source?: z.infer<typeof NativeEventSourceSchema>
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
  /** Background work that settled, when that is what the marker reports. */
  cause?: TurnCause
  /** The marker reports a usage limit refusing work (`usageLimitEvent`). */
  limit?: UsageLimit
  /**
   * The marker warns that a usage limit of the account is near, before it
   * refuses anything. The harness says so again each time it starts, and
   * Mako restarts harnesses often, so a conversation keeps the first warning
   * for each window and reset (`sameNearLimit`) and drops the rest.
   */
  nearLimit?: UsageLimit
  /** The marker sums up a provider's retries (`retriesEvent`). */
  retries?: Retries
}

/** `marker` as the report of a usage limit, with what the harness said of it. */
export function usageLimitEvent<T extends TranscriptEvent>(marker: T, limit: UsageLimit = {}): T {
  return { ...marker, limit }
}

/** A warning for a window the conversation was already warned of: the same harness, window and reset. */
export function sameNearLimit(left: TranscriptEvent, right: TranscriptEvent): boolean {
  return left.nearLimit !== undefined && right.nearLimit !== undefined &&
    left.nearLimit.window === right.nearLimit.window &&
    left.source?.harness === right.source?.harness &&
    sameUsageLimit(left.nearLimit, right.nearLimit)
}

/** Resets this close together are one reset, said by two clocks or two roundings. */
const SAME_RESET_MS = 90_000

/**
 * Whether two reports name the same limit: whatever both say of the window
 * and the reset agrees. A report that says neither is the same as any.
 */
export function sameUsageLimit(left: UsageLimit, right: UsageLimit): boolean {
  if (left.window !== undefined && right.window !== undefined && left.window !== right.window) return false
  return left.resetsAt === undefined || right.resetsAt === undefined || Math.abs(left.resetsAt - right.resetsAt) <= SAME_RESET_MS
}

/**
 * Whether a harness's words for why work failed name a usage limit rather
 * than another failure (an overloaded server, a crash). Read only from an
 * error's own words, never from what an agent reported, which may discuss
 * limits as its subject.
 */
export function namesUsageLimit(error: string | undefined): boolean {
  return error !== undefined && USAGE_LIMIT_WORDS.test(error)
}

/** When a limit lifts (epoch milliseconds) in the reader's own clock, as short as it can be and still be unambiguous. */
export function resetTime(at: number, clock: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  const now = new Date(clock)
  if (date.toDateString() === now.toDateString()) return time
  if (date.getTime() - now.getTime() < 6 * 86_400_000)
    return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

const USAGE_LIMIT_WORDS =
  /\b(?:rate[ _-]?limit(?:ed)?|usage[ _-]limit|(?:session|weekly|daily|monthly|5-hour|hourly) limit|quota(?:[ _-](?:exceeded|exhausted))?|insufficient[ _-]quota|too many requests|resource[ _-]exhausted)\b|\b429\b/i

export const MCP_SERVER_FAILED = "MCP server failed"

/**
 * Why an MCP server did not start, in the words every harness shares, first
 * match wins. Each harness words the same failure its own way (Codex's
 * "handshaking with MCP server failed", OpenCode's "MCP error -32000:
 * Connection closed", Grok's "handshake failed"); its own text stays in the
 * marker's body.
 */
const MCP_REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\b(?:sign[ -]?in|log[ -]?in|(?:re)?authentication|auth(?:orization)?)[ _-]required\b|\bneeds?[ _-]auth\b|\bunauthori[sz]ed\b|\b401\b/i,
    "sign-in required",
  ],
  [/\bsetup[ _-]required\b/i, "setup required"],
  [
    /could not be launched|\bENOENT\b|\bEACCES\b|NotFound: ChildProcess\.spawn|cannot find binary|command not found|executable not found|no such file or directory|\bspawn\b.*\bE[A-Z]{3,}\b/i,
    "could not be launched",
  ],
  [/\btimed? ?out\b|\btimeout\b|deadline exceeded/i, "timed out"],
  [
    /could not connect|handshak|initiali[sz]e response|connection (?:closed|refused|reset)|transport (?:closed|error)|send message error|\bEPIPE\b|\bECONNRE(?:SET|FUSED)\b|process exited|exited with (?:code|status)|-32000\b/i,
    "could not connect",
  ],
]

/** An MCP server the harness could not start, in the same words on every harness. */
export function mcpServerFailedEvent(
  server: string,
  reason?: string
): TranscriptEvent {
  const whole = reason?.trim() ?? ""
  const shared = MCP_REASONS.find(([pattern]) => pattern.test(whole))?.[1]
  const line = shared ?? whole.split("\n", 1)[0]!.trim()
  const short =
    line.length > DETAIL_LENGTH
      ? `${line.slice(0, DETAIL_LENGTH - 1).trimEnd()}…`
      : line
  return {
    ...event(
      MCP_SERVER_FAILED,
      short ? `${server} · ${short}` : server,
      short === whole ? undefined : whole
    ),
    tone: "warning",
    setup: true,
  }
}

/**
 * A setup notice for one already kept: the same fact from a later start of
 * the same harness. Another harness saying the same words is another fact:
 * a conversation switched from Claude Code to Devin, whose servers are each
 * configured on their own, once dropped Devin's "MCP server failed" because
 * Claude Code had said the same. A notice that names no source (Devin's,
 * Grok's, from the ACP wire) is never the same as one that names a harness.
 */
export function sameSetupEvent(
  left: TranscriptEvent,
  right: TranscriptEvent
): boolean {
  return (
    Boolean(left.setup && right.setup) &&
    left.label === right.label &&
    left.detail === right.detail &&
    left.source?.harness === right.source?.harness
  )
}

export const CONTEXT_COMPACTED = "Context compacted"
export const COMPACTION_FAILED = "Compaction failed"
export const TURN_FAILED = "Turn failed"
export const INTERRUPTED = "Interrupted"
/** The harness ended the turn by its own rule, neither stopped by the person nor failed; the detail says which rule. */
export const TURN_ENDED = "Turn ended"

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
  const took =
    durationMs !== undefined && durationMs >= 1000
      ? `took ${durationText(durationMs)}`
      : undefined
  return event(
    CONTEXT_COMPACTED,
    [trigger && TRIGGER[trigger], tokens, took].filter(Boolean).join(" · "),
    compaction.summary
  )
}

/**
 * `marker` as the person's own compaction. Grok 1.0.46 reports /compact
 * with `auto_compact_completed`, the notice of its own compactions.
 */
export function manualCompaction<T extends Pick<TranscriptEvent, "label" | "detail">>(marker: T): T {
  if (marker.label !== CONTEXT_COMPACTED || !marker.detail?.startsWith(TRIGGER.automatic)) return marker
  return { ...marker, detail: TRIGGER.manual + marker.detail.slice(TRIGGER.automatic.length) }
}

/** Elapsed time at the precision a person reads it: "8s", "1m 04s", "1h 02m". */
export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60)
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

export function compactionFailedEvent(reason?: string): TranscriptEvent {
  return { ...event(COMPACTION_FAILED, reason), tone: "warning" }
}

export function turnFailedEvent(
  reason?: string,
  body?: string
): TranscriptEvent {
  return { ...event(TURN_FAILED, reason, body), tone: "error" }
}

/**
 * The marker for a provider's retries once they end, a quiet line either way:
 * "Recovered after 3 retries", or "Retried 5 times" before the failure the
 * provider gave up on, which says the failure itself. `reason` is the
 * provider's own words for what failed, as it gave them while it retried; the
 * label says the outcome on every harness alike.
 */
export function retriesEvent(retries: Retries, reason?: string): TranscriptEvent {
  const marker = event(retriesLabel(retries), reason)
  marker.retries = retries
  return marker
}

/** "Recovered after 3 retries", or, before a failure, "Retried 5 times", "Retried once". */
export function retriesLabel({ count, outcome }: Pick<Retries, "count" | "outcome">): string {
  if (outcome === "gave-up") return `Retried ${count === 1 ? "once" : `${count} times`}`
  return `Recovered after ${count} ${count === 1 ? "retry" : "retries"}`
}

/** A marker whose empty detail and body are left out, so saved entries stay small. */
export function event(
  label: string,
  detail?: string,
  body?: string
): TranscriptEvent {
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
export function messageEvent(
  label: string,
  message: string | undefined,
  tone?: EventTone
): TranscriptEvent {
  const text = message?.trim() ?? ""
  const newline = text.indexOf("\n")
  const first = (newline === -1 ? text : text.slice(0, newline)).trim()
  const line =
    first.length > DETAIL_LENGTH
      ? `${first.slice(0, DETAIL_LENGTH - 1).trimEnd()}…`
      : first
  const marker = event(label, line, line === text ? undefined : text)
  if (tone) marker.tone = tone
  return marker
}

/** Longer first lines are cut here, and the whole message becomes the body. */
const DETAIL_LENGTH = 160

/** The provider moved the conversation to another model; `from` is left out when it isn't known. */
export function modelChangedEvent(
  from: string | undefined,
  to: string | undefined,
  reason?: string,
  body?: string
): TranscriptEvent {
  const models = from && to ? `${from} → ${to}` : to
  return event(
    "Model changed",
    [models, reason].filter(Boolean).join(" · "),
    body
  )
}

/** A native code as words: `rate_limit_exceeded` or `ServerError` reads "Rate limit exceeded", "Server error". */
export function plainWords(code: string): string {
  if (/\s/.test(code)) return code
  const words = code
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .trim()
    .toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The one-line text a marker reads as where only text fits: copy, export, search. */
export function eventText(
  entry: Pick<TranscriptEvent, "label" | "detail">
): string {
  return entry.detail ? `${entry.label} — ${entry.detail}` : entry.label
}

const TRIGGER = { automatic: "Automatic", manual: "Manual" } as const

function tokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
}

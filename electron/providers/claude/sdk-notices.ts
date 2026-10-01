import type {
  HookCallback,
  SDKMessage,
  SDKRateLimitInfo,
  SDKResultMessage,
  TerminalReason,
} from "@anthropic-ai/claude-agent-sdk"
import { compactionFailedEvent, event, messageEvent, modelChangedEvent, turnFailedEvent, type TranscriptEvent } from "@mako/sessions/events"
import type { NativeNotice } from "../../shared.js"
import { claudeMessageKind, knownClaudeMessageKind } from "./sdk-message-kinds.js"

const NOTHING: readonly NativeNotice[] = []

/**
 * What Claude's own reports mean in Mako's shared vocabulary: compaction,
 * retries, usage limits, model fallbacks, notices and why a turn stopped.
 * One per session, so a limit or notification Claude repeats is said once.
 */
export class ClaudeNotices {
  /** Claude said it is compacting and has not yet said it stopped. */
  private compacting = false
  /** What the PostCompact hook reported, for the boundary that follows it. */
  private summary: string | undefined
  private readonly said = new Set<string>()
  /** The turn's refusal is already on record; its `refusal` stop adds nothing. */
  private refused = false

  readonly hook: HookCallback = async (input) => {
    if (input.hook_event_name === "PostCompact" && !input.agent_id) this.summary = input.compact_summary
    return {}
  }

  /** `undefined` for a message this SDK does not declare. */
  decode(message: SDKMessage): readonly NativeNotice[] | undefined {
    if (!knownClaudeMessageKind(claudeMessageKind(message))) return undefined
    if (message.type === "rate_limit_event") return this.rateLimit(message.rate_limit_info)
    if (message.type === "result") return this.stopped(message)
    if (message.type !== "system") return NOTHING
    switch (message.subtype) {
      case "status":
        if (message.status === "compacting") {
          this.compacting = true
          return [{ kind: "activity", activity: { kind: "compacting" } }]
        }
        if (!this.compacting) return NOTHING
        this.compacting = false
        return message.compact_result === "failed"
          ? [{ kind: "event", event: compactionFailedEvent(message.compact_error) }, { kind: "activity", activity: null }]
          : [{ kind: "activity", activity: null }]
      case "compact_boundary": {
        const { trigger, pre_tokens, post_tokens, duration_ms } = message.compact_metadata
        const summary = this.summary
        this.compacting = false
        this.summary = undefined
        return [{ kind: "compacted", compaction: {
          trigger: trigger === "auto" ? "automatic" : "manual",
          tokensBefore: pre_tokens,
          tokensAfter: post_tokens,
          durationMs: duration_ms,
          summary,
        } }]
      }
      case "api_retry":
        return [{ kind: "activity", activity: {
          kind: "retrying",
          attempt: message.attempt,
          maxAttempts: message.max_retries,
          reason: message.no_response
            ? "No response from the API"
            : `${sentence(message.error)}${message.error_status ? ` (${message.error_status})` : ""}`,
          retryAt: Date.now() + message.retry_delay_ms,
        } }]
      case "model_refusal_fallback":
        return notice(modelChangedEvent(
          message.original_model,
          message.fallback_model,
          message.scope === "local" ? "for one reply after a refusal" : "after a refusal",
          refusalText(message.content, message.api_refusal_explanation),
        ))
      case "model_refusal_no_fallback":
        this.refused = true
        return notice(turnFailedEvent(`${message.original_model} declined the request`,
          refusalText(message.content, message.api_refusal_explanation)))
      case "informational":
        // `info` is the CLI's transcript-mode detail; a tool's progress line is superseded by its result.
        if (message.level === "info" || message.tool_use_id) return NOTHING
        return notice(message.level === "warning" ? warning(message.content) : messageEvent("Notice", message.content))
      case "notification":
        return this.once(`notification\0${message.key}\0${message.text}`) ? notice(messageEvent("Notice", message.text)) : NOTHING
      case "local_command_output":
        return notice(messageEvent("Notice", message.content))
      case "hook_response":
        return message.outcome === "error"
          ? notice({ ...event("Warning", `${message.hook_name} hook failed`, message.stderr || message.output), tone: "warning" })
          : NOTHING
      default:
        return NOTHING
    }
  }

  private rateLimit(info: SDKRateLimitInfo): readonly NativeNotice[] {
    if (info.status === "allowed" || !this.once(`limit\0${info.status}\0${info.rateLimitType}\0${info.resetsAt}`)) return NOTHING
    const limit = info.rateLimitType ? LIMITS[info.rateLimitType] : "usage limit"
    const resets = info.resetsAt ? `resets ${resetTime(info.resetsAt)}` : ""
    if (info.status === "allowed_warning") return notice(warning(line(`Approaching your ${limit}`, resets)))
    if (info.isUsingOverage) return notice(event("Notice", `Reached your ${limit} · using extra usage`))
    return notice({ ...event("Rate limited", line(`Reached your ${limit}`, resets)), tone: "warning" })
  }

  /** A turn that ended for a reason worth knowing. A failed turn's error shows on its request instead. */
  private stopped(message: SDKResultMessage): readonly NativeNotice[] {
    const refused = this.refused
    this.refused = false
    if (message.is_error || (refused && message.stop_reason === "refusal")) return NOTHING
    const reason = claudeStopReason(message)
    return reason ? notice(warning(reason)) : NOTHING
  }

  private once(key: string): boolean {
    if (this.said.has(key)) return false
    this.said.add(key)
    return true
  }
}

/** Why the turn stopped, in plain words, unless it simply finished or was stopped. */
export function claudeStopReason(message: SDKResultMessage): string | undefined {
  return (message.terminal_reason && TERMINAL[message.terminal_reason]) ||
    (message.stop_reason ? STOPS.get(message.stop_reason) : undefined)
}

const TERMINAL = {
  blocking_limit: "The context window is full",
  rapid_refill_breaker: "The context refilled too fast after compaction",
  prompt_too_long: "The conversation is too long for the model",
  image_error: "An image could not be processed",
  model_error: "The model failed",
  api_error: "The API failed",
  malformed_tool_use_exhausted: "Tool calls kept arriving malformed",
  stop_hook_prevented: "A stop hook ended the turn",
  hook_stopped: "A hook ended the turn",
  max_turns: "Reached the turn limit",
  budget_exhausted: "Reached the spending limit",
  structured_output_retry_exhausted: "Structured output kept failing validation",
  tool_deferred_unavailable: "A deferred tool was unavailable",
  turn_setup_failed: "The turn could not start",
  completed: undefined,
  aborted_streaming: undefined,
  aborted_tools: undefined,
  tool_deferred: undefined,
  background_requested: undefined,
} satisfies Record<TerminalReason, string | undefined>

const STOPS = new Map([
  ["max_tokens", "The reply hit the output token limit"],
  ["model_context_window_exceeded", "The reply hit the context window limit"],
  ["refusal", "The model declined to continue"],
])

const LIMITS = {
  five_hour: "5-hour limit",
  seven_day: "weekly limit",
  seven_day_opus: "weekly Opus limit",
  seven_day_sonnet: "weekly Sonnet limit",
  seven_day_overage_included: "weekly limit",
  overage: "extra usage limit",
} satisfies Record<NonNullable<SDKRateLimitInfo["rateLimitType"]>, string>

function notice(marker: TranscriptEvent): NativeNotice[] {
  return [{ kind: "event", event: marker }]
}

function warning(text: string): TranscriptEvent {
  return messageEvent("Warning", text, "warning")
}

function refusalText(content: string, explanation: string | null | undefined): string {
  return explanation ? `${content}\n\n${explanation}` : content
}

function line(...parts: string[]): string {
  return parts.filter(Boolean).join(" · ")
}

/** A reset time in the host's own clock, as short as it can be and still be unambiguous. */
function resetTime(at: number): string {
  // Claude Code reports epoch seconds; a millisecond value reads the same.
  const date = new Date(at < 1e12 ? at * 1000 : at)
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  const now = new Date()
  if (date.toDateString() === now.toDateString()) return time
  if (date.getTime() - now.getTime() < 6 * 86_400_000)
    return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function sentence(code: string): string {
  const words = code.replace(/_/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

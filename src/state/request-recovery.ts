import { describePromptRecovery } from "@mako/host/contracts/prompt-recovery"
import type { InterruptionReason, LiveRequest } from "@/lib/types"
import { turnStopLabel, type TurnStop } from "@/state/prompt-delivery"

/**
 * What a person can do about a message that didn't finish. One of them is
 * the row's own button, chosen by why it failed; the rest wait in its menu.
 */
export type RecoveryAction =
  /** Send the same words and attachments again: "Send again" when the agent never got them, "Send another copy" otherwise. */
  | { kind: "resend"; label: string }
  /** Send them again, held until the usage limit resets (`LiveRequest.wake`). */
  | { kind: "resume-at"; at: number; label: string }
  /** Tell the person when the limit resets, without sending anything. */
  | { kind: "remind-at"; at: number }
  | { kind: "sign-in" }
  /** Compact the conversation, then send the message again once that finished. */
  | { kind: "compact" }
  /** Start a new thread with this message: the only way past a history the model refuses. */
  | { kind: "fresh" }
  | { kind: "settings"; section: "agents" | "mcp" }
  | { kind: "restore" }
  | { kind: "copy" }

export interface RequestRecovery {
  /** The outcome, in one line: "Model temporarily unavailable", "Usage limit reached". */
  title: string
  /** Said after the title on the same line: "resets 3:40 PM". */
  description?: string
  /** What to do about it, in one sentence. */
  guidance?: string
  /** A limit or a stop is a wait, not a fault. */
  tone: "danger" | "caution"
  /** Whether the agent got the message, said for the person: the disclosure's first line. */
  delivery: string
  primary?: RecoveryAction
  more: RecoveryAction[]
}

export interface RecoveryContext {
  /** The harness's display name. */
  provider: string
  /** A compaction this request asked for finished: a full context may now fit. */
  compacted?: boolean
  /** The harness compacts when Mako asks it to. */
  canCompact?: boolean
  /** When the account's spent limit gives its room back, when a reading says so. */
  resetAt?: number | null
  now?: number
}

/** "3:40 PM" today, "Tue 3:40 PM" within the week, a date beyond it. */
export function clockText(at: number, now = Date.now()): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  if (new Date(now).toDateString() === date.toDateString()) return time
  if (at - now < 6 * 86_400_000) return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`
}

/** A limit Mako knows the end of: the request failed on it and the account's reading names its reset. */
export function usageLimitReset(request: Pick<LiveRequest, "status" | "failure">, resetAt: number | null | undefined, now = Date.now()): number | undefined {
  if (request.status !== "failed" || (request.failure !== "rate-limited" && request.failure !== "plan")) return undefined
  return resetAt !== null && resetAt !== undefined && resetAt > now ? resetAt : undefined
}

/** A new thread opens in the same folder over the same transport, so it can't escape these. */
const NO_FRESH_ESCAPE = new Set<LiveRequest["failure"]>(["auth", "transport-limit", "missing-folder", "launch-failed"])

/**
 * The recovery a request offers, from what the host decided about it (its
 * failure kind and delivery evidence) and nothing else: the renderer never
 * reads the provider's words. Every distinction `describePromptRecovery`
 * makes is kept; only where they're said changes.
 */
export function requestRecovery(
  request: Pick<LiveRequest, "status" | "failure" | "nativeDelivery" | "interruption">,
  context: RecoveryContext
): RequestRecovery {
  const now = context.now ?? Date.now()
  const recovery = describePromptRecovery(request, context.provider, context.compacted)
  const failure = recovery.failure
  const failed = request.status === "failed"
  const reset = usageLimitReset(request, context.resetAt, now)
  const resend: RecoveryAction | undefined = recovery.resendLabel ? { kind: "resend", label: recovery.resendLabel } : undefined
  const fresh: RecoveryAction | undefined = failed && !NO_FRESH_ESCAPE.has(request.failure) ? { kind: "fresh" } : undefined
  const settings: RecoveryAction | undefined =
    failed && request.failure === "launch-stalled" ? { kind: "settings", section: "mcp" }
      : failed && (request.failure === "auth" || request.failure === "wrong-account" || request.failure === "plan" || request.failure === "launch-failed")
        ? { kind: "settings", section: "agents" }
        : undefined

  let primary: RecoveryAction | undefined
  if (reset !== undefined) primary = { kind: "resume-at", at: reset, label: `${request.nativeDelivery?.evidence.kind === "not-accepted" ? "Resume" : "Send a copy"} at ${clockText(reset, now)}` }
  else if (failed && request.failure === "auth") primary = { kind: "sign-in" }
  else if (failed && request.failure === "context-exhausted") primary = resend ?? (context.canCompact ? { kind: "compact" } : fresh)
  else if (failed && request.failure === "transcript-rejected") primary = fresh
  else if (resend) primary = resend
  else if (settings) primary = settings
  else if (failed && request.failure === "missing-folder") primary = { kind: "copy" }
  else primary = { kind: "restore" }

  const candidates: Array<RecoveryAction | undefined> = [
    reset !== undefined ? { kind: "remind-at", at: reset } : undefined,
    resend,
    fresh,
    { kind: "restore" },
    { kind: "copy" },
    settings,
  ]
  const more = candidates.filter((action): action is RecoveryAction => action !== undefined && !sameAction(action, primary))

  const stopped = request.interruption?.reason
  return {
    title: reset !== undefined ? "Usage limit reached" : recovery.title,
    description: reset !== undefined ? `resets ${clockText(reset, now)}` : undefined,
    guidance: reset !== undefined
      ? "Mako can send it again when the limit resets."
      : failure?.guidance
        ?? (request.status === "uncertain" ? "Check the conversation before sending it again."
          : stopped ? `${turnStopLabel(stopped, context.provider)}.` : undefined),
    tone: reset !== undefined || request.failure === "rate-limited" || request.status !== "failed" ? "caution" : "danger",
    delivery: recovery.delivery,
    primary,
    more,
  }
}

function sameAction(left: RecoveryAction, right: RecoveryAction | undefined): boolean {
  return right !== undefined && left.kind === right.kind
}

/** The label each action reads as in the row's menu or as its button. */
export function recoveryLabel(action: RecoveryAction): string {
  switch (action.kind) {
    case "resend":
    case "resume-at":
      return action.label
    case "remind-at":
      return "Notify me at reset"
    case "sign-in":
      return "Sign in"
    case "compact":
      return "Compact and retry"
    case "fresh":
      return "Use in new thread"
    case "settings":
      return action.section === "mcp" ? "MCP settings" : "Agents settings"
    case "restore":
      return "Restore to composer"
    case "copy":
      return "Copy message"
  }
}

/**
 * What the composer's send button offers while its draft is empty: go on
 * with the newest turn when Mako's exit or the provider cut it short, or send
 * the newest message again when a repeat can work. A user's Stop, a turn Mako
 * continues itself, a sign-out pause and a usage limit with a known reset (its
 * row offers the timed send) offer nothing here.
 */
export type ComposerResume =
  | { kind: "continue"; reason: InterruptionReason; label: string }
  | { kind: "resend"; request: LiveRequest; label: string }

export function composerResume(
  requests: readonly LiveRequest[],
  stops: ReadonlyMap<string, TurnStop>,
  context: Pick<RecoveryContext, "provider" | "compacted" | "resetAt" | "now">
): ComposerResume | null {
  const newest = requests.findLast((request) => request.status !== "canceled")
  if (!newest) return null
  const stop = stops.get(newest.id)
  if (stop?.continuable) return { kind: "continue", reason: stop.reason, label: "Continue turn" }
  if (newest.status !== "failed" || usageLimitReset(newest, context.resetAt, context.now) !== undefined) return null
  const label = describePromptRecovery(newest, context.provider, context.compacted).resendLabel
  return label ? { kind: "resend", request: newest, label } : null
}

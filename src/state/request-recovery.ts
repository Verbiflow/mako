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
  /** Ask the agent to go on from where it was: it got the message and its work so far stands. */
  | { kind: "continue"; reason: InterruptionReason }
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
  const failed = request.status === "failed"
  const reset = usageLimitReset(request, context.resetAt, now)
  const resend: RecoveryAction | undefined = recovery.resendLabel ? { kind: "resend", label: recovery.resendLabel } : undefined
  const fresh: RecoveryAction | undefined = failed && !NO_FRESH_ESCAPE.has(request.failure) ? { kind: "fresh" } : undefined
  const settings: RecoveryAction | undefined =
    failed && request.failure === "launch-stalled" ? { kind: "settings", section: "mcp" }
      : failed && (request.failure === "auth" || request.failure === "wrong-account" || request.failure === "plan" || request.failure === "launch-failed")
        ? { kind: "settings", section: "agents" }
        : undefined

  const evidence = deliveryKnown(request)
  // The agent got it and the connection only dropped: its work stands, so it goes on rather than starting over.
  const carryOn: RecoveryAction | undefined = failed && request.failure === "network" && evidence === "received" ? { kind: "continue", reason: "connection-lost" } : undefined

  let primary: RecoveryAction | undefined
  if (reset !== undefined) primary = { kind: "resume-at", at: reset, label: `${evidence === "never" ? "Resume" : "Send a copy"} at ${clockText(reset, now)}` }
  else if (carryOn) primary = carryOn
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

  return {
    title: reset !== undefined ? "Usage limit reached" : recovery.title,
    description: reset !== undefined ? `resets ${clockText(reset, now)}` : undefined,
    guidance: recoveryGuidance(request, evidence, { ...context, compacted: context.compacted, reset: reset !== undefined }),
    tone: reset !== undefined || request.failure === "rate-limited" || request.status !== "failed" ? "caution" : "danger",
    delivery: recovery.delivery,
    primary,
    more,
  }
}

/** What the delivery evidence settles: the agent never got it, got it, or Mako can't tell. */
type Delivered = "never" | "received" | "unknown"

function deliveryKnown(request: Pick<LiveRequest, "nativeDelivery">): Delivered {
  const kind = request.nativeDelivery?.evidence.kind
  return kind === "not-accepted" ? "never" : kind === "accepted" ? "received" : "unknown"
}

/** What cut a turn the agent had begun short, as the end of "… got it before". */
function cause(failure: LiveRequest["failure"]): string {
  switch (failure) {
    case "network":
      return "the connection dropped"
    case "provider-unavailable":
      return "its service failed"
    case "rate-limited":
      return "it ran out of capacity"
    default:
      return "the turn ended"
  }
}

/**
 * The row's one sentence under its title: what happened to the message and
 * what is safe to do next, from the failure kind and what the delivery
 * evidence settles. The full delivery sentence and the provider's words stay
 * in Details.
 */
function recoveryGuidance(
  request: Pick<LiveRequest, "status" | "failure" | "interruption">,
  delivered: Delivered,
  context: RecoveryContext & { reset: boolean }
): string | undefined {
  const agent = context.provider
  const safe = delivered === "never"
    ? `It never reached ${agent}, so sending it again is safe.`
    : delivered === "received"
      ? `${agent} got it before ${cause(request.failure)}; check what it did before sending a copy.`
      : `Mako can't tell whether ${agent} got it; check the conversation before sending a copy.`
  if (request.status === "uncertain")
    return delivered === "received"
      ? `${agent} got it, but Mako can't tell whether it finished; check the conversation before sending a copy.`
      : `Mako can't tell whether ${agent} got it; check the conversation before sending a copy.`
  if (request.status === "interrupted") {
    const reason = request.interruption?.reason ?? "stopped"
    return reason === "stopped"
      ? "You stopped it before it was sent, so sending it again is safe."
      : `${turnStopLabel(reason, agent)} before it was sent, so sending it again is safe.`
  }
  if (context.reset)
    return delivered === "never" ? `It never reached ${agent}; Mako can send it when the limit resets.` : `${agent} stopped on its usage limit; Mako can send a copy when the limit resets.`
  switch (request.failure) {
    case "network":
      return delivered === "received" ? `${agent} got it before the connection dropped; continue the turn rather than sending a copy.` : safe
    case "rate-limited":
      return delivered === "never" ? `${agent} is over capacity and never got it, so sending it again in a little while is safe.` : safe
    case "provider-unavailable":
      return delivered === "never" ? `${agent}'s service failed before it got this, so sending it again is safe.` : safe
    case "launch-stalled":
      return `${agent} went quiet while starting, often on a slow MCP server; it never got the message, so sending it again is safe.`
    case "auth":
      return delivered === "received" ? `${agent} signed out after it got this; sign in again, then continue the turn.` : `${agent} is signed out; sign in again, then send it.`
    case "context-exhausted":
      return context.compacted
        ? "The conversation is compacted now, so the message may fit."
        : context.canCompact
          ? `Compacting the conversation makes room for ${agent} to take it again.`
          : `A new thread with this message gives ${agent} room to start over.`
    case "transcript-rejected":
      return `${agent}'s model refuses this session's history, so sending again won't help; a new thread starts clean and this one stays readable.`
    case "plan":
      return `Pick a model the plan covers, or another ${agent} account, in Settings › Agents.`
    case "wrong-account":
      return `${agent} is signed in as another account than this session's, so nothing was sent; fix it in Settings › Agents.`
    case "launch-failed":
      return `${agent} wouldn't start, so nothing was sent; what it said is under Details.`
    case "missing-folder":
      return `This thread's folder is gone, so ${agent} can't start here; restore it, or copy the message to a thread in a folder that exists.`
    case "transport-limit":
      return `Mako couldn't read a response this large from ${agent}; the message is kept, and an updated Mako can reopen the session.`
    case "resume-failed":
      return `Mako couldn't reopen this ${agent} session; the transcript and your message are kept, and a new thread can carry on.`
    case "rejected-input":
      return `${agent} refused the message as sent; change its text, attachments or model, then send it again.`
    default:
      return safe
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
    case "continue":
      return "Continue turn"
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
  if (newest.status !== "failed") return null
  // The same choice the failed row makes its button: one way to pick the turn up, said in two places.
  const primary = requestRecovery(newest, context).primary
  if (primary?.kind === "continue") return { kind: "continue", reason: primary.reason, label: "Continue turn" }
  return primary?.kind === "resend" ? { kind: "resend", request: newest, label: primary.label } : null
}

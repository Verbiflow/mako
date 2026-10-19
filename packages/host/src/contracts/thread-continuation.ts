import type { LiveSnapshot } from "./live-conversations.js"
import type { ThreadRef } from "@mako/sessions"
import type { ExternalThreadActivity } from "./host-events-boot.js"
import { heldReason } from "./session-hold.js"

/** Host-selected transport for a catalogued native session. */
export type ContinuationPlan =
  /** `makoUpdate`: its conversation isn't running and a newer Mako changed the session ledger, so a reply goes as `reason` says (`ledgerReply`). */
  | { transport: "attached"; provider: string; conversationId: string; reason?: string; makoUpdate?: true; notice?: LedgerNotice }
  | { transport: "live"; provider: string; nativeId: string }
  | { transport: "native"; provider: string }
  /**
   * `makoUpdate`: a newer Mako changed the session ledger, so this build doesn't resume the session (`resumeLedger`); updating Mako does.
   */
  | { transport: "handoff"; provider: string; reason: string; makoUpdate?: true; notice?: LedgerNotice }
  | { transport: "refused"; reason: string; makoUpdate?: true; notice?: LedgerNotice }
  | { transport: "unavailable"; reason: string }

export type OwnerResolution<Snapshot = LiveSnapshot> =
  /**
   * `ended`: its live session was ended. A reply still goes on in it; its saved history is what shows it.
   * `running`: whether its provider is connected now; one that isn't (hibernated, disconnected) resumes its session to reply.
   */
  | { kind: "attached"; conversationId: string; provider: string; snapshot: Snapshot; bindingId?: string; ended: boolean; running?: boolean }
  | { kind: "unowned" }
  | { kind: "unavailable"; reason: string }

export type ContinuationResolution<Snapshot = LiveSnapshot> =
  | Exclude<ContinuationPlan, { transport: "attached" }>
  | { transport: "attached"; provider: string; conversationId: string; snapshot: Snapshot; bindingId?: string; reason?: string; makoUpdate?: true; notice?: LedgerNotice }

export interface ContinuationInputs {
  /** The provider's live driver, if one is registered. */
  live: { available: boolean; canResume: boolean } | null
  /** The provider's headless CLI is installed. */
  nativeInstalled: boolean
  /** A run Mako started still owns the path; a native reply queues behind it. */
  running: boolean
  /** Another process has the store open or is answering in it. */
  external: ExternalThreadActivity["status"] | null
}

/**
 * A session this host may not resume because a newer Mako changed the
 * session ledger (`refusal`, `SessionMemory.resumeRefusal`, the same that
 * refuses the hold at send). A reply goes on from its transcript in a new
 * session where a live driver can start one: that session is new, so no
 * other host has it open or holds it. Without one, the reply waits for the
 * update and says why. Another host's hold is still said first, by name.
 */
export function resumeLedger(
  ref: Pick<ThreadRef, "harness" | "heldBy">,
  refusal: string,
  live: ContinuationInputs["live"]
): Extract<ContinuationPlan, { transport: "handoff" | "refused" }> {
  if (ref.heldBy) return { transport: "refused", reason: heldReason(ref.heldBy) }
  const reply = ledgerReply(ref.harness, refusal, live)
  return reply.transcript
    ? { transport: "handoff", provider: ref.harness, reason: reply.reason, makoUpdate: true, notice: reply.notice }
    : { transport: "refused", reason: reply.reason, makoUpdate: true, notice: reply.notice }
}

/**
 * The ledger's refusal as the composer shows it: what a newer Mako changed,
 * then what a reply does now, which the window words with the harness's
 * name (`ledgerReplyWords`). `reason` says both as one, with its id.
 */
export interface LedgerNotice {
  line: string
  reply: "transcript" | "waits"
  harness: string
}

/** What a reply does under the ledger's refusal, given the harness's name: a new session from its transcript, or a wait for the update. */
export function ledgerReplyWords(notice: Pick<LedgerNotice, "reply">, name: string): string {
  return notice.reply === "transcript"
    ? "A reply goes on from its transcript in a new session."
    : `${name} can't start a new session here to go on from its transcript, so a reply waits for the update.`
}

/** A reply under the ledger's refusal: the plan's reason, whether it goes on from the transcript, and the notice the composer shows. */
export interface LedgerReply {
  reason: string
  transcript: boolean
  notice: LedgerNotice
}

/** What a reply does under the ledger's refusal, in the words every plan uses: a new session from the transcript where a live driver can start one, else nothing until the update. */
export function ledgerReply(harness: string, refusal: string, live: ContinuationInputs["live"]): LedgerReply {
  const notice: LedgerNotice = { line: refusal, reply: live?.available ? "transcript" : "waits", harness }
  return { reason: `${refusal} ${ledgerReplyWords(notice, harness)}`, transcript: notice.reply === "transcript", notice }
}

export function planContinuation(
  ref: ThreadRef,
  inputs: ContinuationInputs
): Exclude<ContinuationPlan, { transport: "attached" }> {
  const provider = ref.harness
  if (ref.archived)
    return {
      transport: "handoff",
      provider,
      reason: "This history lives only in Mako's archive; its CLI no longer has the session.",
    }
  if (ref.resumeUnavailable)
    return { transport: "handoff", provider, reason: ref.resumeUnavailable }
  // Another Mako host has this session live. The installed app and a
  // development host share one catalog; before the ledger named the holder,
  // a reply from the second host ran `session/load` on a store the first
  // still had an agent on.
  if (ref.heldBy) return { transport: "refused", reason: heldReason(ref.heldBy) }
  if (inputs.external === "open" || ref.locked)
    return {
      transport: "refused",
      reason:
        "This session is open in another app. Close it there before replying, or fork it to continue separately.",
    }
  if (inputs.external === "active" || inputs.external === "needs-input")
    return {
      transport: "refused",
      reason: "This session is answering in another app. Wait for that turn to settle.",
    }
  const live = inputs.live
  if (
    live?.available &&
    live.canResume &&
    ref.liveResume !== false &&
    !inputs.running
  )
    return { transport: "live", provider, nativeId: ref.nativeId }
  if (inputs.nativeInstalled) return { transport: "native", provider }
  if (live?.available)
    return {
      transport: "handoff",
      provider,
      reason:
        ref.liveResume === false
          ? `${provider} cannot reopen this store; the history is handed to a new session.`
          : `${provider} cannot resume sessions; the history is handed to a new session.`,
    }
  return {
    transport: "refused",
    reason: `${provider} is not installed on this Mac, so this session cannot be continued here.`,
  }
}

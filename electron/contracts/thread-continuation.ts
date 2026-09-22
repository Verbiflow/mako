import type { LiveSnapshot } from "./live-conversations.js"
import type { ThreadRef } from "@mako/sessions"
import type { ExternalThreadActivity } from "./host-events-boot.js"
import { heldReason } from "./session-hold.js"

/** Host-selected transport for a catalogued native session. */
export type ContinuationPlan =
  | { transport: "attached"; provider: string; conversationId: string }
  | { transport: "live"; provider: string; nativeId: string }
  | { transport: "native"; provider: string }
  | { transport: "handoff"; provider: string; reason: string }
  | { transport: "refused"; reason: string }
  | { transport: "unavailable"; reason: string }

export type OwnerResolution<Snapshot = LiveSnapshot> =
  | { kind: "attached"; conversationId: string; provider: string; snapshot: Snapshot; bindingId?: string }
  | { kind: "unowned" }
  | { kind: "unavailable"; reason: string }

export type ContinuationResolution<Snapshot = LiveSnapshot> =
  | Exclude<ContinuationPlan, { transport: "attached" }>
  | { transport: "attached"; provider: string; conversationId: string; snapshot: Snapshot; bindingId?: string }

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

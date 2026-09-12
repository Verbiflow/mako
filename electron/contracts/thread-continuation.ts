import type { ThreadRef } from "@mako/sessions"
import type { ExternalThreadActivity } from "./host-events-boot.js"

/**
 * How the next message reaches a catalogued conversation.
 *
 * One decision, made by the host from what only the host knows: which
 * drivers are installed, whether a driver can reopen a store, whether a
 * process already owns the file, and what the provider said about the store
 * itself. The renderer asks for the plan and follows it; the host refuses a
 * request that does not match it. Before this the renderer chose a transport
 * from provider-level flags served once at startup, and a stale flag did not
 * fail: it silently routed a reply to a different transport (a Cursor ACP
 * session went to `cursor-agent -p --resume`, which forked the store and
 * rejected the model).
 */
export type ContinuationPlan =
  | { transport: "live"; provider: string; nativeId: string }
  | { transport: "native"; provider: string }
  | { transport: "handoff"; provider: string; reason: string }
  | { transport: "refused"; reason: string }

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
): ContinuationPlan {
  const provider = ref.harness
  if (ref.archived)
    return {
      transport: "handoff",
      provider,
      reason: "This history lives only in Mako's archive; its CLI no longer has the session.",
    }
  if (ref.resumeUnavailable)
    return { transport: "handoff", provider, reason: ref.resumeUnavailable }
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

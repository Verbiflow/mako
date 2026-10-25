import type { LiveRequest } from "./live-conversations.js"
import { describeProviderFailure, type ProviderFailureKind } from "./provider-failure.js"

/** A failed message's outcome, in a few words: the headline its recovery is shown under. */
const FAILURE_TITLES = {
  "transcript-rejected": "Session history was rejected",
  "context-exhausted": "Conversation context is full",
  auth: "Sign-in required",
  plan: "The plan doesn't cover this request",
  "wrong-account": "Signed in as a different account",
  "rate-limited": "Model temporarily unavailable",
  "provider-unavailable": "The provider's service failed",
  network: "The connection dropped",
  "resume-failed": "Could not reopen this session",
  "transport-limit": "Response too large to read",
  "rejected-input": "Message was refused",
  "missing-folder": "Folder no longer exists",
  "launch-failed": "Agent could not start",
  "launch-stalled": "Agent stopped responding while starting",
  unknown: "Message could not be completed",
} satisfies Record<ProviderFailureKind, string>

/** Native receipt and execution outcome answer different questions. */
export function describePromptRecovery(
  request: Pick<LiveRequest, "status" | "failure" | "nativeDelivery">,
  providerLabel = "The provider",
  compacted = false
) {
  const failure = request.status === "failed" && request.failure
    ? describeProviderFailure(request.failure, providerLabel)
    : null
  const evidence = request.nativeDelivery?.evidence.kind
  // Prepared is an intent, not proof that a crash preceded the native send.
  const delivery = evidence === "not-accepted"
    ? "This attempt was not sent to the agent."
    : evidence === "accepted"
      ? "The agent received this message. It may have done work before stopping. Sending another copy can repeat that work."
      : "Mako cannot confirm whether the agent received this message. Check the conversation before sending another copy; work may be repeated."
  const title = request.status === "uncertain"
    ? evidence === "accepted" ? "Message outcome is unconfirmed" : "Message delivery is unconfirmed"
    : request.status === "interrupted"
      ? "Message interrupted"
      : request.status === "failed" && request.failure
        ? FAILURE_TITLES[request.failure]
        : "Message could not be completed"
  const canResend = request.status === "failed"
    && ((failure?.retriable ?? true) || (request.failure === "context-exhausted" && compacted))
  return {
    failure,
    title,
    delivery,
    resendLabel: canResend ? evidence === "not-accepted" ? "Send again" : "Send another copy" : null,
  }
}

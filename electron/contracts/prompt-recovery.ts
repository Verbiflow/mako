import type { LiveRequest } from "./live-conversations.js"
import { describeProviderFailure } from "./provider-failure.js"

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
      : request.failure === "rate-limited"
        ? "Model temporarily unavailable"
        : request.failure === "auth"
          ? "Sign-in required"
          : request.failure === "context-exhausted"
            ? "Conversation context is full"
            : request.failure === "resume-failed"
              ? "Could not reopen this session"
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

import type { ContextTransfer } from "./conversation-control.js"
import type { LiveAction } from "./live-actions.js"
import type { LiveRequest } from "./live-conversations.js"
import { describePromptRecovery } from "./prompt-recovery.js"
import { describeProviderFailure } from "./provider-failure.js"

/** A durable action owns the input even if its eventual execution failed. */
export function actionRetainsInput(action: LiveAction): boolean {
  return action.state.kind !== "not-accepted"
}

export function describeActionRecovery(action: LiveAction) {
  const compact = action.input.kind === "compact"
  const label = compact ? "Compaction" : "Steering message"
  const state = action.state
  switch (state.kind) {
    case "dispatching":
      return { title: `${label} awaiting confirmation`, guidance: "Mako saved the action. The agent has not confirmed acceptance yet." }
    case "accepted":
      return { title: `${label} ${compact ? "in progress" : "accepted"}`, guidance: "The agent accepted the action. Completion has not been confirmed." }
    case "completed":
      return { title: `${label} completed`, guidance: "The agent confirmed completion." }
    case "failed":
      return { title: `${label} failed`, guidance: "The action failed. Its saved record remains here; it will not be repeated automatically." }
    case "not-accepted":
      return { title: `${label} not accepted`, guidance: "The agent did not accept this action. Your input remains available to edit and try again." }
    case "uncertain":
      return { title: `${label} outcome unknown`, guidance: compact
        ? "Compaction may still be running. Disconnecting releases this blocked connection; it does not confirm completion or repeat compaction."
        : "The steering message may have reached the agent. Acknowledging this notice does not resend it or confirm completion." }
    case "acknowledged":
      return { title: `${label} uncertainty acknowledged`, guidance: state.receipt
        ? "The uncertainty was acknowledged. The original explanation is saved in Details. This is not a completion receipt."
        : "The uncertainty was acknowledged. Its original explanation was not retained by this version of Mako. This is not a completion receipt." }
  }
}

/** Transfer acceptance queues a prompt; only that prompt can prove delivery. */
export function describeTransferRecovery(
  transfer: ContextTransfer,
  provider: string,
  candidate?: LiveRequest
) {
  const state = transfer.state
  const request = candidate?.id === transfer.input.id ? candidate : undefined
  switch (state.kind) {
    case "queued":
      return { title: `Switch to ${provider} after this turn`, guidance: "Your request and attachments are saved. The destination has not been prepared yet." }
    case "preparing":
      return { title: `Preparing ${provider}`, guidance: "Mako is preparing the destination. This does not confirm message delivery." }
    case "accepted":
      return {
        title: `Switched to ${provider}`,
        guidance: request?.status === "completed"
          ? "The destination completed this message."
          : request?.status === "queued" || request?.status === "held"
            ? "The destination is prepared. Your message is saved and waiting to be sent."
            : request?.nativeDelivery?.evidence.kind === "accepted"
              ? "The destination received this message. Review its turn for the outcome."
              : request
                ? describePromptRecovery(request, provider).delivery
                : "The switch was saved, but its message receipt is unavailable. Delivery is unconfirmed.",
      }
    case "failed":
    case "uncertain": {
      const failure = state.kind === "failed" && state.failure
        ? describeProviderFailure(state.failure, provider) : undefined
      return {
        title: state.kind === "uncertain" ? `Switch to ${provider} is unconfirmed` : `Could not switch to ${provider}`,
        guidance: `${failure ? failure.guidance + " " : ""}Review the conversation before trying again. A new switch attempt can repeat work.`,
        retryLabel: (failure?.retriable ?? true) ? "Try switch again" : undefined,
      }
    }
  }
}

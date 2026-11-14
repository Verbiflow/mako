import { sentByMako } from "./children.js"
import { quietSwitch, type ContextTransfer } from "./conversation-control.js"
import type { LiveAction } from "./live-actions.js"
import type { LiveRequest } from "./live-conversations.js"
import { describePromptRecovery } from "./prompt-recovery.js"
import { describeProviderFailure } from "./provider-failure.js"

/** A durable action owns the input even if its eventual execution failed. */
export function actionRetainsInput(action: LiveAction): boolean {
  return action.state.kind !== "not-accepted"
}

/**
 * Whether the action's notice above the composer still says something true.
 * A steer the agent didn't take is over once its words are a message of
 * their own: the queued message it came from, which the refusal put back
 * (`queueStatus`), or the follow-up the client sends under the action's ID.
 */
export function actionNoticeCurrent(action: LiveAction, requests: readonly Pick<LiveRequest, "id">[]): boolean {
  const state = action.state
  if (state.kind === "acknowledged" || state.kind === "completed") return false
  if (action.input.kind === "compact") return true
  if (state.kind === "accepted") return false
  if (state.kind !== "not-accepted") return true
  if (action.input.kind === "steer-queued") return !action.queueStatus
  const id = action.input.id
  return !requests.some((request) => request.id === id)
}

export function describeActionRecovery(action: LiveAction) {
  const compact = action.input.kind === "compact"
  const label = compact ? "Compaction" : "Steering message"
  const state = action.state
  switch (state.kind) {
    case "dispatching":
      return compact
        ? { title: `${label} awaiting confirmation`, guidance: "Mako saved the action. The agent has not confirmed acceptance yet." }
        : { title: `Steering`, guidance: "Mako is handing your message to the agent. If the agent hasn't taken it within a second, Mako stops the turn and sends it as the next message." }
    case "accepted":
      return { title: `${label} ${compact ? "in progress" : "accepted"}`, guidance: "The agent accepted the action. Completion has not been confirmed." }
    case "completed":
      return { title: `${label} completed`, guidance: "The agent confirmed completion." }
    case "failed":
      return { title: `${label} failed`, guidance: "The action failed. Its saved record remains here; it will not be repeated automatically." }
    case "not-accepted":
      return { title: `${label} not accepted`, guidance: compact ? "The agent did not start it, so nothing changed." : "The agent did not take it into this turn, so it goes as your next message." }
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

/**
 * Whether Mako sent this by itself, a Fin's digest or an Apex's message: what becomes of it is Mako's to handle, and it
 * does. The host's word, since anyone can paste Mako's header; only a receipt kept before the host said goes by its words.
 */
export function actionSentByMako(action: Pick<LiveAction, "input" | "sender">): boolean {
  if (action.input.kind === "compact") return false
  return action.sender ? action.sender === "native" : sentByMako(action.input.text)
}

/**
 * The action whose notice stands above the composer: the person's newest, while its notice says something true. A
 * steer Mako sent raises nothing, whatever became of it, and hides nothing of theirs.
 */
export function actionNotice(actions: readonly LiveAction[] | undefined, requests: readonly Pick<LiveRequest, "id">[]): LiveAction | undefined {
  const action = actions?.filter((each) => !actionSentByMako(each)).at(-1)
  return action && actionNoticeCurrent(action, requests) ? action : undefined
}

/** Transfer acceptance queues a prompt; only that prompt can prove delivery. */
export function describeTransferRecovery(
  transfer: ContextTransfer,
  provider: string,
  candidate?: LiveRequest
) {
  const state = transfer.state
  const request = candidate?.id === transfer.input.id ? candidate : undefined
  if (quietSwitch(transfer)) switch (state.kind) {
    case "queued":
    case "preparing":
      return { title: `Moving to ${provider}`, guidance: "Nothing is sent until the next message, which goes there." }
    case "accepted":
      return { title: `Moved to ${provider}`, guidance: "The next message goes there with the whole conversation." }
    case "failed":
    case "uncertain":
      return { title: `Could not move to ${provider}`, guidance: "The Thread stays where it was and nothing was sent.", retryLabel: undefined }
  }
  switch (state.kind) {
    case "queued":
      if (request?.status === "held") return { title: `Switch to ${provider} is paused`, guidance: `Your message is in the queue. Resuming it sends it to ${provider}.` }
      if (transfer.behind) return { title: "Waiting for the current switch to finish", guidance: `Your request and attachments are saved. The switch to ${provider} goes once the one before it is done.` }
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
      if (state.kind === "failed" && state.removed)
        return { title: `Switch to ${provider} removed`, guidance: "Its message left the queue before it went. Nothing reached the destination.", retryLabel: undefined }
      const failure = state.kind === "failed" && state.failure
        ? describeProviderFailure(state.failure, provider) : undefined
      // Nothing started, so there is no switch to retry and no work to repeat.
      if (failure?.kind === "missing-folder") return { title: failure.title, guidance: failure.guidance, retryLabel: undefined }
      return {
        title: state.kind === "uncertain" ? `Switch to ${provider} is unconfirmed` : `Could not switch to ${provider}`,
        guidance: `${failure ? failure.guidance + " " : ""}Trying the switch again can repeat work ${provider} already did.`,
        retryLabel: (failure?.retriable ?? true) ? "Try switch again" : undefined,
      }
    }
  }
}

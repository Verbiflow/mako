import { errorMessage, type FailureBoundary } from "../base/error-message.js"
import type { UUID } from "node:crypto"
import type { PromptDeliveryEvidence } from "../contracts/prompt-delivery.js"

/** One Mako operation and one durably recorded attempt; not a native deduplication guarantee. */
export interface PromptDispatch {
  operationId: string
  attemptId: UUID
  /** What Mako shows for the prompt, where the harness is sent other words (a review's, a goal's, Mako's notes); its stream keeps both. */
  shown?: string
  /**
   * When Mako drew the prompt, where it drew it now: before what the harness
   * says while the prompt is prepared and sent, which the view draws after it.
   */
  shownAt?: number
  report(evidence: Exclude<PromptDeliveryEvidence, { kind: "prepared" }>): void
}

/**
 * A harness at work on a turn when a message reached it: one it started itself (a notice of background work, say)
 * between the host's look and the send. Thrown before anything is sent, so the message waits for that turn and goes
 * after it, whatever the session reads by the time the refusal is handled: such a turn can end at once.
 */
export class TurnInProgressError extends Error {
  constructor(harness: string) {
    super(`${harness} is already working`)
    this.name = "TurnInProgressError"
  }
}

/** Only preparation before the native send can prove that no input was delivered. */
export function preparePrompt<Value>(
  dispatch: PromptDispatch,
  prepare: () => Value
): Value {
  try {
    return prepare()
  } catch (error) {
    return refusePrompt(dispatch, { error })
  }
}

/** Keep asynchronous input/settings preparation separate from the final synchronous send guard. */
export async function preparePromptAsync<Value>(
  dispatch: PromptDispatch,
  prepare: () => Promise<Value>
): Promise<Value> {
  try {
    return await prepare()
  } catch (error) {
    return refusePrompt(dispatch, { error })
  }
}

function refusePrompt(
  dispatch: PromptDispatch,
  boundary: FailureBoundary
): never {
  dispatch.report({
    kind: "not-accepted",
    source: "preflight",
    reason: errorMessage(boundary),
  })
  throw boundary.error
}

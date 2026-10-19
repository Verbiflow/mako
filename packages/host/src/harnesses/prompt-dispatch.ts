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

import { errorMessage, type FailureBoundary } from "../live-runtime.js"
import type { UUID } from "node:crypto"
import type { PromptDeliveryEvidence } from "../contracts/prompt-delivery.js"

/** One Mako operation and one durably recorded attempt; not a native deduplication guarantee. */
export interface PromptDispatch {
  operationId: string
  attemptId: UUID
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

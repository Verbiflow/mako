import { spendBetween } from "../contracts/usage-ledger.js"
import { priceEstimate } from "../usage/index.js"
import type { InterruptionReason, LiveRequest } from "../contracts/live-conversations.js"
import { advancePromptDelivery } from "../contracts/prompt-delivery.js"
import { classifyProviderFailure } from "../contracts/provider-failure.js"
import { CONNECTION_LOST_STOP, RETRIES_EXHAUSTED_STOP, type LiveSessionState } from "../contracts/providers-acp.js"

/**
 * The dispatching request's verdict when its session leaves `running`, for
 * the turn `session` just ended. A Stop is recorded as the user's
 * interruption; a failure carries the kind the provider's text classifies
 * as, so the renderer can say whether sending again is worth anything
 * without reading the text itself. `ended` says the user stopped this turn
 * or closed the conversation: unless the turn finished first, it settles
 * stopped however the driver reported the end. `work`: the background work
 * a handoff stopped with the turn, which its interruption keeps.
 */
export function settleRequest(request: LiveRequest, session: LiveSessionState, ended: boolean, reason: "stopped" | "handed-off" = "stopped", work?: string[]): LiveRequest {
  const stopped = (ended && session.status !== "ready") || /cancel|interrupt/i.test(session.lastStop ?? "")
  const dropped = stopped ? undefined : continuableInterruption(request, session)
  const status = stopped || dropped ? "interrupted" : session.status === "ready" ? "completed" : "failed"
  const settled: LiveRequest = {
    ...request,
    nativeDelivery: request.nativeDelivery && status !== "completed"
      ? { ...request.nativeDelivery, evidence: advancePromptDelivery(request.nativeDelivery.evidence, { kind: "uncertain", reason: session.error ?? "The turn ended without a delivery receipt" }) }
      : request.nativeDelivery,
    status,
    error: session.error,
    nativeRun:
      request.nativeRun && session.nativeForkId
        ? { ...request.nativeRun, forkId: session.nativeForkId }
        : request.nativeRun,
  }
  if (dropped) {
    // The work so far stands on the provider's side, so the request is
    // continuable rather than one to re-send; the failure kind is still
    // recorded so the panel can say what ended it.
    settled.interruption = { reason: dropped, at: Date.now() }
    settled.failure = dropped === "connection-lost" ? "network" : classifyProviderFailure(session.error).kind
  } else if (status === "interrupted") settled.interruption = { reason, at: Date.now(), ...work?.length && { stopped: work } }
  if (status === "failed") settled.failure = classifyProviderFailure(session.error).kind
  const spend = spendBetween(request.usageFrom, session.usage)
  if (spend.tokens || spend.cost !== undefined || spend.unrecorded) {
    const model = session.settings?.model
    // Priced once, here, from the table current now: a later table never reprices this turn.
    const estimate = spend.cost === undefined && spend.tokens ? priceEstimate(model, { ...spend.tokens, summed: true }) : null
    settled.spend = { provider: session.harness, model, at: Date.now(), ...spend, ...estimate && { estimate } }
  }
  return settled
}

/**
 * Why a turn that ended without finishing can be continued rather than sent
 * again, or `undefined`. The provider's own dropped-connection stop always
 * qualifies. Otherwise the provider must have accepted the prompt, so its
 * saved session holds the turn so far: then a process that died under the
 * turn, or a turn that failed on a dropped connection, is picked up where it
 * stopped. Without that receipt the outcome is unknown and stays the user's
 * call. A session that reports itself closed was ended on purpose, and one
 * whose transport already exhausted its own retries is never re-run here.
 */
function continuableInterruption(request: LiveRequest, session: LiveSessionState): InterruptionReason | undefined {
  if (session.status === "closed" || session.lastStop === RETRIES_EXHAUSTED_STOP) return undefined
  if (session.lastStop === CONNECTION_LOST_STOP) return "connection-lost"
  if (session.status === "ready" || request.nativeDelivery?.evidence.kind !== "accepted") return undefined
  const failure = classifyProviderFailure(session.error).kind
  // A process that quit on a sign-out would quit again; it waits for the user.
  if (failure === "auth") return "signed-out"
  if (session.connection === "disconnected") return "provider-exited"
  return failure === "network" ? "connection-lost" : undefined
}

/** Mark every in-flight request cut short by the host itself, with the reason and the moment. */
export function interruptRequests(
  requests: LiveRequest[],
  reason: Extract<InterruptionReason, "host-quit" | "host-crashed">,
  error: string
): LiveRequest[] {
  const at = Date.now()
  return requests.map((request) =>
    request.status === "dispatching"
      ? {
          ...request,
          nativeDelivery: request.nativeDelivery
            ? { ...request.nativeDelivery, evidence: advancePromptDelivery(request.nativeDelivery.evidence, { kind: "uncertain", reason: error }) }
            : undefined,
          status: reason === "host-quit" ? "interrupted" : "uncertain",
          error,
          interruption: { reason, at },
        }
      : request
  )
}

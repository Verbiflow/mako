import { randomUUID } from "node:crypto"
import { spendBetween, type TurnSpend } from "../contracts/usage-ledger.js"
import { priceEstimate } from "../usage/index.js"
import type { InterruptionReason, LiveRequest, LiveSnapshot, SpentThrough, UsageMark } from "../contracts/live-conversations.js"
import { advancePromptDelivery } from "../contracts/prompt-delivery.js"
import { classifyProviderFailure } from "../contracts/provider-failure.js"
import { CONNECTION_LOST_STOP, RETRIES_EXHAUSTED_STOP, type LiveSessionState, type LiveSessionUsage } from "../contracts/providers-acp.js"

/**
 * The dispatching request's verdict when its session leaves `running`, for
 * the turn `session` just ended. A Stop is recorded as the user's
 * interruption; a failure carries the kind the provider's text classifies
 * as, so the renderer can say whether sending again is worth anything
 * without reading the text itself. `ended` says the user stopped this turn
 * or closed the conversation: unless the turn finished first, it settles
 * stopped however the driver reported the end, for `reason`: the user's
 * Stop, a handoff, or a conversation Mako couldn't save. `work`: the
 * background work a handoff stopped with the turn, which its interruption
 * keeps.
 */
export function settleRequest(request: LiveRequest, session: LiveSessionState, ended: boolean, reason: "stopped" | "handed-off" | "not-saved" = "stopped", work?: string[]): LiveRequest {
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
  const spend = measuredSpend(request.usageFrom, session)
  if (spend) settled.spend = spend
  return settled
}

/** What the meter read between `from` and `session`'s reading now, priced once, here: a later table never reprices it. */
export function measuredSpend(from: UsageMark | undefined, session: LiveSessionState): TurnSpend | undefined {
  const spend = spendBetween(from, session.usage)
  if (!spend.tokens && spend.cost === undefined && !spend.unrecorded) return undefined
  const model = session.settings?.model
  const estimate = spend.cost === undefined && spend.tokens ? priceEstimate(model, { ...spend.tokens, summed: true }) : null
  return { provider: session.harness, model, at: Date.now(), ...spend, ...estimate && { estimate } }
}

/** A meter reading as a turn is measured from it. */
export function usageMark(usage: LiveSessionUsage | undefined): UsageMark | undefined {
  if (!usage?.tokens && !usage?.cost && !usage?.unrecorded) return undefined
  return { ...usage.tokens && { tokens: usage.tokens }, ...usage.cost && { cost: usage.cost }, ...usage.unrecorded && { unrecorded: usage.unrecorded } }
}

/**
 * The conversation's spend records as a turn ends, or as its process goes.
 * A turn Mako sent settled its request; one the harness ran on its own is
 * recorded here, from the last turn's end. Either way the next counts from
 * now. When the process goes between turns, what it spent after the last
 * turn (a background subagent finishing with no turn after it) is recorded
 * as `after`, and nothing is counted from its meter again.
 */
export function turnSpendAt(
  snapshot: Pick<LiveSnapshot, "spentThrough" | "harnessTurns" | "session">,
  bindingId: string,
  how: { ended: boolean; ownTurn: boolean; gone: boolean }
): Pick<LiveSnapshot, "spentThrough" | "harnessTurns"> {
  const held = snapshot.spentThrough?.bindingId === bindingId ? snapshot.spentThrough : undefined
  let harnessTurns = snapshot.harnessTurns
  const kind = how.ended ? (how.ownTurn ? "turn" : undefined) : how.gone ? "after" : undefined
  const spend = held && kind ? measuredSpend(held.usage, snapshot.session) : undefined
  if (spend && kind) harnessTurns = [...harnessTurns ?? [], { id: randomUUID(), kind, spend }]
  // Spread over the snapshot, so a process that went sets `spentThrough` away rather than leaving it out.
  const spentThrough = how.gone ? (held ? undefined : snapshot.spentThrough) : { bindingId, usage: usageMark(snapshot.session.usage) ?? {} }
  return { harnessTurns, spentThrough }
}

/** Where the next turn in `bindingId`'s process counts from: the last turn's end there, else the meter now. */
export function turnStart(snapshot: Pick<LiveSnapshot, "spentThrough" | "session">, bindingId: string): SpentThrough {
  const held = snapshot.spentThrough
  return held?.bindingId === bindingId ? held : { bindingId, usage: usageMark(snapshot.session.usage) ?? {} }
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

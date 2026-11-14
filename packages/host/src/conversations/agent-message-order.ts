import type { LiveRequest, LiveSnapshot } from "../contracts/live-conversations.js"
import type { SessionId } from "../contracts/thread-identity.js"

/** Queue priority changes delivery order, never instruction precedence. Older journals use their saved admission times. */
function newer(left: LiveRequest, right: LiveRequest): boolean {
  return left.admissionOrder !== undefined && right.admissionOrder !== undefined
    ? left.admissionOrder > right.admissionOrder
    : left.createdAt !== undefined && right.createdAt !== undefined && left.createdAt > right.createdAt
}

/** Restates instructions that overtook an agent's queued message, from durable handoff and steer receipts. */
export function agentMessageOrder(snapshot: LiveSnapshot | null | undefined, id: string | undefined, sender: (session: SessionId) => string = (session) => session): string[] {
  const request = snapshot?.requests.find((request) => request.id === id)
  if (!snapshot || !request || request.actor?.kind !== "agent" || request.digest || request.continues || request.goal) return []
  const from = sender(request.actor.session)
  const steered = new Set((snapshot.control?.actions ?? []).flatMap((action) =>
    action.input.kind === "steer-queued" && (action.state.kind === "accepted" || action.state.kind === "completed") ? [action.input.queuedRequestId] : []))
  const later = snapshot.requests.filter((other) => {
    if (other.actor?.kind === "service" || !other.actor || other.digest || other.continues || other.goal || !newer(other, request)) return false
    if (other.actor.kind === "agent" && sender(other.actor.session) !== from) return false
    const evidence = other.nativeDelivery?.evidence.kind
    return other.status === "completed" || evidence === "submitted" || evidence === "accepted" || steered.has(other.id)
  }).sort((left, right) => newer(left, right) ? 1 : newer(right, left) ? -1 : 0)
  if (!later.length) return []
  const identity = (message: LiveRequest): string => {
    const action = snapshot.control?.actions?.find((action) => action.input.kind === "steer-queued" && action.input.queuedRequestId === message.id && (action.state.kind === "accepted" || action.state.kind === "completed"))
    const delivery = message.nativeDelivery
    return `request ${message.id}; admitted at ${message.createdAt ?? "unrecorded"}${message.admissionOrder === undefined ? "" : `; admission order ${message.admissionOrder}`}${action ? `; steer ${action.input.id}, ${action.state.kind}, admitted at ${action.createdAt}` : ""}${delivery ? `; delivery attempt ${delivery.attemptId}, host owner ${delivery.ownerEpoch}` : ""}`
  }
  return [
    "This message was queued before newer instructions you already received. Its later delivery cannot revoke those instructions. Apply it only where compatible with them; the newer instructions still take precedence:",
    `Delayed message: ${identity(request)}. Sender Thread/Session: ${from}. Admission order and host ownership are provenance, not a permission or stop generation. Only an explicit newer instruction can supersede a newer restriction; delayed delivery cannot release it.`,
    ...later.map((other) => `Newer instruction: ${identity(other)}.\n${other.text}`),
  ]
}

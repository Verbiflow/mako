import type { LiveRequest } from "@mako/host/contracts/live-conversations"
import type { PendingPrompt } from "@/state/prompt-delivery"

/** What one message is waiting on before it's sent: its Thread's machine, or the host's answer. */
export type Sending = "waking" | "sending"

/** What a message the person sent says under it on a phone. Nothing once its turn has its own words for it. */
export type Delivery = Sending | "unconfirmed" | "queued" | "delivered"

export function deliveryOf(requestId: string, conversation: { requests?: readonly Pick<LiveRequest, "id" | "status">[]; pendingPrompts?: readonly Pick<PendingPrompt, "id" | "unconfirmed">[] }, sending: ReadonlyMap<string, Sending>): Delivery | undefined {
  const request = conversation.requests?.find((each) => each.id === requestId)
  if (request) return request.status === "queued" || request.status === "held" ? "queued" : request.status === "dispatching" ? "delivered" : undefined
  const pending = conversation.pendingPrompts?.find((each) => each.id === requestId)
  if (!pending) return undefined
  if (pending.unconfirmed) return "unconfirmed"
  return sending.get(requestId) ?? "sending"
}

export const DELIVERY_WORDS = {
  waking: "Waking…",
  sending: "Sending…",
  unconfirmed: "Not confirmed",
  queued: "Queued",
  delivered: "Delivered",
} satisfies Record<Delivery, string>


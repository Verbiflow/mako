import type {
  InterruptionReason,
  LiveRequest,
  LiveSessionState,
  PromptAttachment,
} from "@/lib/types"
import type { AcpBlock } from "@/lib/acp-blocks"

/** How a turn on screen was cut short, and whether the transcript offers to pick it up. */
export interface TurnStop {
  reason: InterruptionReason
  /** True for the newest turn when Mako, not the user, cut it short and nothing is running now. */
  continuable: boolean
}

/**
 * The requests whose turn stopped before the provider finished, keyed by
 * request id. A user's Stop is plain `stopped`; a host exit carries its
 * recorded reason. Only the newest such turn can be continued, and only
 * while the session is idle, so two Continue offers never show at once.
 */
export function turnStops(requests: readonly LiveRequest[], running: boolean): Map<string, TurnStop> {
  const stops = new Map<string, TurnStop>()
  const newest = requests.findLast((request) => request.status !== "canceled")
  for (const request of requests) {
    const reason =
      request.status === "interrupted"
        ? request.interruption?.reason ?? "stopped"
        : request.status === "uncertain"
          ? request.interruption?.reason
          : undefined
    if (!reason) continue
    stops.set(request.id, {
      reason,
      continuable: !running && reason !== "stopped" && request === newest,
    })
  }
  return stops
}

/** What the composer sends to pick up a turn Mako cut short. */
export const CONTINUE_TURN_PROMPT =
  "Continue where you left off. Mako closed before you finished the previous turn; pick it up from there."

export interface PendingPrompt {
  id: string
  text: string
  attachments: PromptAttachment[]
  status?: LiveRequest["status"]
  displayText?: string
  /**
   * The host dropped under this send and did not come back within the
   * transport's wait. The prompt stays staged under its id and is re-issued
   * when the host reconnects; the host answers a repeated id with the first
   * acceptance, so it is never delivered twice.
   */
  unconfirmed?: boolean
}

interface DeliveryInput {
  session: Pick<LiveSessionState, "status">
  blocks: AcpBlock[]
  requests?: LiveRequest[]
  pendingPrompts?: PendingPrompt[]
}
interface PromptDelivery {
  starting: PendingPrompt | null
  queued: PendingPrompt[]
}

export function recoverableRequests(input: Pick<DeliveryInput, "blocks" | "requests">): LiveRequest[] {
  const visible = new Set(input.blocks.flatMap((block) => block.type === "user" && block.requestId ? [block.requestId] : []))
  // A turn the transcript shows carries its own stopped marker (`turnStops`);
  // only a stopped or unconfirmed message with no turn on screen needs a panel.
  return (input.requests ?? []).filter(
    (request) =>
      request.status === "failed" ||
      (request.status === "uncertain" && !(request.interruption && visible.has(request.id))) ||
      (request.status === "interrupted" && !visible.has(request.id))
  )
}

/** Delivery receipts may precede provider startup. Only work behind a turn is a queue. */
export function promptDelivery(input: DeliveryInput): PromptDelivery {
  const requests = input.requests ?? []
  const accepted = new Set(requests.map((request) => request.id))
  const waiting = [
    ...requests.filter(
      (request) => request.status === "queued" || request.status === "held"
    ),
    ...(input.pendingPrompts ?? []).filter(
      (prompt) => !accepted.has(prompt.id)
    ),
  ]
  const dispatched = requests.find(
    (request) => request.status === "dispatching"
  )
  const canStart =
    input.session.status === "ready" || input.session.status === "starting"
  const first = canStart
    ? waiting[0]
    : input.session.status === "failed"
      ? input.pendingPrompts?.[0]
      : undefined
  const starting = dispatched ?? (first?.status === "held" ? undefined : first)
  const visible = new Set(
    input.blocks.flatMap((block) =>
      block.type === "user" && block.requestId ? [block.requestId] : []
    )
  )
  return {
    starting: starting && !visible.has(starting.id) ? starting : null,
    queued: waiting.filter((prompt) => prompt.id !== starting?.id),
  }
}

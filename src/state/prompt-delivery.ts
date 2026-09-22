import type { SessionSettings } from "@mako/sessions/settings"
import type {
  InterruptionReason,
  LiveRequest,
  LiveSessionState,
  PromptAttachment,
  TurnContinuation,
} from "@/lib/types"
import type { AcpBlock } from "@/lib/acp-blocks"
import { continueTurnPrompt } from "../../electron/contracts/turn-continuation"

export { continueTurnPrompt }

/** How a turn on screen was cut short, and whether the transcript offers to pick it up. */
export interface TurnStop {
  reason: InterruptionReason
  /** True for the newest turn when Mako, not the user, cut it short and nothing is running now. */
  continuable: boolean
  /** Mako has scheduled its own continuation of this turn; the footer says so instead of offering the button. */
  automatic: boolean
}

/**
 * The requests whose turn stopped before the provider finished, keyed by
 * request id. A user's Stop is plain `stopped`; a host exit carries its
 * recorded reason. Only the newest such turn can be continued, and only
 * while the session is idle, so two Continue offers never show at once. A
 * turn Mako is about to continue itself offers nothing meanwhile.
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
    const automatic = request.interruption?.autoContinue !== undefined
    stops.set(request.id, {
      reason,
      continuable: !running && !automatic && reason !== "stopped" && request === newest,
      automatic,
    })
  }
  return stops
}

/**
 * The requests that carry on an earlier turn, keyed by their own request id,
 * so the transcript can show Mako's continuation as Mako's line and not as
 * words the user typed.
 */
export function turnContinuations(requests: readonly LiveRequest[]): Map<string, TurnContinuation> {
  const continuations = new Map<string, TurnContinuation>()
  for (const request of requests) if (request.continues) continuations.set(request.id, request.continues)
  return continuations
}

/**
 * True while the host has promised to continue the newest turn itself. The
 * session reads `failed` in that window, but the thread is not: it is about
 * to run again, so nothing announces the drop and the rail keeps the row
 * working.
 */
export function autoContinuePending(requests: readonly LiveRequest[] | undefined): boolean {
  return requests?.some((request) => request.interruption?.autoContinue !== undefined) ?? false
}

/** The footer's words for a turn Mako is about to pick up itself. */
export const AUTO_CONTINUE_NOTE = "continuing automatically"

/**
 * The footer's word for why a turn ended early. `provider` is the display
 * name of the harness that ran it; a dropped connection is that provider's
 * connection, and the label says so.
 */
export function turnStopLabel(reason: InterruptionReason, provider: string): string {
  switch (reason) {
    case "stopped":
      return "Stopped"
    case "host-quit":
      return "Interrupted when Mako quit"
    case "host-crashed":
      return "Interrupted when Mako closed unexpectedly"
    case "connection-lost":
      return `The connection to ${provider} dropped`
  }
}

export interface PendingPrompt {
  bindingId?: string
  delivery?: { tuning?: SessionSettings }
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

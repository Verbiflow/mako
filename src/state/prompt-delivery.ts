import type { SessionSettings } from "@mako/sessions/settings"
import type {
  InterruptionReason,
  LiveRequest,
  LiveSessionState,
  PromptAttachment,
} from "@/lib/types"
import type { Entry } from "@mako/sessions/entries"
import type { OutdatedRestore } from "@mako/host/contracts/restore-plan"
import type { LiveHistoryWindow } from "@mako/host/contracts/live-history"
import { continueTurnPrompt, savedContinuation, type ContinuationSender } from "@mako/host/contracts/turn-continuation"
import { goalContinuePrompt, goalStartPrompt } from "@mako/host/contracts/live-goals"

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
      continuable: !running && !automatic && !request.signIn && reason !== "stopped" && request === newest,
      automatic,
    })
  }
  return stops
}

/**
 * A prompt Mako wrote: a continuation of a turn cut short, the note after an
 * agent's move onto its own branch, a step of the goal, or the review the
 * person picked, whose words are Mako's prompt or the harness's command. A
 * continuation names who sent it: Mako on its own, or the person through
 * Continue turn; one read back from before the words said so has no sender.
 */
export type MakoPrompt =
  | { kind: "continued"; reason: InterruptionReason; sender?: ContinuationSender }
  | { kind: "moved" }
  | { kind: "goal"; step: NonNullable<LiveRequest["goal"]> }
  | { kind: "review"; target: NonNullable<LiveRequest["review"]> }

/**
 * The prompts Mako sent itself, keyed by their request id, so the transcript
 * shows them as Mako's line and not as words the user typed.
 */
export function makoPrompts(requests: readonly LiveRequest[]): Map<string, MakoPrompt> {
  const prompts = new Map<string, MakoPrompt>()
  for (const request of requests) {
    if (request.continues?.auto) prompts.set(request.id, { kind: "continued", reason: request.continues.reason, sender: "mako" })
    else if (request.actor?.kind === "service" && request.actor.name === "workspace") prompts.set(request.id, { kind: "moved" })
    else if (request.actor?.kind === "service" && request.actor.name === "goal" && request.goal) prompts.set(request.id, { kind: "goal", step: request.goal })
    else if (request.review) prompts.set(request.id, { kind: "review", target: request.review })
  }
  return prompts
}

/**
 * The conversation a request carried to the session it opened: a switch to
 * another harness, a fork that harness doesn't make itself, or a switch
 * back with the turns since. The transcript is the file the agent was given;
 * `from` names the harnesses that wrote those turns.
 */
export interface CarriedHistory {
  file: string
  from: readonly string[]
  turns?: number
  /** The harness here was older than the version that wrote the session Mako kept, so it went on from this transcript (`ContextManifest.outdated`). */
  outdated?: OutdatedRestore
}

/** The history each request carried, by request id: what the transcript draws as "Continued from …" above the person's words. */
export function carriedHistories(requests: readonly LiveRequest[]): Map<string, CarriedHistory> {
  const carried = new Map<string, CarriedHistory>()
  for (const request of requests) {
    const manifest = request.context?.find((item) => item.includesBase || item.toBlock > item.fromBlock)
    if (manifest) carried.set(request.id, { file: manifest.file, from: manifest.from ?? [], ...manifest.turns !== undefined && { turns: manifest.turns }, ...manifest.outdated && { outdated: manifest.outdated } })
  }
  return carried
}

/**
 * A prompt Mako wrote, known by its words: a store keeps no request to say
 * who sent it, and the person's Continue turn sends Mako's words through the
 * ordinary send. The words are compared whole with what `goalStartPrompt` or
 * `goalContinuePrompt` writes for the objective they carry, and with each
 * continuation `continueTurnPrompt` writes. Anything else, a fragment or an
 * edit included, is the user's.
 */
export function savedMakoPrompt(text: string): MakoPrompt | undefined {
  const continued = savedContinuation(text)
  if (continued) return { kind: "continued", ...continued }
  const objective = /\n<objective>\n([\s\S]*?)\n<\/objective>\n/.exec(text)?.[1]
  if (objective === undefined) return undefined
  const words = text.trim()
  if (words === goalContinuePrompt(objective)) return { kind: "goal", step: { step: "continue" } }
  if (words === goalStartPrompt(objective)) return { kind: "goal", step: { step: "set" } }
  return undefined
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
    case "provider-exited":
      return `${provider} stopped unexpectedly`
    case "signed-out":
      return `${provider} signed out`
    case "handed-off":
      return "Paused to move to the cloud"
  }
}

export interface PendingPrompt {
  bindingId?: string
  delivery?: { tuning?: SessionSettings }
  id: string
  text: string
  attachments: PromptAttachment[]
  status?: LiveRequest["status"]
  /** Set on a held message that waits for its session to be signed in again and resumed. */
  signIn?: LiveRequest["signIn"]
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
  blocks: Entry[]
  history?: Pick<LiveHistoryWindow, "earlierRequests">
  requests?: LiveRequest[]
  pendingPrompts?: PendingPrompt[]
}
interface PromptDelivery {
  starting: PendingPrompt | null
  queued: PendingPrompt[]
}

/** The requests whose user turn the transcript holds, loaded or not. */
function transcribedRequests(input: Pick<DeliveryInput, "blocks" | "history">): Set<string> {
  const ids = new Set(input.history?.earlierRequests)
  for (const block of input.blocks) if (block.type === "user" && block.requestId) ids.add(block.requestId)
  return ids
}

export function recoverableRequests(input: Pick<DeliveryInput, "blocks" | "history" | "requests">): LiveRequest[] {
  const visible = transcribedRequests(input)
  // A turn the transcript shows carries its own stopped marker (`turnStops`);
  // only a stopped or unconfirmed message with no turn on screen needs a panel.
  return (input.requests ?? []).filter(
    (request) =>
      request.status === "failed" ||
      (request.status === "uncertain" && !(request.interruption && visible.has(request.id))) ||
      (request.status === "interrupted" && !visible.has(request.id))
  )
}

/**
 * Delivery receipts may precede provider startup. Only work behind a turn is a queue.
 *
 * `starting` is the one message drawn ahead of its turn: the host has not
 * written it into the transcript yet. The host writes a request's user turn
 * in the same commit that marks it dispatching, so a dispatched request is
 * never drawn here, even when the loaded history page does not reach back to
 * its prompt. While one is dispatching, every other message waits behind it.
 */
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
  const delivering = requests.some(
    (request) => request.status === "dispatching"
  )
  const canStart =
    input.session.status === "ready" || input.session.status === "starting"
  const first = delivering
    ? undefined
    : canStart
      ? waiting[0]
      : input.session.status === "failed"
        ? input.pendingPrompts?.[0]
        : undefined
  const starting = first?.status === "held" ? undefined : first
  const visible = transcribedRequests(input)
  return {
    starting: starting && !visible.has(starting.id) ? starting : null,
    queued: waiting.filter((prompt) => prompt.id !== starting?.id),
  }
}

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
import { continueTurnPrompt, savedContinuation } from "@mako/host/contracts/turn-continuation"
import { goalContinuePrompt, goalStartPrompt } from "@mako/host/contracts/live-goals"
import { usageLimitSources } from "@/state/usage-limit-wait"
import { pullWakeWords } from "@mako/host/contracts/pull-waits"
import { turnWaitWords } from "@mako/host/contracts/turn-waits"
import { APEX_NOTE_PREFIX, apexNoteLine } from "@mako/host/contracts/apexes"
import { agentWords, YOUR_APEX, YOUR_FINS, type AgentWords } from "@mako/host/contracts/children"
import { APEX_WORD, FIN_WORD } from "@mako/host/contracts/agents"
import { foldedParts } from "@mako/host/contracts/live-conversations"

export { continueTurnPrompt }

/** How a turn on screen was cut short, and whether the transcript offers to pick it up. */
export interface TurnStop {
  reason: InterruptionReason
  /** True for the newest turn when Mako, not the user, cut it short and nothing is running now. */
  continuable: boolean
  /** Mako has scheduled its own continuation of this turn; the footer says so instead of offering the button. */
  automatic: boolean
  /** The background work stopping the turn also stopped, as the agent is told of it (`Interruption.stopped`). */
  stopped?: readonly string[]
}

/**
 * A turn that ended where the person chose: their own Stop, their goal's
 * token budget, or their message steered in by stopping it. It's said quietly
 * and nothing offers to continue it; a goal at its budget goes on only when
 * it's set again with more, and a steered turn goes on as the message's.
 */
export function endedAsChosen(reason: InterruptionReason): boolean {
  return reason === "stopped" || reason === "goal-budget" || reason === "steered"
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
    const stop: TurnStop = {
      reason,
      continuable: !running && !automatic && !request.signIn && !endedAsChosen(reason) && request === newest,
      automatic,
    }
    const stopped = request.interruption?.stopped
    if (stopped?.length) stop.stopped = stopped
    stops.set(request.id, stop)
  }
  return stops
}

/**
 * A prompt Mako wrote that opens a turn of its own: the note after an
 * agent's move onto its own branch, a step of the goal, or the review the
 * person picked, whose words are Mako's prompt or the harness's command. A
 * continuation of a turn cut short opens none: it goes on in the turn it
 * continues (`isContinuation` in `exchanges.ts`).
 */
export type MakoPrompt =
  | { kind: "moved" }
  | { kind: "goal"; step: NonNullable<LiveRequest["goal"]> }
  | { kind: "review"; target: NonNullable<LiveRequest["review"]> }
  /** A pull request the Fin waits on came to an outcome (`pullWakeNote`): its line, and the pull request's link. */
  | { kind: "pull"; line: string; url?: string }
  /** A turn's wait fired or ended (`turnWaitNote`, `turnWaitMovedNote`): its first line, and the rest. */
  | { kind: "wait"; line: string; detail?: string }
  /** Mako told a deliberate Apex who joined its Shiver (`apexNoteLine`). */
  | { kind: "apex"; line: string }

/**
 * The prompts Mako sent itself, keyed by their request id, so the transcript
 * shows them as Mako's line and not as words the user typed.
 */
export function makoPrompts(requests: readonly LiveRequest[]): Map<string, MakoPrompt> {
  const prompts = new Map<string, MakoPrompt>()
  for (const request of requests) {
    // One several went as is drawn as its parts, each by who wrote it (`foldedPromptParts`), never as its carrier's.
    if (request.joined?.length) continue
    if (request.actor?.kind === "service" && request.actor.name === "workspace") prompts.set(request.id, { kind: "moved" })
    else if (request.actor?.kind === "service" && request.actor.name === "goal" && request.goal) prompts.set(request.id, { kind: "goal", step: request.goal })
    else if (request.review) prompts.set(request.id, { kind: "review", target: request.review })
    else if (request.actor?.kind === "service" && request.actor.name === "pull-watch") {
      const pull = pullWakeWords(request.text)
      if (pull) prompts.set(request.id, { kind: "pull", ...pull })
    } else if (request.actor?.kind === "service" && request.actor.name === "apex") prompts.set(request.id, { kind: "apex", line: apexNoteLine(request.text) })
    else if (request.actor?.kind === "service" && request.actor.name === "turn-wait")
      prompts.set(request.id, { kind: "wait", ...turnWaitWords(request.text) ?? { line: request.text.trim().split("\n", 1)[0] ?? "" } })
  }
  return prompts
}

/** A part of a message several went as (`LiveRequest.joined`), drawn as who wrote it: Mako's line, an agent's card, or plain words. */
export type FoldedPromptPart =
  | { kind: "pull"; line: string; url?: string }
  | { kind: "wait"; line: string; detail?: string }
  | { kind: "agent"; words: AgentWords; raw: string }
  | { kind: "words"; text: string }

/**
 * A message several went as, as its parts (`foldedParts`), each drawn as who wrote it: Mako's note as its line, an
 * Apex's message as its card. Read from the words alone, so a saved transcript draws as a live one. Undefined for a
 * message that went alone.
 */
export function foldedPromptParts(text: string): FoldedPromptPart[] | undefined {
  const parts = foldedParts(text)
  if (!parts) return undefined
  return parts.map((part): FoldedPromptPart => {
    const words = part.text.trim()
    const mako = savedMakoPrompt(words)
    if (mako?.kind === "pull" || mako?.kind === "wait") return mako
    const agent = agentWords(words)
    return agent ? { kind: "agent", words: agent, raw: words } : { kind: "words", text: words }
  })
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
 * A goal's prompt, or a pull request's outcome Mako woke a Fin with, known by
 * its words: a store keeps no request to say who sent it. A goal's words are
 * compared whole with what `goalStartPrompt` or `goalContinuePrompt` writes
 * for the objective they carry, a wake's with `pullWakeNote`'s one line.
 * Anything else, a fragment or an edit included, is the user's.
 */
export function savedMakoPrompt(text: string): MakoPrompt | undefined {
  const pull = pullWakeWords(text)
  if (pull) return { kind: "pull", ...pull }
  const wait = turnWaitWords(text)
  if (wait) return { kind: "wait", ...wait }
  const objective = /\n<objective>\n([\s\S]*?)\n<\/objective>\n/.exec(text)?.[1]
  if (objective === undefined) return undefined
  const words = text.trim()
  if (words === goalContinuePrompt(objective)) return { kind: "goal", step: { step: "continue" } }
  if (words === goalStartPrompt(objective)) return { kind: "goal", step: { step: "set" } }
  return undefined
}

/**
 * A queued message that isn't the person's, in a line as Up next shows it: Mako's note to an Apex ("README overview
 * joined the Shiver"), a wake ("Pull request #12 merged"), or an agent's message by who wrote it ("From the Apex: …",
 * "Reports from 3 Fins"). Undefined for the person's own words, which show as they wrote them and stay theirs to edit.
 */
export function queuedNotThePerson(text: string): string | undefined {
  if (text.startsWith(APEX_NOTE_PREFIX)) return apexNoteLine(text)
  const mako = savedMakoPrompt(text)
  if (mako?.kind === "pull" || mako?.kind === "wait") return mako.line
  const agent = agentWords(text)
  if (!agent) return undefined
  if (agent.reports?.length) return `Reports from ${agent.reports.length} ${FIN_WORD}${agent.reports.length === 1 ? "" : "s"}`
  const from = agent.from === YOUR_APEX ? `the ${APEX_WORD}` : agent.from === YOUR_FINS ? `the ${FIN_WORD}s` : agent.from
  const line = agent.body.split("\n").find((each) => each.trim())?.trim().replace(/:$/, "")
  return line ? `From ${from}: ${line}` : `From ${from}`
}

/**
 * The words a request is named by wherever the person picks it from a list
 * (Changes' turns, a failure's notice): its own, or for a continuation,
 * which says Mako's words to the agent and not the person's, the words of
 * the turn it continued. That is the request it names (`continues`), else
 * the newest before it: Continue turn is offered only on the newest turn.
 */
export function turnWords(requests: readonly LiveRequest[], request: LiveRequest): string {
  let named: LiveRequest | undefined = request
  for (let hops = 0; named && hops <= requests.length && savedContinuation(named.text); hops++) {
    const continued: LiveRequest = named
    const at = requests.findIndex((each) => each.id === continued.id)
    named = (continued.continues && requests.find((each) => each.id === continued.continues?.requestId)) ??
      requests.slice(0, Math.max(0, at)).findLast((each) => each.status !== "canceled")
  }
  return named && !savedContinuation(named.text) ? (named.displayText ?? named.text).replace(/\s+/g, " ").trim() : ""
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

/** Each reason's word, given the provider's display name. */
const TURN_STOP_LABELS = {
  stopped: () => "Stopped",
  "host-quit": () => "Interrupted when Mako quit",
  "host-crashed": () => "Interrupted when Mako closed unexpectedly",
  "connection-lost": (provider) => `The connection to ${provider} dropped`,
  "provider-exited": (provider) => `${provider} stopped unexpectedly`,
  "compaction-failed": () => "Continuing after compaction failed",
  "signed-out": (provider) => `${provider} signed out`,
  "handed-off": () => "Paused to move to the cloud",
  "not-saved": () => "Stopped when Mako couldn't save",
  "goal-budget": () => "Stopped at the goal's token budget",
  "machine-lost": () => "Interrupted",
  steered: () => "Stopped for your message",
} satisfies Record<InterruptionReason, (provider: string) => string>

/**
 * The footer's word for why a turn ended early. `provider` is the display
 * name of the harness that ran it; a dropped connection is that provider's
 * connection, and the label says so. A reason this build doesn't know (a
 * newer host's, relayed from the cloud) reads as an interruption.
 */
export function turnStopLabel(reason: InterruptionReason, provider: string): string {
  return Object.hasOwn(TURN_STOP_LABELS, reason) ? TURN_STOP_LABELS[reason](provider) : "Interrupted"
}

/**
 * Whether a request's turn ends on a failure row (`FailureRow`): a message
 * that failed, one whose outcome is unconfirmed with no stopped turn to say
 * so, or a turn Mako stopped because it couldn't save the conversation, which
 * says what happened, that the work stands and what to do. Every other turn
 * cut short says so in its footer (`turnStops`).
 */
export function endsOnFailureRow(request: Pick<LiveRequest, "status" | "interruption">): boolean {
  return request.status === "failed" ||
    (request.status === "uncertain" && !request.interruption) ||
    (request.status === "interrupted" && request.interruption?.reason === "not-saved")
}

/** A command or task, as the harness listed it, short enough for a footer. */
const STOPPED_SHOWN = 48

/**
 * What a stop also stopped, as the turn's footer says it: the one command by
 * name ("and stopped `npm run dev`"), or how many ("and stopped 3
 * background tasks"). The whole list is what the agent is told; `all` is
 * that list, one per line, for the line's tooltip.
 */
export function stoppedWorkWords(stopped: readonly string[]): { text: string; all: string } | undefined {
  const first = stopped[0]?.replace(/\s+/g, " ").trim()
  if (!first) return undefined
  const all = stopped.map((each) => each.replace(/\s+/g, " ").trim()).join("\n")
  if (stopped.length > 1) return { text: `and stopped ${stopped.length} background tasks`, all }
  return { text: `and stopped ${first.length > STOPPED_SHOWN ? `${first.slice(0, STOPPED_SHOWN - 1)}…` : first}`, all }
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
  /** Set on a held message that sends itself at a time: a usage limit's reset. */
  wake?: LiveRequest["wake"]
  /** Set on a held message that goes again by itself: its harness couldn't take it for now. */
  retry?: LiveRequest["retry"]
  /** Set on a digest of Fins' news: one `resting` goes with the next message. */
  digest?: LiveRequest["digest"]
  /** Set on a held message the person paused to edit: it keeps its place. */
  editing?: LiveRequest["editing"]
  /** Set on a held message the person's Stop paused: what they send next goes ahead of it. */
  pause?: LiveRequest["pause"]
  /** Set on a queued message waiting for this Mac to hear its account after it was away. */
  ownerCheck?: LiveRequest["ownerCheck"]
  displayText?: string
  /**
   * The host dropped under this send and did not come back within the
   * transport's wait. The prompt stays staged under its id and is re-issued
   * when the host reconnects; the host answers a repeated id with the first
   * acceptance, so it is never delivered twice.
   */
  unconfirmed?: boolean
  /** Why it waits in this device's outbox for the host (`waitsFor`): it goes by itself, in order, once the host can take it. */
  waiting?: string
  /** Sent into the running turn: it shows as steering until the turn takes it, or goes as the next message. */
  steering?: true
}

interface DeliveryInput {
  session: Pick<LiveSessionState, "status">
  blocks: Entry[]
  history?: Pick<LiveHistoryWindow, "earlierRequests">
  requests?: LiveRequest[]
  pendingPrompts?: PendingPrompt[]
  /** Read from its device's copy, that device being off: nothing starts here, so every message waits in the queue. */
  copy?: { at: number }
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

/**
 * Whether the transcript holds `id`'s turn, read for that one request. The surfaces that ask (the panel, the composer,
 * the queue, the live step) ask on every streamed batch, and reading every block of a long conversation into a set for
 * each was most of what a batch cost them.
 */
function transcribes(input: Pick<DeliveryInput, "blocks" | "history">, id: string): boolean {
  if (input.history?.earlierRequests?.includes(id)) return true
  for (let index = input.blocks.length - 1; index >= 0; index--) {
    const block = input.blocks[index]!
    if (block.type === "user" && block.requestId === id) return true
  }
  return false
}

export function recoverableRequests(input: Pick<DeliveryInput, "blocks" | "history" | "requests" | "copy">): LiveRequest[] {
  // Read only when a request needs it: most conversations hold none of these.
  let visible: Set<string> | undefined
  const shown = (id: string) => (visible ??= transcribedRequests(input)).has(id)
  const continuing = new Set((input.requests ?? []).filter(request => request.continues?.reason === "compaction-failed" &&
    (request.status === "queued" || request.status === "held" || request.status === "dispatching" || request.status === "completed")).map(request => request.continues!.requestId))
  const waiting = input.copy ? new Set<string>() : usageLimitSources(input.requests ?? [])
  // A turn the transcript shows carries its own stopped marker (`turnStops`);
  // only a stopped or unconfirmed message with no turn on screen needs a panel,
  // and a turn Mako couldn't save its failure row.
  return (input.requests ?? []).filter(
    (request) => !waiting.has(request.id) && !continuing.has(request.id) && (
      endsOnFailureRow(request) ||
      (request.status === "uncertain" && !shown(request.id)) ||
      (request.status === "interrupted" && !shown(request.id)))
  )
}

/**
 * Where each recoverable request is said. One whose turn the transcript
 * holds ends that turn with its failure row (`onTurns`, by request id); a
 * stopped or crashed turn there says so in its own footer instead. One that
 * never reached the transcript (refused before it was sent) is drawn after
 * the last turn (`apart`), but only since the last answer: older ones are in
 * the saved messages list.
 */
export function recoveriesByPlace(input: Pick<DeliveryInput, "blocks" | "history" | "requests" | "copy">) {
  const recoverable = recoverableRequests(input)
  const onTurns = new Map<string, LiveRequest>()
  const apart: LiveRequest[] = []
  if (!recoverable.length) return { onTurns, apart }
  const visible = transcribedRequests(input)
  const requests = input.requests ?? []
  const answered = requests.findLastIndex((request) => request.status === "completed")
  const recent = new Set(requests.slice(answered + 1).map((request) => request.id))
  for (const request of recoverable) {
    if (!visible.has(request.id)) {
      if (recent.has(request.id)) apart.push(request)
    } else if (endsOnFailureRow(request)) onTurns.set(request.id, request)
  }
  return { onTurns, apart }
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
    !input.copy && (input.session.status === "ready" || input.session.status === "starting")
  const first = delivering
    ? undefined
    : canStart
      ? waiting[0]
      : input.session.status === "failed"
        ? input.pendingPrompts?.[0]
        : undefined
  // A message waiting in this device's outbox stays in the queue, where its row says why, not drawn as sent.
  const starting = first?.status === "held" || (first && "waiting" in first && first.waiting) ? undefined : first
  return {
    starting: starting && !transcribes(input, starting.id) ? starting : null,
    queued: waiting.filter((prompt) => prompt.id !== starting?.id),
  }
}

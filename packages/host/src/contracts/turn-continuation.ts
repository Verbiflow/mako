import { INTERRUPTION_REASONS, type InterruptionReason, type LiveRequest } from "./live-conversations.js"

/**
 * How long Mako waits after a turn ends on a dropped connection before it
 * sends the continuation itself. Long enough for the settled turn to paint
 * and for a user already typing to send first, short enough that the thread
 * reads as one run that hiccuped rather than one that failed.
 */
export const AUTO_CONTINUE_DELAY_MS = 2_000

/** The interruptions whose work stands on the provider's side, so Mako continues them once itself. */
const AUTO_CONTINUED: ReadonlySet<InterruptionReason> = new Set(["connection-lost", "provider-exited"])

/**
 * Mako's own quit, restart or update, which the next host continues when the
 * person turned that on (`ConversationSettings.continueAfterRestart`). A host
 * that died (`host-crashed`) can't say whether the provider finished the turn,
 * so that one always waits for the person.
 */
const RESTART_CONTINUED: ReadonlySet<InterruptionReason> = new Set(["host-quit"])

/**
 * The loop guard on continuing after a restart: at most this many
 * continuations Mako sent in a row within `RESTART_CHAIN_MS`. A Mako
 * restarted again and again (an update loop, a crash on start) ends with the
 * person's Continue turn rather than with the agent picking the turn up each time.
 */
export const RESTART_CHAIN = 3
export const RESTART_CHAIN_MS = 5 * 60_000

/** How a person set Mako's conversations to behave. */
export interface ConversationSettings {
  /** Mako continues a turn its own quit, restart or update cut short once it is back (`host-quit`); off unless chosen. */
  continueAfterRestart: boolean
}

/** Who sent a continuation: Mako on its own, or the person through Continue turn. */
export type ContinuationSender = "mako" | "person"

/** What cut the turn short and what to check, in the words the agent is told. */
const SITUATIONS = {
  "connection-lost":
    "Continue where you left off. Your connection dropped before you finished the previous turn, and its last steps may not have been saved. Check the result of any command or edit you were in the middle of before repeating it.",
  "provider-exited":
    "Continue where you left off. Your process stopped before you finished the previous turn and has been restarted; the work you did so far is in place. Check the result of any command or edit you were in the middle of before repeating it.",
  "signed-out":
    "Continue where you left off. Your sign-in expired before you finished the previous turn and has been renewed; the work you did so far is in place. Check the result of any command or edit you were in the middle of before repeating it.",
  "host-quit": "Continue where you left off. Mako closed before you finished the previous turn; pick it up from there.",
  "host-crashed": "Continue where you left off. Mako closed before you finished the previous turn; pick it up from there.",
  stopped: "Continue where you left off. Mako closed before you finished the previous turn; pick it up from there.",
  "handed-off":
    "Continue where you left off. Mako stopped your work to hand this conversation to another machine; the work you did so far is in place. Check the result of any command or edit you were in the middle of before repeating it.",
  "not-saved":
    "Continue where you left off. Mako stopped your previous turn because it couldn't save this conversation; the work you did so far is in place. Check the result of any command or edit you were in the middle of before repeating it.",
  "goal-budget":
    "Continue where you left off. Mako stopped your previous turn when the goal reached its token budget; the work you did so far is in place. Check the result of any command or edit you were in the middle of before repeating it.",
  "machine-lost":
    "Continue where you left off. Your previous turn was interrupted before it finished, and Mako brought this conversation and its files back as they were after your last finished step: a command or edit that was still running didn't finish, and anything you left running in the background stopped. Check the state of what you were in the middle of before repeating it.",
} as const satisfies Record<InterruptionReason, string>

/**
 * The sentence that says who sent it. It tells the agent nothing new was
 * asked, and it is how a saved conversation, which keeps no request, tells
 * Mako's continuation from the person's: the store holds only the words.
 */
const SENDERS = {
  mako: "Mako sent this on its own; nobody has asked for anything new.",
  person: "The person asked you to pick it up; they haven't asked for anything new.",
} as const satisfies Record<ContinuationSender, string>

const CONTINUATION_SENDERS: readonly ContinuationSender[] = ["mako", "person"]

/** At most this many of the commands a stop named, each at most `STOPPED_CHARS` long. */
const STOPPED_NAMED = 8
const STOPPED_CHARS = 200
/** What stopped the background work, for the cuts that stop it: Mako's exit ends the harness's process, a handoff stops it. */
const STOPPED_BY = { "host-quit": "Mako's exit", "handed-off": "The handoff" } as const satisfies Partial<Record<InterruptionReason, string>>
const STOPPERS: readonly string[] = [...Object.values(STOPPED_BY), "Mako"]
const STOPPED_CLOSES = ". Start again whatever of it you still need."

function stoppedOpens(by: string): string {
  return `${by} stopped what you had left running in the background: `
}

/** The sentence naming the background work a cut stopped, its commands or tasks as the harness listed them. */
function stoppedSentence(reason: InterruptionReason, stopped: readonly string[]): string {
  const named = stopped.slice(0, STOPPED_NAMED).map((each) => {
    const line = each.replace(/\s+/g, " ").trim()
    return `\`${line.length > STOPPED_CHARS ? `${line.slice(0, STOPPED_CHARS - 1)}…` : line}\``
  })
  const more = stopped.length - named.length
  const by = reason === "host-quit" || reason === "handed-off" ? STOPPED_BY[reason] : "Mako"
  return `${stoppedOpens(by)}${named.join("; ")}${more > 0 ? `; and ${more} more` : ""}${STOPPED_CLOSES}`
}

/**
 * What is sent to pick up a turn that was cut short, worded for what cut it and who sends it. `stopped`: the work the
 * agent had left running in the background, which Mako's exit or a handoff stopped (`Interruption.stopped`), named so
 * the agent can start again what it needs.
 */
export function continueTurnPrompt(reason: InterruptionReason, sender: ContinuationSender, stopped: readonly string[] = []): string {
  return stopped.length ? `${SITUATIONS[reason]} ${stoppedSentence(reason, stopped)} ${SENDERS[sender]}` : `${SITUATIONS[reason]} ${SENDERS[sender]}`
}

/** A continuation read back by its words: what cut the turn short, and who sent it when the words say. */
export interface SavedContinuation {
  reason: InterruptionReason
  sender?: ContinuationSender
}

/**
 * The continuation `text` is, read back from a saved conversation by its
 * whole words: what cut the turn short, and who sent it. Builds before
 * October 2026 sent the same words whoever sent them, so such a text has no
 * `sender`: the store can't say whether Mako or the person sent it. A host
 * exit's three reasons share their words and read as `host-quit`.
 */
export function savedContinuation(text: string): SavedContinuation | undefined {
  const words = text.trim()
  if (!words.startsWith("Continue where you left off.")) return undefined
  for (const each of INTERRUPTION_REASONS) {
    const reason = SITUATIONS[each] === SITUATIONS["host-quit"] ? "host-quit" : each
    if (words === SITUATIONS[reason]) return { reason }
    for (const sender of CONTINUATION_SENDERS) {
      if (words === continueTurnPrompt(reason, sender)) return { reason, sender }
      // With the background work a cut stopped named between the two: Mako's words around commands of the agent's.
      const middle = words.startsWith(`${SITUATIONS[reason]} `) && words.endsWith(` ${SENDERS[sender]}`) ? words.slice(SITUATIONS[reason].length + 1, -SENDERS[sender].length - 1) : undefined
      if (middle?.endsWith(STOPPED_CLOSES) && STOPPERS.some((by) => middle.startsWith(stoppedOpens(by)))) return { reason, sender }
    }
  }
  return undefined
}

/**
 * The one request Mako may continue on its own, or `undefined`.
 *
 * It is the newest request that is not canceled, it ended on a dropped
 * connection or an exited provider process, nothing is queued or running
 * behind it, and it is the user's turn rather than a continuation Mako
 * already sent: one attempt per turn, so a connection or process that keeps
 * dropping ends with the manual offer and not a loop of Mako talking to
 * itself. A request that has already been continued (by the user or by
 * Mako) is never a candidate again.
 *
 * `restarted`: the host has just started after Mako's own quit, restart or
 * update and the person chose to continue such turns, so `host-quit` is one
 * too. A continuation Mako sent may be cut by the next restart in turn; that
 * is continued while fewer than `RESTART_CHAIN` of Mako's continuations in a
 * row were cut short in the last `RESTART_CHAIN_MS`.
 */
export function autoContinueCandidate(requests: readonly LiveRequest[], restarted = false, now = Date.now()): LiveRequest | undefined {
  let newest: LiveRequest | undefined
  for (let index = requests.length - 1; index >= 0 && !newest; index -= 1) {
    const request = requests[index]
    if (request && request.status !== "canceled") newest = request
  }
  const reason = newest?.interruption?.reason
  if (!newest || newest.status !== "interrupted" || !reason) return undefined
  const restart = restarted && RESTART_CONTINUED.has(reason)
  if (!restart && !AUTO_CONTINUED.has(reason)) return undefined
  if (newest.continues?.auto && (!restart || chainedContinuations(requests, newest, now) >= RESTART_CHAIN)) return undefined
  if (requests.some((request) => request.continues?.requestId === newest.id)) return undefined
  return newest
}

/** How many of Mako's continuations lead in a row to `last`, it included, counting those cut short within `RESTART_CHAIN_MS` of `now`. */
function chainedContinuations(requests: readonly LiveRequest[], last: LiveRequest, now: number): number {
  const byId = new Map(requests.map((request) => [request.id, request]))
  const seen = new Set<string>()
  let count = 0
  for (let request: LiveRequest | undefined = last; request?.continues?.auto && !seen.has(request.id); request = byId.get(request.continues.requestId)) {
    seen.add(request.id)
    if (now - (request.interruption?.at ?? 0) <= RESTART_CHAIN_MS) count += 1
  }
  return count
}

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

/** At most this many of the commands a move stopped are named, each at most `STOPPED_CHARS` long. */
const STOPPED_NAMED = 8
const STOPPED_CHARS = 200
const STOPPED_OPENS = "The handoff stopped what you had left running in the background: "
const STOPPED_CLOSES = ". Start again whatever of it you still need."

/** The sentence naming the background work a handoff stopped, its commands or tasks as the harness listed them. */
function stoppedSentence(stopped: readonly string[]): string {
  const named = stopped.slice(0, STOPPED_NAMED).map((each) => {
    const line = each.replace(/\s+/g, " ").trim()
    return `\`${line.length > STOPPED_CHARS ? `${line.slice(0, STOPPED_CHARS - 1)}…` : line}\``
  })
  const more = stopped.length - named.length
  return `${STOPPED_OPENS}${named.join("; ")}${more > 0 ? `; and ${more} more` : ""}${STOPPED_CLOSES}`
}

/**
 * What is sent to pick up a turn that was cut short, worded for what cut it and who sends it. `stopped`: the work the
 * agent had left running in the background, which a handoff stopped, named so the agent can start again what it needs.
 */
export function continueTurnPrompt(reason: InterruptionReason, sender: ContinuationSender, stopped: readonly string[] = []): string {
  return stopped.length ? `${SITUATIONS[reason]} ${stoppedSentence(stopped)} ${SENDERS[sender]}` : `${SITUATIONS[reason]} ${SENDERS[sender]}`
}

/**
 * The continuation `text` is, read back from a saved conversation by its
 * whole words: what cut the turn short, and who sent it. Builds before
 * October 2026 sent the same words whoever sent them, so such a text has no
 * `sender`: the store can't say whether Mako or the person sent it. A host
 * exit's three reasons share their words and read as `host-quit`.
 */
export function savedContinuation(text: string): { reason: InterruptionReason; sender?: ContinuationSender } | undefined {
  const words = text.trim()
  if (!words.startsWith("Continue where you left off.")) return undefined
  for (const each of INTERRUPTION_REASONS) {
    const reason = SITUATIONS[each] === SITUATIONS["host-quit"] ? "host-quit" : each
    if (words === SITUATIONS[reason]) return { reason }
    for (const sender of CONTINUATION_SENDERS) {
      if (words === continueTurnPrompt(reason, sender)) return { reason, sender }
      // With the background work a handoff stopped named between the two: Mako's words around commands of the agent's.
      const middle = words.startsWith(`${SITUATIONS[reason]} `) && words.endsWith(` ${SENDERS[sender]}`) ? words.slice(SITUATIONS[reason].length + 1, -SENDERS[sender].length - 1) : undefined
      if (middle?.startsWith(STOPPED_OPENS) && middle.endsWith(STOPPED_CLOSES)) return { reason, sender }
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
 */
export function autoContinueCandidate(requests: readonly LiveRequest[]): LiveRequest | undefined {
  let newest: LiveRequest | undefined
  for (let index = requests.length - 1; index >= 0 && !newest; index -= 1) {
    const request = requests[index]
    if (request && request.status !== "canceled") newest = request
  }
  if (
    !newest ||
    newest.status !== "interrupted" ||
    !newest.interruption ||
    !AUTO_CONTINUED.has(newest.interruption.reason) ||
    newest.continues?.auto
  )
    return undefined
  if (requests.some((request) => request.continues?.requestId === newest.id)) return undefined
  return newest
}

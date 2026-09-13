import type { InterruptionReason, LiveRequest } from "./live-conversations.js"

/**
 * How long Mako waits after a turn ends on a dropped connection before it
 * sends the continuation itself. Long enough for the settled turn to paint
 * and for a user already typing to send first, short enough that the thread
 * reads as one run that hiccuped rather than one that failed.
 */
export const AUTO_CONTINUE_DELAY_MS = 2_000

/** What is sent to pick up a turn that was cut short, worded for what cut it. */
export function continueTurnPrompt(reason: InterruptionReason): string {
  switch (reason) {
    case "connection-lost":
      return "Continue where you left off. Your connection dropped before you finished the previous turn; the work you did so far is in place, so pick it up from there."
    case "host-quit":
    case "host-crashed":
    case "stopped":
      return "Continue where you left off. Mako closed before you finished the previous turn; pick it up from there."
  }
}

/**
 * The one request Mako may continue on its own, or `undefined`.
 *
 * It is the newest request that is not canceled, it ended on a dropped
 * connection, nothing is queued or running behind it, and it is the user's
 * turn rather than a continuation Mako already sent: one attempt per turn,
 * so a connection that keeps dropping ends with the manual offer and not a
 * loop of Mako talking to itself. A request that has already been continued
 * (by the user or by Mako) is never a candidate again.
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
    newest.interruption?.reason !== "connection-lost" ||
    newest.continues?.auto
  )
    return undefined
  if (requests.some((request) => request.continues?.requestId === newest.id)) return undefined
  return newest
}

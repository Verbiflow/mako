import { exactCall, type ToolNames, bareNames } from "./native-calls.js"

/**
 * What a read of Mako's own tools tells an agent to do next while what it reads is still under way: its Fins' reports
 * and a pull request's checks wake it, so it ends its turn rather than reading again (`PollAnswers`).
 */

/** `agents_list` with Fins at work and none waiting on the caller. */
export const AFTER_LIST = "Their reports wake you. End your turn or keep working; don't poll."

/** `agents_read` of a Fin still at work. */
export const AFTER_READ = "Its report wakes you. End your turn or keep working; don't poll."

/** `agents_wait` that held its whole window with nothing new. */
export const AFTER_WAIT_TIMEOUT = "Nothing new: reports wake you without it. End your turn now; don't wait again."

/** `pull_request_status` with checks still running on the head: the wait that ends when they settle. */
export function afterChecksPending(pull: string, names: ToolNames = bareNames): string {
  return `Checks are still running. Call ${exactCall(names, "wait", { on: [{ pull, until: "checks" }] })} and end your turn: Mako wakes you when they settle.`
}

/**
 * A repeat of a read whose answer didn't change: which call, how long since the same answer, and, for Fins, who is
 * still at work. `rest` is what wakes the caller instead.
 */
export function unchangedNext(call: string, since: number, working: readonly string[], rest: string): string {
  const who = working.length ? `: ${working.slice(0, 3).map((name) => `fin:${name}`).join(", ")}${working.length > 3 ? ` and ${working.length - 3} more` : ""} ${working.length === 1 ? "is" : "are"} working` : ""
  return `Nothing changed since your last ${call} ${since} s ago${who}. ${rest}`
}

/** What wakes a caller that read its Fins again: their reports. */
export const FINS_WAKE = "Their reports wake you; end your turn."

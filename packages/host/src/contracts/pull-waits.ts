/**
 * A Fin waiting on a pull request its report named (`WaitingOn` of kind `pull-request`): what GitHub says of it
 * (`PullReading`), the outcome that wakes the Fin (`pullOutcome`), and the one line Mako wakes it with
 * (`pullWakeNote`), which its transcript reads back as an event line (`pullWakeWords`).
 */

/** What a Fin waits for on a pull request; absent, the first outcome of any. */
export type PullWaitUntil = "checks" | "review" | "merge"

/** A pull request as the watch reads it: its state, its head's checks and its latest reviews, each with when it finished. */
export interface PullReading {
  state: "open" | "merged" | "closed"
  url: string
  /** Head observed with this check rollup. A wake is a snapshot of it, never authorization to merge the later head. */
  head?: string
  /** Earliest current-head check start, an upper bound on when it was pushed; never a commit author date. */
  headAt?: number
  /** Its author's login: their own review comments are replies, not a review. */
  author?: string
  checks: { name: string; state: "passed" | "failed" | "running" | "cancelled" | "unknown"; at?: number }[]
  /**
   * The checks its base branch requires (rulesets and branch protection), by name, when they could be read: its
   * checks have settled only once each of these ran. Absent when unreadable, and then settling is as it was.
   */
  required?: string[]
  reviews: { login: string; state: "approved" | "changes" | "commented"; at?: number }[]
}

/**
 * How long a wait on checks takes a head with none before it says so (`no-checks`): GitHub starts a push's checks
 * within a minute or two, and a head that has none this long after the report has nothing coming (#803 on 2026-11-15:
 * its CI never started, and its Fin's checks wait could never end).
 */
export const NO_CHECKS_MS = 15 * 60_000
export const CI_INCOMPLETE_MS = 45 * 60_000
export const PULL_READ_FAILED_MS = 15 * 60_000

/**
 * What happened on a pull request a Fin waits on: its checks all finished, one failed while others still run, its head
 * still had no checks `NO_CHECKS_MS` after the report, checks remained incomplete for `CI_INCOMPLETE_MS`, its reader
 * failed for `PULL_READ_FAILED_MS`, a review came in, or it merged or closed. Incomplete/unreadable is never a pass.
 */
export type PullOutcome =
  | { kind: "no-checks"; minutes: number; missing?: string[] }
  | { kind: "incomplete"; minutes: number; running: string[] }
  | { kind: "unreadable"; minutes: number }
  | { kind: "settled"; passed: number; failed: string[]; cancelled?: string[] }
  | { kind: "failed"; check: string; running: number }
  | { kind: "review"; by: string; state: "approved" | "changes" | "commented" }
  | { kind: "merged" }
  | { kind: "closed" }

/**
 * The outcome a wait since `since` (its report's time) sees in `reading`, matched to `until`: merged or closed ends
 * every wait; `review` takes a review submitted since, by anyone but the author; `checks` takes its checks settled,
 * or a check that failed while others run, even if it finished before the report. The reader supplies the current
 * head's checks: registering a wait doesn't mean the Fin already knows their outcome. An incomplete wake uses a
 * conservative after-push bound (a check's start or the head's first observation), independent of the report's age.
 * Undefined while nothing it waits for happened.
 */
export function pullOutcome(reading: PullReading, until: PullWaitUntil | undefined, since: number, now?: number, seen?: number): PullOutcome | undefined {
  if (reading.state === "merged") return { kind: "merged" }
  if (reading.state === "closed") return { kind: "closed" }
  if (until === "merge") return undefined
  if (until !== "checks") {
    const review = reading.reviews
      .filter((each) => each.at !== undefined && each.at >= since && each.login !== reading.author)
      .sort((left, right) => left.at! - right.at!)[0]
    if (review) return { kind: "review", by: review.login, state: review.state }
    if (until === "review") return undefined
  }
  const checks = reading.checks
  // How long this head has gone without what should run: from the later of the report and when the watch first saw
  // the head (`seen`), so a push after the report starts the clock again.
  const due = now !== undefined && now - Math.max(since, seen ?? since) >= NO_CHECKS_MS
  const minutes = Math.round(NO_CHECKS_MS / 60_000)
  // The checks its base branch requires that haven't run on this head: until they do, nothing has settled (#803, 2026-11-15:
  // only Public text ran, its real CI never started, and a wait would have read "1 passed").
  const missing = reading.required?.filter((name) => !checks.some((check) => check.name === name)) ?? []
  // None at all is no outcome yet, until long enough has passed that none are coming: then the Fin hears so, once a head.
  if (!checks.length) return due ? { kind: "no-checks", minutes, ...(missing.length && { missing }) } : undefined
  const running = checks.filter((check) => check.state === "running" || check.state === "unknown").length
  const failed = checks.filter((check) => check.state === "failed")
  // What ran has finished but what the branch requires never started: a failure is still news, the rest waits for them.
  if (!running && missing.length) return failed[0] ? { kind: "failed", check: failed[0].name, running: 0 } : due ? { kind: "no-checks", minutes, missing } : undefined
  // A run cancelled with no newer one after it (the reader drops one a newer run replaced) settled without failing.
  const cancelled = checks.filter((check) => check.state === "cancelled").map((check) => check.name)
  if (!running) return { kind: "settled", passed: checks.length - failed.length - cancelled.length, failed: failed.map((check) => check.name), ...(cancelled.length && { cancelled }) }
  // Checks can start after a push, so this clock is conservative. With no timestamp, first seeing the head is the bound.
  const firstSeen = seen ?? since
  const headAt = reading.headAt !== undefined && Number.isFinite(reading.headAt) && reading.headAt > 0
    ? Math.min(firstSeen, reading.headAt) : firstSeen
  if (now !== undefined && now - headAt >= CI_INCOMPLETE_MS)
    return { kind: "incomplete", minutes: CI_INCOMPLETE_MS / 60_000, running: checks.filter(check => check.state === "running" || check.state === "unknown").map(check => check.name) }
  const first = failed[0]
  return first ? { kind: "failed", check: first.name, running } : undefined
}

const NAMED_CHECKS = 4

/** At most `NAMED_CHECKS` names, and how many more. */
function listed(names: readonly string[]): string {
  return `${names.slice(0, NAMED_CHECKS).join(", ")}${names.length > NAMED_CHECKS ? `, ${names.length - NAMED_CHECKS} more` : ""}`
}

function outcomeWords(outcome: PullOutcome): string {
  switch (outcome.kind) {
    case "settled": {
      const cancelled = outcome.cancelled?.length ? `, ${outcome.cancelled.length} cancelled (${listed(outcome.cancelled)})` : ""
      if (!outcome.failed.length) return `checks settled: ${outcome.passed === 1 && !cancelled ? "1 passed" : cancelled ? `${outcome.passed} passed` : `all ${outcome.passed} passed`}${cancelled}`
      return `checks settled: ${outcome.failed.length} failed (${listed(outcome.failed)})${cancelled}`
    }
    case "no-checks":
      return outcome.missing?.length ? `required checks missing after ${outcome.minutes}m: ${listed(outcome.missing)}` : `checks: none after ${outcome.minutes}m`
    case "incomplete":
      return `checks incomplete after ${outcome.minutes}m: ${listed(outcome.running)}`
    case "unreadable":
      return `GitHub reads failed for ${outcome.minutes}m; the PR's checks and state are unknown`
    case "failed":
      return `check failed: ${outcome.check}${outcome.running ? `, ${outcome.running} still running` : ""}`
    case "review":
      return `review: ${outcome.by} ${outcome.state === "approved" ? "approved" : outcome.state === "changes" ? "requested changes" : "commented"}`
    case "merged":
      return "merged"
    case "closed":
      return "closed without merging"
  }
}

/** The one line Mako wakes the Fin with: "Mako: PR acme/app#371 checks settled: 2 failed (lint, e2e). <url>". */
export function pullWakeNote(pull: string, url: string | undefined, outcome: PullOutcome, head?: string): string {
  return `${PULL_WAKE_HEAD}${pull} ${outcomeWords(outcome)}${head ? `; observed head ${head}` : ""}.${url ? ` ${url}` : ""}`
}
const PULL_WAKE_HEAD = "Mako: PR "
const OUTCOME_WORDS = String.raw`checks settled: (?:all \d+ passed|1 passed|\d+ passed|\d+ failed \([^\n)]*\))(?:, \d+ cancelled \([^\n)]*\))?|checks: none after \d+m|required checks missing after \d+m: [^\n]+?|checks incomplete after \d+m: [^\n]+?|GitHub reads failed for \d+m; the PR's checks and state are unknown|check failed: [^\n]+?|review: \S+ (?:approved|requested changes|commented)|merged|closed without merging`
const PULL_WAKE = new RegExp(String.raw`^Mako: PR ([\w.-]+\/[\w.-]+#\d+|#\d+) (${OUTCOME_WORDS})(; observed head [a-f0-9]{40,64})?\.(?: (https?:\/\/\S+))?$`)

/** A wake's note read back from its words, as a saved transcript keeps it: what its event line says, and the link. */
export function pullWakeWords(text: string): { line: string; url?: string } | undefined {
  const found = PULL_WAKE.exec(text.trim())
  if (!found) return undefined
  return { line: `${PULL_WAKE_HEAD}${found[1]} ${found[2]}${found[3] ?? ""}.`, ...(found[4] && { url: found[4] }) }
}

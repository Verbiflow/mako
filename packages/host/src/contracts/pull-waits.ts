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
  /** Its author's login: their own review comments are replies, not a review. */
  author?: string
  checks: { name: string; state: "passed" | "failed" | "running" | "cancelled" | "unknown"; at?: number }[]
  reviews: { login: string; state: "approved" | "changes" | "commented"; at?: number }[]
}

/**
 * What happened on a pull request a Fin waits on: its checks all finished, one failed while others still run, a review
 * came in, or it merged or closed.
 */
export type PullOutcome =
  | { kind: "settled"; passed: number; failed: string[]; cancelled?: string[] }
  | { kind: "failed"; check: string; running: number }
  | { kind: "review"; by: string; state: "approved" | "changes" | "commented" }
  | { kind: "merged" }
  | { kind: "closed" }

/**
 * The outcome a wait since `since` (its report's time) sees in `reading`, matched to `until`: merged or closed ends
 * every wait; `review` takes a review submitted since, by anyone but the author; `checks` takes its checks settled,
 * or a check that failed while others run, even if it finished before the report. The reader supplies the current
 * head's checks: registering a wait doesn't mean the Fin already knows their outcome. Undefined while nothing it waits
 * for happened.
 */
export function pullOutcome(reading: PullReading, until: PullWaitUntil | undefined, since: number): PullOutcome | undefined {
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
  if (!checks.length) return undefined
  const running = checks.filter((check) => check.state === "running" || check.state === "unknown").length
  const failed = checks.filter((check) => check.state === "failed")
  // A run cancelled with no newer one after it (the reader drops one a newer run replaced) settled without failing.
  const cancelled = checks.filter((check) => check.state === "cancelled").map((check) => check.name)
  if (!running) return { kind: "settled", passed: checks.length - failed.length - cancelled.length, failed: failed.map((check) => check.name), ...(cancelled.length && { cancelled }) }
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
const OUTCOME_WORDS = String.raw`checks settled: (?:all \d+ passed|1 passed|\d+ passed|\d+ failed \([^\n)]*\))(?:, \d+ cancelled \([^\n)]*\))?|check failed: [^\n]+?|review: \S+ (?:approved|requested changes|commented)|merged|closed without merging`
const PULL_WAKE = new RegExp(String.raw`^Mako: PR ([\w.-]+\/[\w.-]+#\d+|#\d+) (${OUTCOME_WORDS})(; observed head [a-f0-9]{40,64})?\.(?: (https?:\/\/\S+))?$`)

/** A wake's note read back from its words, as a saved transcript keeps it: what its event line says, and the link. */
export function pullWakeWords(text: string): { line: string; url?: string } | undefined {
  const found = PULL_WAKE.exec(text.trim())
  if (!found) return undefined
  return { line: `${PULL_WAKE_HEAD}${found[1]} ${found[2]}${found[3] ?? ""}.`, ...(found[4] && { url: found[4] }) }
}

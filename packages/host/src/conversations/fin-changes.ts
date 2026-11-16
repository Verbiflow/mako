import type { ChildState, FinPullRequest, ReportStatus } from "../contracts/agents.js"

/** What says a Fin changed for its Apex: where it stands, its last report, what it asks or holds open, its pull requests. */
export interface ChangeFacts {
  state: ChildState
  report?: { status: ReportStatus; at: number }
  pulls?: readonly FinPullRequest[]
  questions?: number
  actions?: number
}

/**
 * Where a Fin stands, less what moves while nothing changes for its Apex: a working Fin's step and phase, a queued one's
 * place in line, how long a quiet one has been quiet. A question, an answer, a wait, an end and its decision all count.
 */
function standing(state: ChildState): string {
  switch (state.kind) {
    case "working":
      return JSON.stringify({ kind: state.kind, answered: state.answered, quiet: state.quiet !== undefined })
    case "starting":
      return JSON.stringify({ kind: state.kind })
    case "queued":
      return JSON.stringify({ kind: state.kind, reason: state.reason, after: state.after, held: state.held, refused: state.refused, apexStopped: state.apexStopped })
    case "idle":
      return JSON.stringify({ kind: state.kind, waitingOn: state.waitingOn })
    case "blocked":
    case "ended":
      return JSON.stringify(state)
  }
}

/** The facts as one comparable value. */
export function changePrint(facts: ChangeFacts): string {
  return JSON.stringify([
    standing(facts.state),
    facts.report ? [facts.report.status, facts.report.at] : null,
    (facts.pulls ?? []).map((pull) => [pull.repository ?? "", pull.number, pull.state]),
    facts.questions ?? 0,
    facts.actions ?? 0,
  ])
}

/**
 * When each Fin last changed for its Apex, as this host saw it (`agents_list`'s `changedAt` and `since`, the front
 * door's unchanged count): the first time it read the Fin's facts different from the last time, or the first time it
 * read them at all. Kept for this host's life: after a restart every Fin reads as changed when first read, so a mark
 * from before never hides a change.
 */
export class FinChanges {
  private readonly seen = new Map<string, { print: string; at: number }>()

  /** When `child` last changed, reading `facts` at `now`. */
  at(child: string, facts: ChangeFacts, now: number): number {
    const print = changePrint(facts)
    const was = this.seen.get(child)
    if (was?.print === print) return was.at
    this.seen.set(child, { print, at: now })
    return now
  }
}

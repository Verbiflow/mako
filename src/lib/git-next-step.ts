import { landState, type LandWith } from "./worktree-landing"

/** One thing the Changes panel's Git control can do next. */
export type GitStep =
  | { kind: "continue"; operation: string; blocked: string | null }
  | { kind: "abort"; operation: string }
  | { kind: "pull"; commits: number; way: "pull" | "merge" | "merge_autostash"; blocked: string | null }
  | { kind: "push"; commits: number; publish: boolean }
  | { kind: "open-pull"; blocked: string | null }
  | { kind: "land"; into: string; blocked: string | null }
  | { kind: "view-pull"; number: number }
  | { kind: "merge-pull"; number: number; blocked: string | null }
  | { kind: "fix-checks"; number: number; failing: readonly string[] }
  | { kind: "remove-worktree" }

export interface GitStepFacts {
  /** Commits the upstream doesn't have. */
  ahead: number
  /** Commits the upstream has that this branch doesn't. */
  behind: number
  /** The branch has an upstream. */
  published: boolean
  /** Tracked files with changes not committed. */
  changed: boolean
  /** A merge, rebase or similar under way. */
  operation: string | null
  conflicts: boolean
  /** The last pull stopped on local edits that overlap; the next one stashes them. */
  keepEdits: boolean
  /** A push is under way or just finished; it holds the button until it settles. */
  pushing: boolean
  /** The repository's default branch, checked out outside a Thread's worktree. */
  onDefault: boolean
  /** Why a pull request can't be opened from here, null when it can, undefined while GitHub is checked. */
  pullBlocked: string | null | undefined
  /** The branch's open pull request. */
  pull: { number: number; mergeBlocked: string | null; failing: readonly string[] } | null
  /** This Thread's own worktree, which lands in the main checkout's branch. */
  worktree: { into: string; commits: number; landed: boolean; mergeBlocked: string | null; last: LandWith | undefined } | null
}

/** The one step the control offers, and the others behind its chevron. */
export interface GitSteps {
  primary: GitStep | null
  more: GitStep[]
}

const NONE: GitSteps = { primary: null, more: [] }

/**
 * What the Changes panel offers next, in the order a branch moves: finish what
 * Git stopped in, take in what the upstream has, then push, open or land, and
 * once the pull request is open, view, merge or fix it. One primary at a time,
 * so the panel never shows Push, Open pull request and Merge side by side.
 */
export function gitNextStep(facts: GitStepFacts): GitSteps {
  if (facts.operation) {
    return {
      primary: { kind: "continue", operation: facts.operation, blocked: facts.conflicts ? "Resolve and stage every conflicted file first." : null },
      more: [{ kind: "abort", operation: facts.operation }],
    }
  }
  const push: GitStep | null = facts.ahead > 0 || !facts.published || facts.pushing ? { kind: "push", commits: facts.ahead, publish: !facts.published } : null
  if (facts.behind > 0) {
    const way = facts.keepEdits ? "merge_autostash" : facts.ahead > 0 ? "merge" : "pull"
    return { primary: { kind: "pull", commits: facts.behind, way, blocked: facts.conflicts ? "Resolve conflicted files first." : null }, more: [] }
  }
  if (facts.pushing && push) return { primary: push, more: [] }

  const pull = facts.pull
  const pullSteps = (land: GitStep | null): GitSteps => {
    if (!pull) return NONE
    const view: GitStep = { kind: "view-pull", number: pull.number }
    const rest: GitStep[] = [
      { kind: "merge-pull", number: pull.number, blocked: pull.mergeBlocked },
      ...(pull.failing.length ? [{ kind: "fix-checks", number: pull.number, failing: pull.failing } as const] : []),
      ...(land ? [land] : []),
    ]
    return facts.ahead > 0 && push ? { primary: push, more: [view, ...rest] } : { primary: view, more: rest }
  }

  const worktree = facts.worktree
  if (worktree) {
    const land: GitStep = { kind: "land", into: worktree.into, blocked: worktree.mergeBlocked }
    const state = landState({ commits: worktree.commits, changed: facts.changed, operation: false, landed: worktree.landed, pullOpen: Boolean(pull), last: worktree.last })
    if (state.kind === "landed") return { primary: { kind: "remove-worktree" }, more: [] }
    if (state.kind === "pull") return pullSteps(worktree.commits > 0 ? land : null)
    if (state.kind === "commits") {
      const open: GitStep = { kind: "open-pull", blocked: facts.pullBlocked === undefined ? "Checking GitHub…" : facts.pullBlocked }
      const [primary, other] = state.main === "pull" ? [open, land] : [land, open]
      return { primary, more: push ? [other, push] : [other] }
    }
    return push ? { primary: push, more: [] } : NONE
  }

  if (pull) return pullSteps(null)
  if (!push) return NONE
  if (facts.onDefault) return { primary: push, more: [] }
  if (facts.pullBlocked === null) return { primary: { kind: "open-pull", blocked: null }, more: [push] }
  return { primary: push, more: facts.pullBlocked ? [{ kind: "open-pull", blocked: facts.pullBlocked }] : [] }
}

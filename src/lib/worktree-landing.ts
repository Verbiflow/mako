/** How a worktree's branch goes into its project's branch when it isn't through a pull request already. */
export type LandWith = "merge" | "pull"

/** What Since main offers as its one landing action. */
export type LandState =
  /** Uncommitted changes or a merge under way: the commit box and the conflict come first, so nothing to land yet. */
  | { kind: "busy" }
  /** Nothing committed that its project's branch lacks. */
  | { kind: "nothing" }
  | { kind: "commits"; main: LandWith }
  /** Its pull request is open: view it, with its checks. */
  | { kind: "pull" }
  /** Everything it committed is in its project's branch: the worktree can go. */
  | { kind: "landed" }

export interface LandFacts {
  /** Commits the project's branch doesn't have. */
  commits: number
  /** Tracked files with changes not committed. */
  changed: boolean
  /** A merge, rebase or other operation is under way. */
  operation: boolean
  /** Merged, rebased or squashed in, including a pull request merged at the branch's tip. */
  landed: boolean
  pullOpen: boolean
  /** What the person used last in this project. */
  last: LandWith | undefined
}

export function landState(facts: LandFacts): LandState {
  if (facts.operation) return { kind: "busy" }
  if (facts.landed) return facts.changed ? { kind: "busy" } : { kind: "landed" }
  if (facts.pullOpen) return { kind: "pull" }
  if (facts.changed) return { kind: "busy" }
  if (facts.commits > 0) return { kind: "commits", main: facts.last ?? "merge" }
  return { kind: "nothing" }
}

export function readLandWith(value: string | undefined): LandWith | undefined {
  return value === "merge" || value === "pull" ? value : undefined
}

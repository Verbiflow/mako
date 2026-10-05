import type { WorktreeLanding, WorktreeSummary } from "../../electron/contracts/thread-worktrees.ts"

/** Landed by any route: Git's rules, or (`summary`) a pull request merged at the branch's tip. */
export function landedFor(landing: WorktreeLanding, summary: Pick<WorktreeSummary, "landing"> | undefined): boolean {
  return landing.kind === "merged" || landing.kind === "empty" || summary?.landing.kind === "merged"
}

/** What a removed worktree leaves behind, for its toast. */
export function removedNote(branch: string, landing: WorktreeLanding, summary?: Pick<WorktreeSummary, "landing" | "into">): string {
  const merged = landing.kind === "merged" ? landing : summary?.landing.kind === "merged" ? summary.landing : null
  if (merged) return `${branch} is in ${merged.into}, and its branch is kept`
  if (landing.kind === "open") return landing.commits === 1 ? `Its commit stays on ${branch}` : `Its ${landing.commits} commits stay on ${branch}`
  if (landing.kind === "empty") return `Nothing was committed there; ${branch} is kept`
  return `${branch} keeps its commits`
}

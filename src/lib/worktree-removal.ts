import { worktreeCheckout, type WorktreeDetail, type WorktreeLanding, type WorktreeSummary } from "../../electron/contracts/thread-worktrees.ts"

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

/**
 * A Thread's checkout as Settings lists it: one repository's worktree, or
 * a project folder's worktree of each repository in it, which go together.
 * What decides whether it can go is its worktrees' together.
 */
export interface CheckoutDetail extends Pick<WorktreeDetail, "project" | "branch" | "createdAt" | "thread" | "changes" | "held" | "landing" | "users" | "bytes"> {
  /** The folder its Thread works in. */
  path: string
  /** One per repository, in the order of their place in the project. */
  worktrees: WorktreeDetail[]
}

/** Where a checkout's branch stands in all its repositories: open in any is open, all in is merged, none committed anywhere is empty. */
function checkoutLanding(worktrees: readonly WorktreeDetail[]): WorktreeLanding {
  const open = worktrees.flatMap((worktree) => worktree.landing.kind === "open" ? [worktree.landing] : [])
  const [first] = open
  if (first) return { kind: "open", into: first.into, commits: open.reduce((sum, landing) => sum + landing.commits, 0) }
  if (worktrees.some((worktree) => worktree.landing.kind === "unknown")) return { kind: "unknown" }
  return worktrees.find((worktree) => worktree.landing.kind === "merged")?.landing ?? { kind: "empty" }
}

/** The inventory's worktrees by the checkout each is part of, newest first. */
export function worktreeCheckouts(worktrees: readonly WorktreeDetail[]): CheckoutDetail[] {
  const byCheckout = new Map<string, WorktreeDetail[]>()
  for (const worktree of worktrees) {
    const path = worktreeCheckout(worktree)
    byCheckout.set(path, [...(byCheckout.get(path) ?? []), worktree])
  }
  return [...byCheckout].map(([path, members]): CheckoutDetail => {
    const sorted = [...members].sort((a, b) => a.repoRoot.localeCompare(b.repoRoot))
    const first = sorted[0]!
    const measured = sorted.filter((worktree) => worktree.bytes !== null)
    return {
      path,
      project: first.project,
      branch: first.branch,
      createdAt: Math.min(...sorted.map((worktree) => worktree.createdAt)),
      thread: sorted.find((worktree) => worktree.thread)?.thread ?? null,
      changes: sorted.reduce((sum, worktree) => sum + worktree.changes, 0),
      held: sorted.find((worktree) => worktree.held)?.held ?? null,
      landing: checkoutLanding(sorted),
      users: [...new Set(sorted.flatMap((worktree) => worktree.users))],
      bytes: measured.length ? measured.reduce((sum, worktree) => sum + (worktree.bytes ?? 0), 0) : null,
      worktrees: sorted,
    }
  }).sort((a, b) => b.createdAt - a.createdAt)
}

/** Nothing would be lost and nothing stopped: its work is on the main checkout's branch, or it never had any. */
export function removable(checkout: Pick<CheckoutDetail, "held" | "users" | "landing">): boolean {
  return !checkout.held && checkout.users.length === 0 && (checkout.landing.kind === "merged" || checkout.landing.kind === "empty")
}

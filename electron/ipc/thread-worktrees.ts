import { registerIpc } from "./register.js"
import type { ThreadWorktreeService } from "../thread-worktrees.js"
import type { GitDiff } from "../contracts/git-workspace-search.js"
import type { ThreadWorktrees, WorktreeBranch, WorktreeInventory, WorktreePull, WorktreeReview, WorktreeStartPoint } from "../contracts/thread-worktrees.js"

const UNAVAILABLE = "This Mako couldn't open its Thread store, so it can't keep worktrees."

/** This device's Thread worktrees, removing one that has nothing uncommitted, and keeping spares of a project ready. */
export function installThreadWorktreesIpc(worktrees: ThreadWorktreeService | null, pulls: (cwd: string) => Promise<WorktreePull[] | null>) {
  registerIpc("mako:worktree-branches", async (_event, cwd: string): Promise<WorktreeBranch[]> =>
    (await worktrees?.branches(cwd)) ?? [])
  registerIpc("mako:worktree-pulls", (_event, cwd: string): Promise<WorktreePull[] | null> => pulls(cwd))
  registerIpc("mako:worktree-skip", (_event, conversationId: string): void => {
    worktrees?.skip(conversationId)
  })
  registerIpc("mako:worktrees", (): Promise<ThreadWorktrees> | ThreadWorktrees =>
    worktrees ? worktrees.list() : { root: "", worktrees: [] })
  registerIpc("mako:worktree-inventory", (): Promise<WorktreeInventory> | WorktreeInventory =>
    worktrees ? worktrees.inventory() : { worktrees: [], spares: { count: 0, bytes: null } })
  registerIpc("mako:worktree-review", (_event, path: string): Promise<WorktreeReview> => {
    if (!worktrees) throw new Error(UNAVAILABLE)
    return worktrees.review(path)
  })
  registerIpc("mako:worktree-review-diffs", (_event, path: string): Promise<{ diffs: GitDiff[]; truncated: number }> => {
    if (!worktrees) throw new Error(UNAVAILABLE)
    return worktrees.reviewDiffs(path)
  })
  registerIpc("mako:worktree-merge", (_event, path: string): Promise<{ branch: string; into: string }> => {
    if (!worktrees) throw new Error(UNAVAILABLE)
    return worktrees.merge(path)
  })
  registerIpc("mako:worktree-ahead", async (_event, path: string): Promise<number | null> =>
    (await worktrees?.ahead(path)) ?? null)
  registerIpc("mako:worktree-start-point", async (_event, cwd: string, fetch: boolean): Promise<WorktreeStartPoint | null> =>
    (await worktrees?.startPoint(cwd, fetch)) ?? null)
  registerIpc("mako:worktree-want", async (_event, cwd: string): Promise<void> => {
    await worktrees?.want(cwd)
  })
  registerIpc("mako:worktree-remove", (_event, path: string): Promise<ThreadWorktrees> => {
    if (!worktrees) throw new Error(UNAVAILABLE)
    return worktrees.remove(path)
  })
}

import type { MethodTable } from "../host-methods.js"
import type { ThreadWorktreeService } from "../thread-worktrees.js"
import type { GitDiff } from "@mako/host/contracts/git-workspace-search"
import type { ThreadWorktrees, WorktreeBranch, WorktreeBranchPull, WorktreeInventory, WorktreePull, WorktreeReview, WorktreeStartPoint, WorktreeSummary, WorktreeRemoval, WorktreeUpdate } from "@mako/host/contracts/thread-worktrees"

interface PullLists {
  /** Open pull requests a new Thread can work on. */
  heads: (cwd: string) => Promise<WorktreePull[] | null>
  /** Recent pull requests in any state, to find each worktree branch's. */
  branches: (cwd: string) => Promise<WorktreeBranchPull[] | null>
}

const UNAVAILABLE = "This Mako couldn't open its Thread store, so it can't keep worktrees."

/** This device's Thread worktrees, removing one that has nothing uncommitted, and keeping spares of a project ready. */
export function installThreadWorktreesIpc(methods: MethodTable, worktrees: ThreadWorktreeService | null, pulls: PullLists) {
  methods.handle("mako:worktree-branches", async (cwd: string): Promise<WorktreeBranch[]> =>
    (await worktrees?.branches(cwd)) ?? [])
  methods.handle("mako:worktree-pulls", (cwd: string): Promise<WorktreePull[] | null> => pulls.heads(cwd))
  methods.handle("mako:worktree-summaries", async (): Promise<WorktreeSummary[]> =>
    (await worktrees?.summaries(pulls.branches)) ?? [])
  methods.handle("mako:worktree-skip", (conversationId: string): void => {
    worktrees?.skip(conversationId)
  })
  methods.handle("mako:worktrees", (): Promise<ThreadWorktrees> | ThreadWorktrees =>
    worktrees ? worktrees.list() : { root: "", worktrees: [] })
  methods.handle("mako:worktree-inventory", (): Promise<WorktreeInventory> | WorktreeInventory =>
    worktrees ? worktrees.inventory() : { worktrees: [], spares: { count: 0, bytes: null } })
  methods.handle("mako:worktree-review", (path: string): Promise<WorktreeReview> => {
    if (!worktrees) throw new Error(UNAVAILABLE)
    return worktrees.review(path)
  })
  methods.handle("mako:worktree-review-diffs", (path: string): Promise<{ diffs: GitDiff[]; truncated: number }> => {
    if (!worktrees) throw new Error(UNAVAILABLE)
    return worktrees.reviewDiffs(path)
  })
  methods.handle("mako:worktree-merge", (path: string): Promise<{ branch: string; into: string }> => {
    if (!worktrees) throw new Error(UNAVAILABLE)
    return worktrees.merge(path)
  })
  methods.handle("mako:worktree-update", (path: string): Promise<WorktreeUpdate> => {
    if (!worktrees) throw new Error(UNAVAILABLE)
    return worktrees.update(path)
  })
  methods.handle("mako:worktree-ahead", async (path: string): Promise<number | null> =>
    (await worktrees?.ahead(path)) ?? null)
  methods.handle("mako:worktree-start-point", async (cwd: string, fetch: boolean): Promise<WorktreeStartPoint | null> =>
    (await worktrees?.startPoint(cwd, fetch)) ?? null)
  methods.handle("mako:worktree-want", async (cwd: string): Promise<void> => {
    await worktrees?.want(cwd)
  })
  methods.handle("mako:worktree-removal", (path: string): Promise<WorktreeRemoval> => {
    if (!worktrees) throw new Error(UNAVAILABLE)
    return worktrees.removal(path)
  })
  methods.handle("mako:worktree-remove", (path: string): Promise<ThreadWorktrees> => {
    if (!worktrees) throw new Error(UNAVAILABLE)
    return worktrees.remove(path)
  })
}

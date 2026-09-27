import { registerIpc } from "./register.js"
import type { ThreadWorktreeService } from "../thread-worktrees.js"
import type { ThreadWorktrees } from "../contracts/thread-worktrees.js"

const UNAVAILABLE = "This Mako couldn't open its Thread store, so it can't keep worktrees."

/** This device's Thread worktrees, removing one that has nothing uncommitted, and keeping spares of a project ready. */
export function installThreadWorktreesIpc(worktrees: ThreadWorktreeService | null) {
  registerIpc("mako:worktrees", (): Promise<ThreadWorktrees> | ThreadWorktrees =>
    worktrees ? worktrees.list() : { root: "", worktrees: [] })
  registerIpc("mako:worktree-ahead", async (_event, path: string): Promise<number | null> =>
    (await worktrees?.ahead(path)) ?? null)
  registerIpc("mako:worktree-want", async (_event, cwd: string): Promise<void> => {
    await worktrees?.want(cwd)
  })
  registerIpc("mako:worktree-remove", (_event, path: string): Promise<ThreadWorktrees> => {
    if (!worktrees) throw new Error(UNAVAILABLE)
    return worktrees.remove(path)
  })
}

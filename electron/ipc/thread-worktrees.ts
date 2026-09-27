import { registerIpc } from "./register.js"
import type { ThreadWorktreeService } from "../thread-worktrees.js"
import type { ThreadWorktrees } from "../contracts/thread-worktrees.js"

const UNAVAILABLE = "This Mako couldn't open its Thread store, so it can't keep worktrees."

/** This device's Thread worktrees, and removing one that has nothing uncommitted. */
export function installThreadWorktreesIpc(worktrees: ThreadWorktreeService | null) {
  registerIpc("mako:worktrees", (): Promise<ThreadWorktrees> | ThreadWorktrees =>
    worktrees ? worktrees.list() : { root: "", worktrees: [] })
  registerIpc("mako:worktree-remove", (_event, path: string): Promise<ThreadWorktrees> => {
    if (!worktrees) throw new Error(UNAVAILABLE)
    return worktrees.remove(path)
  })
}

import { topic } from "./topic.js"

/**
 * A write Mako made to a checkout itself, reported once it's done: a Git
 * command it ran that changes files (a stash, a checkout, a merge), files
 * it carried into a worktree, or a file the person saved through Mako. Who
 * changed what (`attribution/`) never puts these on an agent: Mako's own
 * operations are Mako's, and an editor save is the person's.
 */
export interface WorkspaceWrite {
  kind: "editor" | "git" | "move" | "carry"
  /** In a few words, never file content: `git stash push`. */
  operation: string
  /** Absolute files or folders it may have written; a folder covers everything in it. */
  paths: string[]
  /** Epoch milliseconds. */
  startedAt: number
  endedAt: number
}

export const workspaceWrites = topic<WorkspaceWrite>("mako:workspace-writes")

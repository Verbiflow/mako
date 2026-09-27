import type { ThreadId } from "./thread-identity.js"

/** A worktree Mako made for a Thread on this device. */
export interface ThreadWorktree {
  /** The worktree's root folder. */
  path: string
  thread: ThreadId
  /** The main checkout the worktree was added to. */
  repoRoot: string
  /** The folder in the main checkout the Thread was started from. */
  project: string
  branch: string
  /** The commit the branch started at. */
  base: string
  createdAt: number
}

export interface ThreadWorktrees {
  /** Where Mako keeps worktrees; a Session whose folder is under it may be in one. */
  root: string
  worktrees: ThreadWorktree[]
}

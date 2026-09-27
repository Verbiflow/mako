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

/** Where a worktree's branch stands against the branch its main checkout has checked out. */
export type WorktreeLanding =
  /** Everything it committed is in `into`: merged, rebased or squashed. */
  | { kind: "merged"; into: string }
  /** It never committed anything. */
  | { kind: "empty" }
  | { kind: "open"; into: string; commits: number }
  /** The main checkout isn't on a branch, or Git couldn't tell. */
  | { kind: "unknown" }

export interface WorktreeDetail extends ThreadWorktree {
  /** Files with uncommitted changes, untracked ones included. */
  changes: number
  landing: WorktreeLanding
  /** What runs inside it: conversations and shells. */
  users: string[]
  /** Its own files; dependency folders cloned from the main checkout share their blocks and aren't counted. */
  bytes: number | null
}

export interface WorktreeInventory {
  worktrees: WorktreeDetail[]
  /** Checkouts kept ready for new Threads, and their own files' size. */
  spares: { count: number; bytes: number | null }
}

export const WORKTREE_BRANCH_PREFIX = "mako/"
const SLUG_WORDS = 4
const SLUG_LENGTH = 32
const FILLER = new Set(["a", "an", "the", "to", "of", "and", "in", "on", "for", "with", "please", "can", "could",
  "you", "i", "me", "my", "we", "our", "this", "that", "it", "is", "be", "let", "lets", "let's"])

/**
 * A branch-safe name from the Thread's first words: "Fix the login redirect"
 * becomes `fix-login-redirect`. Shared so the composer can show the branch a
 * send will make before it's sent.
 */
export function worktreeSlug(text: string | undefined): string {
  const words = (text ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((word) => word && !FILLER.has(word))
    .slice(0, SLUG_WORDS)
  return words.join("-").slice(0, SLUG_LENGTH).replace(/-+$/, "") || "thread"
}

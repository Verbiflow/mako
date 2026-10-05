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
  /** How its start went, when this device made it. */
  start?: WorktreeStartReceipt
}

export interface WorktreeStartReceipt {
  /** Where a new branch started (`main`, `origin/main`), or null on a branch that existed already. */
  from: string | null
  adopted: boolean
  tookMs: number
  /** Files the project's recipe copies from the main checkout. */
  copied: number
  /** Taken from a checkout made ahead of time. */
  spare: boolean
}

/** What the start of a Thread's worktree is doing, past the first moment. */
export type WorktreeStep = "checkout" | "carry"

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

export interface WorktreeDetail extends Omit<ThreadWorktree, "thread"> {
  /** Null for a worktree whose start failed or was cut short, so no Thread runs in it. */
  thread: ThreadId | null
  /** Files with uncommitted changes, untracked ones included. */
  changes: number
  /** Why removing it now would lose work, when it would. */
  held: string | null
  landing: WorktreeLanding
  /** What runs inside it: conversations and shells. */
  users: string[]
  /** Its own files; dependency folders cloned from the main checkout share their blocks and aren't counted. */
  bytes: number | null
}

/** A pull request whose head is a worktree's branch. */
export interface WorktreeBranchPull {
  number: number
  title: string
  url: string
  branch: string
  state: "open" | "draft" | "merged" | "closed"
  /** The commit GitHub has as its head. */
  head: string
  checks: "passed" | "failed" | "running" | null
}

/** How a worktree's branch stands, for the rail's mark and its tip. */
export interface WorktreeSummary {
  path: string
  /** The main checkout's branch, or null when it isn't on one. */
  into: string | null
  /** Commits on the branch that `into` doesn't have. */
  ahead: number
  /** Files with uncommitted changes, untracked ones included. */
  changes: number
  /** Merged also when its pull request merged with the branch's current tip as its head. */
  landing: WorktreeLanding
  pull: WorktreeBranchPull | null
  /** Commits on the branch new Threads start from that this branch lacks, by the last fetch. */
  behind: { from: string; commits: number } | null
}

/** What removing one worktree would meet: why it can't go now, if it can't, and where its branch stands. */
export interface WorktreeRemoval {
  held: string | null
  landing: WorktreeLanding
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

export interface WorktreeReviewFile {
  path: string
  /** Where a renamed file was at the base. */
  from?: string
  /** Null when not counted: a binary or very large file. */
  insertions: number | null
  deletions: number | null
}

/** Whether the branch can be merged into the main checkout's branch here, and if not, why. */
export type WorktreeMergeCheck = { ok: true; into: string } | { ok: false; reason: string }

/** A worktree's work since it branched: committed and uncommitted, against where it meets the main checkout's branch. */
export interface WorktreeReview {
  path: string
  branch: string
  /** The main checkout's branch, or null when it isn't on one. */
  into: string | null
  /** Where the branch meets `into`, or the commit it started at. */
  base: string
  commits: number
  files: WorktreeReviewFile[]
  merge: WorktreeMergeCheck
  /** Commits on the branch new Threads start from (`main`, or `origin/main` when only it moved) that this branch lacks. */
  behind: { from: string; commits: number } | null
}

/** What Update from main did: merged the commits, found nothing to bring, or stopped on conflicts and left the merge for them to be resolved. */
export type WorktreeUpdate =
  | { kind: "updated"; from: string; commits: number }
  | { kind: "current"; from: string }
  | { kind: "conflicts"; from: string; files: string[] }

/**
 * What a new Thread's worktree is made on, when the person chose: a new
 * branch from somewhere other than the start point, or a branch that exists
 * already, which the Thread works on and Mako never deletes.
 */
export type WorktreeStart =
  | { kind: "from"; ref: string }
  | { kind: "branch"; branch: string }
  /** `cross`: from a fork, so its branch isn't on this repository's remote. */
  | { kind: "pull"; number: number; branch: string; cross: boolean }

/** A branch a new Thread can start from or work on. */
export interface WorktreeBranch {
  /** `main`, or `origin/feature` for a branch only on a remote. */
  name: string
  remote: boolean
  /** Its last commit, in milliseconds. */
  at: number
  /** The checkout it is checked out in; Git keeps a branch in one at a time. */
  checkedOut: string | null
}

/** An open pull request a new Thread can work on. */
export interface WorktreePull {
  number: number
  title: string
  branch: string
  draft: boolean
  author: string | null
  updatedAt: string | null
  cross: boolean
}

/** The project folder's branch against its upstream. */
export type WorktreeStanding =
  | { kind: "level" }
  /** No upstream, or one never fetched. */
  | { kind: "alone" }
  /** On no branch. */
  | { kind: "detached" }
  | { kind: "behind"; behind: number }
  | { kind: "ahead"; ahead: number }
  | { kind: "diverged"; ahead: number; behind: number }

/**
 * Where a new Thread's branch starts: the project folder's branch, or its
 * upstream when that has commits the branch lacks and the branch has none
 * of its own to lose. A branch with unpushed commits keeps them.
 */
export interface WorktreeStartPoint {
  /** As a person reads it: `main`, `origin/main`, or a short commit. */
  from: string
  commit: string
  /** The project folder's branch, or null on no branch. */
  branch: string | null
  upstream: string | null
  standing: WorktreeStanding
  /** The last fetch of the upstream since Mako started, or null when none was tried. */
  fetched: { at: number; failed: string | null } | null
}

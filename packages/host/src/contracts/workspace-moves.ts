import { z } from "zod"

/** Changed files and lines of one kind; `paths` relative to the project folder, the first of them when there are many. */
export interface MoveShare {
  files: number
  /** Lines added plus lines removed; 0 when Mako couldn't count them. */
  lines: number
  paths: string[]
}

/**
 * How a checkout's uncommitted changes divide by whose they are, for one
 * Thread: each current line belongs to its last writer, and a created,
 * deleted, renamed or binary file to whoever last wrote it.
 */
export interface MoveShares {
  /** The Thread's own: these go with it. */
  thread: MoveShare
  /** Other Threads'. */
  others: MoveShare
  /** The person's own, and Mako's on their behalf. */
  person: MoveShare
  /** Lines that might be the Thread's: only its turn was running, or several Threads ran at once. */
  uncertain: MoveShare
  /** Changes nobody can be named for: there before Mako tracked the checkout. */
  unattributed: MoveShare
  /** Hunks that couldn't be split by line, given whole to whoever last wrote most of them. */
  split: { path: string; to: "thread" | "checkout" }[]
  /** Files with other Threads' or the person's changes, each counted once. */
  kept?: number
}

/** What moving a Thread's changes into its worktree did. */
export interface MoveOutcome {
  /** What came into the worktree. */
  came: MoveShare
  /** What stayed in the main checkout, by whose it is; `uncertain` and `unattributed` are empty once brought. */
  stayed: Omit<MoveShares, "thread" | "split">
  split: MoveShares["split"]
  /** The uncertain and unattributed changes came too. */
  brought: boolean
  /** Files that were staged in part, which the main checkout now has unstaged. */
  unstaged: string[]
  /** Where the main checkout's whole state before the move is kept, for 14 days: `refs/mako/moves/…` in each repository. */
  backup?: string
}

/**
 * An agent asked, through Mako's workspace tools, to go on on its Thread's
 * own branch. Asking waits for the user; allowed, the Session and the
 * Thread's other Sessions in the same checkout move once all their turns end.
 */
export interface WorkspaceMoveRequest {
  id: string
  conversationId: string
  harness: string
  title?: string
  /** The repository the move happens in, which "Always allow" remembers. */
  project: string
  /** The Thread's branch when another of its Sessions made one; the move joins it. */
  joins?: string
  /** Uncommitted files in the project folder that move with it. */
  changed: number
  /** How the project folder's changes divide, read when the agent asked; absent when Mako couldn't say. */
  shares?: MoveShares
  /** The person chose to bring the changes that might be the Thread's and those nobody can be named for. */
  bring?: boolean
  /** The Thread's other Sessions in the same checkout, which move with it. */
  companions?: number
  state: "asking" | "allowed"
  /** Once the turns ended, what an allowed move still waits for, such as background tasks. */
  waiting?: string
}

export interface WorkspaceMoves {
  requests: WorkspaceMoveRequest[]
  /** Repositories where an agent's move needs no answer. */
  alwaysAllowed: string[]
}

/**
 * The Thread the person may move from the composer: its Session on screen
 * when that one is live, else the Thread and the folder the viewer shows.
 */
export interface WorkspaceMoveTarget {
  thread: string
  cwd: string
  conversation?: string
}

/** What the person's move of a Thread meets now, said before it's chosen. */
export interface WorkspaceMoveHold {
  /** The Thread's other Sessions in this checkout, which the move brings along. */
  companions: { id: string; title?: string }[]
  /**
   * What keeps the move from going now, as in "“Helper” is running a turn";
   * a move chosen anyway waits for it briefly, then refuses.
   */
  held?: string
  /** Mako is moving this Thread onto its own branch already. */
  moving?: boolean
  /** How the project folder's changes divide for the Thread: what would come and what would stay. */
  shares?: MoveShares
}

export const WorkspaceMoveAnswerSchema = z.enum(["allow", "always", "deny"])
export type WorkspaceMoveAnswer = z.infer<typeof WorkspaceMoveAnswerSchema>

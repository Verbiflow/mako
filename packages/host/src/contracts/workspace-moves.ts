import { z } from "zod"

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
}

export const WorkspaceMoveAnswerSchema = z.enum(["allow", "always", "deny"])
export type WorkspaceMoveAnswer = z.infer<typeof WorkspaceMoveAnswerSchema>

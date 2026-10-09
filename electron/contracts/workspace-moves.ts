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
}

export interface WorkspaceMoves {
  requests: WorkspaceMoveRequest[]
  /** Repositories where an agent's move needs no answer. */
  alwaysAllowed: string[]
}

export const WorkspaceMoveAnswerSchema = z.enum(["allow", "always", "deny"])
export type WorkspaceMoveAnswer = z.infer<typeof WorkspaceMoveAnswerSchema>

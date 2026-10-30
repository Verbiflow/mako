import { createContext, useContext } from "react"
import { store } from "@/state/session"

/**
 * Where a comment written in a diff goes. The desk's own Changes puts it in
 * the composer on screen, its path relative to the window's folder. A
 * review of one Session's turn on another computer (the web app on a
 * laptop) names that Session: its composer alone takes the chip, and the
 * path is relative to that Session's folder.
 */
export interface CommentTarget {
  conversation: string
  cwd: string | undefined
}

export const CommentTargetContext = createContext<CommentTarget | null>(null)

/** Where a diff's comments go as its components read it: the conversation, if one, and the folder, read when asked. */
export interface CommentRoute {
  conversation: string | undefined
  cwd: () => string | undefined
}

/** The conversation a diff's comments are for, if one, and the folder their paths are relative to. */
export function useCommentTarget(): CommentRoute {
  const target = useContext(CommentTargetContext)
  return { conversation: target?.conversation, cwd: () => (target ? target.cwd : store.get().meta?.cwd) }
}

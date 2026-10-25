import { createContext, useContext } from "react"

export interface WorkspaceFocus {
  cwd?: string
  title?: string
  identity: string
  ready: boolean
  /** The cloud conversation whose folder `cwd` is, read on its machine. Two of one repository share a path, never this. */
  elsewhere?: string
  /**
   * The computer that has the folder is off, so the conversation reads from its copy in the account: nothing of its
   * folder is asked for, and its panels say so (the device's name) instead of waiting on it.
   */
  off?: string
}

export const WorkspaceFocusContext = createContext<WorkspaceFocus>({
  identity: "none",
  ready: true,
})

export function workspaceFocusOf({
  sessionCwd,
  sessionTitle,
  viewing,
  live,
  liveThreadPath,
  sessionElsewhere,
}: {
  sessionCwd?: string
  /** The cloud conversation the workspace's folder was opened for, if any. */
  sessionElsewhere?: string
  sessionTitle?: string
  viewing?: { path: string; cwd?: string; title?: string }
  live?: { id: string; cwd: string; title?: string; elsewhere?: boolean; off?: string }
  liveThreadPath?: string
}): WorkspaceFocus {
  const viewingOwnsFocus = Boolean(
    viewing && (!live || viewing.path !== liveThreadPath)
  )
  const cwd = viewingOwnsFocus ? viewing?.cwd : live?.cwd ?? sessionCwd
  const title = viewingOwnsFocus
    ? viewing?.title
    : live?.title ?? sessionTitle
  const identity = viewingOwnsFocus
    ? `thread:${viewing?.path}`
    : live
      ? `live:${live.id}`
      : `workspace:${sessionCwd ?? "none"}`
  const elsewhere = !viewingOwnsFocus && live?.elsewhere ? live.id : undefined
  const off = !viewingOwnsFocus ? live?.off : undefined
  // A folder on a computer that's off isn't opened: there's nothing to read it with until it's back.
  const focus: WorkspaceFocus = { cwd, title, identity, ready: Boolean(off) || !cwd || (cwd === sessionCwd && elsewhere === sessionElsewhere) }
  if (elsewhere) focus.elsewhere = elsewhere
  if (off) focus.off = off
  return focus
}

export function useWorkspaceFocus() {
  return useContext(WorkspaceFocusContext)
}

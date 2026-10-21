import { createContext, useContext } from "react"

export interface WorkspaceFocus {
  cwd?: string
  title?: string
  identity: string
  ready: boolean
  /** The cloud conversation whose folder `cwd` is, read on its machine. Two of one repository share a path, never this. */
  elsewhere?: string
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
  live?: { id: string; cwd: string; title?: string; elsewhere?: boolean }
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
  const focus: WorkspaceFocus = { cwd, title, identity, ready: !cwd || (cwd === sessionCwd && elsewhere === sessionElsewhere) }
  if (elsewhere) focus.elsewhere = elsewhere
  return focus
}

export function useWorkspaceFocus() {
  return useContext(WorkspaceFocusContext)
}

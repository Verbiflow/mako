import { useEffect, type ReactNode } from "react"
import {
  WorkspaceFocusContext,
  workspaceFocusOf,
} from "@/components/stage/workspace-focus-context"
import { activeAcp, useAcp } from "@/state/acp"
import { actions, useSession } from "@/state/session"
import { useThreads } from "@/state/threads"

export function WorkspaceFocusProvider({ children }: { children: ReactNode }) {
  const sessionCwd = useSession((state) => state.meta?.cwd)
  const sessionTitle = useSession((state) => state.meta?.sessionName)
  const sessionElsewhere = useSession((state) => state.elsewhere)
  const viewing = useThreads(
    (state) => state.opening?.ref ?? state.viewing?.ref
  )
  const liveId = useAcp((state) => activeAcp(state)?.key)
  const liveCwd = useAcp((state) => activeAcp(state)?.cwd)
  const liveTitle = useAcp((state) => activeAcp(state)?.title)
  const liveThreadPath = useAcp((state) => activeAcp(state)?.threadPath)
  const liveElsewhere = useAcp((state) => Boolean(activeAcp(state)?.elsewhere))
  const focus = workspaceFocusOf({
    sessionCwd,
    sessionTitle,
    viewing,
    live:
      liveId && liveCwd
        ? { id: liveId, cwd: liveCwd, title: liveTitle, elsewhere: liveElsewhere }
        : undefined,
    liveThreadPath,
    sessionElsewhere,
  })

  useEffect(() => {
    if (focus.cwd && !focus.ready) void actions.openWorkspace(focus.cwd, focus.elsewhere)
  }, [focus.cwd, focus.ready, focus.elsewhere])

  return (
    <WorkspaceFocusContext.Provider value={focus}>
      {children}
    </WorkspaceFocusContext.Provider>
  )
}

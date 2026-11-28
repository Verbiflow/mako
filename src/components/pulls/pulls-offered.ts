import { useMemo } from "react"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import { useBoardStore, useBoardWatch } from "@/state/project-board"

/** The project the panel lists: the folder in front, unless it's another computer's. */
export function usePanelFolders(): string[] {
  const { cwd, elsewhere, off } = useWorkspaceFocus()
  return useMemo(() => (cwd && !elsewhere && !off ? [cwd] : []), [cwd, elsewhere, off])
}

/** Offered when the project has a GitHub repository; asking is what tells, so the tab's glance reads here. */
export function usePullsOffered(): boolean {
  const folders = usePanelFolders()
  useBoardWatch(folders, "pulls", "glance")
  return useBoardStore((state) => folders.length > 0 && (state.projects[folders[0]!]?.length ?? 0) > 0)
}


import { useRef } from "react"
import { ChangesPanel } from "@/components/inspector/changes-panel"
import { WorkspaceFocusContext } from "@/components/stage/workspace-focus-context"
import { TooltipProvider } from "@/components/ui/tooltip"
import { FileViewer } from "@/components/viewer/file-viewer"
import { useSession } from "@/state/session"

/** The center workbench beside the Changes panel, as the desk lays them out. */
export function LineCommentsFixture() {
  const cwd = useSession((state) => state.meta?.cwd)
  const workspace = useRef<HTMLDivElement>(null)
  return (
    <TooltipProvider>
      <WorkspaceFocusContext.Provider value={{ cwd, ready: true, identity: `fixture:${cwd}` }}>
        <main className="flex h-screen bg-surface text-foreground">
          <FileViewer AgentSurface={Conversation} workspaceRef={workspace} className="min-w-0 flex-1 border-r border-hairline" />
          <aside data-changes className="flex w-[520px] min-w-0 shrink-0 flex-col"><ChangesPanel /></aside>
        </main>
      </WorkspaceFocusContext.Provider>
    </TooltipProvider>
  )
}

function Conversation() {
  return <div className="flex-1 p-4 text-ui text-faint">The conversation</div>
}

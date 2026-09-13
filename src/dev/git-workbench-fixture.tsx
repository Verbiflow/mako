import { ChangesPanel } from "@/components/inspector/changes-panel"
import { GitLog } from "@/components/inspector/git-log"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { WorkspaceFocusContext } from "@/components/stage/workspace-focus-context"
import { useSession } from "@/state/session"

export function GitWorkbenchFixture() {
  const path = useSession((state) => state.meta?.cwd)
  return <TooltipProvider><WorkspaceFocusContext.Provider value={{ cwd: path, ready: true, identity: `fixture:${path}` }}>
    <main className="flex h-screen bg-surface text-foreground">
      <section className="flex min-w-0 flex-1 flex-col border-r border-hairline"><header className="border-b border-hairline p-4 text-title">Project history</header><div data-history-panel className="min-h-0 flex-1 overflow-auto"><GitLog /></div></section>
      <aside className="flex w-[480px] min-w-0 shrink-0 flex-col"><ChangesPanel /></aside>
    </main>
    {/* The desk mounts its toasts top-right (App.tsx); a bottom-right default
        would cover the push row this fixture drives. */}
    <Toaster position="top-right" />
  </WorkspaceFocusContext.Provider></TooltipProvider>
}

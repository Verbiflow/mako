import { ChevronDownIcon, PlusIcon } from "lucide-react"
import { terminalGroupFor } from "@/lib/terminal-layout"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import { createHook } from "@/state/store"
import { stage } from "@/state/stage"
import { terminalActions, terminalStore } from "@/state/terminal"
import { TerminalOptions } from "./terminal-options"
import { dockTool } from "./dock-tab-style"
const useTerminal = createHook(terminalStore)

/** Three cells: a new shell, everything else, and hide. Find is ⌘F; maximize is a double-click on the strip. */
export function TerminalToolbar() {
  const { cwd } = useWorkspaceFocus()
  const phase = useTerminal((state) => state.phase)
  const creating = useTerminal((state) => state.creating)
  const activeId = useTerminal((state) => state.activeId)
  const groups = useTerminal((state) => state.groups)
  const canSplit =
    phase === "ready" &&
    !creating &&
    (terminalGroupFor(groups, activeId)?.sessionIds.length ?? 4) < 4
  return (
    <div
      role="toolbar"
      aria-label="Terminal actions"
      className="flex h-full shrink-0 items-stretch border-l border-hairline"
    >
      <button
        type="button"
        title="New terminal"
        aria-label="New terminal"
        disabled={!cwd || creating || phase !== "ready"}
        onClick={() => cwd && void terminalActions.create(cwd)}
        className={dockTool}
      >
        <PlusIcon />
      </button>
      <TerminalOptions canSplit={canSplit} canSearch={Boolean(activeId)} />
      <button
        type="button"
        aria-label="Hide terminal"
        title="Hide terminal (shells keep running)"
        onClick={() => stage.toggleDock("terminal")}
        className={dockTool}
      >
        <ChevronDownIcon />
      </button>
    </div>
  )
}

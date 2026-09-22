import {
  ChevronDownIcon,
  Maximize2Icon,
  Minimize2Icon,
  PlusIcon,
  SearchIcon,
  Columns2Icon,
} from "lucide-react"
import { terminalGroupFor } from "@/lib/terminal-layout"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import { createHook } from "@/state/store"
import { stage, useStage } from "@/state/stage"
import { useTabs } from "@/state/tabs"
import { terminalActions, terminalStore } from "@/state/terminal"
import { TerminalOptions } from "./terminal-options"
const useTerminal = createHook(terminalStore)

export function TerminalToolbar() {
  const { cwd } = useWorkspaceFocus()
  const tabId = useTabs((state) => state.activeId)
  const expanded = useStage(
    (state) => state.byTab[tabId]?.dockExpanded ?? false
  )
  const phase = useTerminal((state) => state.phase)
  const creating = useTerminal((state) => state.creating)
  const activeId = useTerminal((state) => state.activeId)
  const groups = useTerminal((state) => state.groups)
  const active = Boolean(activeId)
  const canSplit =
    phase === "ready" &&
    !creating &&
    (terminalGroupFor(groups, activeId)?.sessionIds.length ?? 4) < 4
  return (
    <div
      role="toolbar"
      aria-label="Terminal actions"
      className="flex h-7 shrink-0 items-center justify-end px-1"
    >
      {active ? (
        <button
          type="button"
          title="Search terminal"
          aria-label="Search terminal"
          onClick={() =>
            window.dispatchEvent(new CustomEvent("mako:terminal-search"))
          }
          className="pressable flex size-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-fill-hover hover:text-foreground"
        >
          <SearchIcon className="size-3.5" />
        </button>
      ) : null}
      <button
        type="button"
        title="New terminal"
        aria-label="New terminal"
        disabled={!cwd || creating || phase !== "ready"}
        onClick={() => cwd && void terminalActions.create(cwd)}
        className="pressable flex size-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-fill-hover hover:text-foreground disabled:opacity-40"
      >
        <PlusIcon className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label="Split terminal right"
        title="Split terminal right"
        disabled={!canSplit}
        onClick={() => void terminalActions.split("horizontal")}
        className="pressable flex size-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-fill-hover hover:text-foreground disabled:opacity-40"
      >
        <Columns2Icon className="size-3.5" />
      </button>
      <TerminalOptions canSplit={canSplit} />
      <button
        type="button"
        aria-label={expanded ? "Restore terminal size" : "Maximize terminal"}
        title={expanded ? "Restore terminal size" : "Maximize terminal"}
        onClick={() => stage.toggleDockExpanded()}
        className="pressable flex size-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-fill-hover hover:text-foreground"
      >
        {expanded ? (
          <Minimize2Icon className="size-3.5" />
        ) : (
          <Maximize2Icon className="size-3.5" />
        )}
      </button>
      <button
        type="button"
        aria-label="Hide terminal"
        title="Hide terminal (shells keep running)"
        onClick={() => stage.toggleDock("terminal")}
        className="pressable flex size-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-fill-hover hover:text-foreground"
      >
        <ChevronDownIcon className="size-4" />
      </button>
    </div>
  )
}

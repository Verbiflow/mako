import { useEffect, useState } from "react"
import { TerminalSquareIcon } from "lucide-react"
import { dockButton } from "./terminal/dock-tab-style"
import { Blank } from "@/components/ui/kit"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { terminalGroupFor } from "@/lib/terminal-layout"
import { TerminalGroup } from "./terminal/terminal-group"
import { TerminalToolbar } from "./terminal/terminal-toolbar"
import { usePrefs } from "@/state/prefs"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import { createHook } from "@/state/store"
import { stage } from "@/state/stage"
import { terminalActions, terminalStore } from "@/state/terminal"
import { TerminalTabs } from "./terminal/terminal-tabs"
import { AppOutputTabs, AppOutputView } from "./app-output"
import { outputsOf, useThreadApp } from "@/state/thread-app"

const useTerminal = createHook(terminalStore)

export function TerminalPanel() {
  const { cwd } = useWorkspaceFocus()
  const phase = useTerminal((state) => state.phase)
  const sessions = useTerminal((state) => state.sessions)
  const groups = useTerminal((state) => state.groups)
  const closingId = useTerminal((state) => state.closingId)
  const closeFault = useTerminal((state) =>
    state.closingId ? state.faults[state.closingId] : undefined
  )
  const activeId = useTerminal((state) => state.activeId)
  const fault = useTerminal((state) => state.fault)
  const titles = usePrefs((prefs) => prefs.terminalTitles)
  const appOutput = useThreadApp((state) => {
    const view = state.byCwd[cwd ?? ""]
    const key = state.shown?.cwd === cwd ? state.shown?.key : undefined
    if (!key || view?.kind !== "ready") return undefined
    // An output that ended (an install that finished) gives way to the app's first process.
    const outputs = outputsOf(view, key)
    return outputs.some((output) => output.key === key) ? key : outputs.find((output) => output.key.startsWith("process:"))?.key
  })
  const active = sessions.find((session) => session.id === activeId)
  const activeGroup = terminalGroupFor(groups, activeId)
  const workspaceGroups = groups.filter((group) =>
    sessions.some(
      (session) => session.id === group.sessionIds[0] && session.cwd === cwd
    )
  )
  const closing = sessions.find((session) => session.id === closingId)
  // Keep recent groups only while they fit the renderer budget. Visible splits
  // are never evicted; hidden shells continue in the daemon without a renderer.
  const [recentIds, setRecentIds] = useState<string[]>([])
  const retainedIds: string[] = []
  let retainedPanes = 0
  for (const id of new Set([activeGroup?.id, ...recentIds])) {
    const group = groups.find((entry) => entry.id === id)
    if (!group) continue
    if (retainedPanes && retainedPanes + group.sessionIds.length > 3) continue
    retainedIds.push(group.id)
    retainedPanes += group.sessionIds.length
  }
  if (activeGroup && recentIds[0] !== activeGroup.id) setRecentIds(retainedIds)
  useEffect(() => terminalActions.mount(), [])
  useEffect(() => {
    if (cwd) void terminalActions.ensureWorkspace(cwd)
  }, [cwd, phase])

  if (phase === "connecting" && sessions.length === 0) {
    return (
      <Blank
        icon={<TerminalSquareIcon />}
        title="Connecting to terminals"
        body="The local terminal service is starting. Existing shells will reattach automatically."
      />
    )
  }

  if (phase === "error" && sessions.length === 0) {
    return (
      <Blank
        icon={<TerminalSquareIcon />}
        title="Terminal unavailable"
        body={fault ?? "The local terminal service disconnected."}
        action={
          <Action
            label="Retry"
            onClick={() => void terminalActions.refresh()}
          />
        }
      />
    )
  }

  return (
    <div
      data-terminal-panel
      className="relative flex h-full min-h-0 min-w-0 flex-col bg-terminal"
    >
      <header
        onDoubleClick={(event) => {
          if (event.target === event.currentTarget) stage.toggleDockExpanded()
        }}
        className="relative flex h-9 shrink-0 items-stretch bg-shell shadow-[inset_0_-1px_0_var(--hairline)]"
      >
        <AppOutputTabs cwd={cwd} shown={appOutput} />
        <TerminalTabs
          groups={workspaceGroups}
          sessions={sessions}
          activeId={appOutput ? undefined : activeId}
          titles={titles}
        />
        <div
          aria-hidden
          className="h-full min-w-4 flex-1"
          onDoubleClick={() => stage.toggleDockExpanded()}
        />
        <TerminalToolbar />
      </header>

      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {appOutput && cwd ? <AppOutputView cwd={cwd} outputKey={appOutput} /> : null}
          {active ? (
            groups
              .filter((group) => retainedIds.includes(group.id))
              .map((group) => (
                <TerminalGroup
                  key={group.id}
                  group={group}
                  sessions={sessions}
                  visible={!appOutput && group.id === activeGroup?.id}
                  activeId={activeId}
                />
              ))
          ) : appOutput ? null : (
            <Blank
              icon={<TerminalSquareIcon />}
              title="No terminals"
              body="Start a shell in the current workspace. It will keep running if this window closes."
              action={
                cwd ? (
                  <Action
                    label="New terminal"
                    onClick={() => void terminalActions.create(cwd)}
                  />
                ) : undefined
              }
            />
          )}
        </div>
      </div>
      <Dialog
        open={Boolean(closing)}
        onOpenChange={(open) => {
          if (!open) terminalActions.cancelClose()
        }}
      >
        <DialogContent className="max-w-sm p-5">
          <DialogTitle>
            Close {closing ? (titles[closing.id] ?? closing.title) : "terminal"}
            ?
          </DialogTitle>
          <p className="mt-2 text-ui text-muted-foreground">
            This stops the shell and its running processes and removes its
            scrollback. Hide the terminal to keep them running.
          </p>
          {closeFault ? (
            <p role="alert" className="mt-2 text-label text-negative">
              {closeFault}
            </p>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              autoFocus
              onClick={() => terminalActions.cancelClose()}
              className="pressable rounded-md px-3 py-1.5 text-ui hover:bg-fill-hover"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => closing && void terminalActions.kill(closing.id)}
              className="pressable rounded-md bg-negative/15 px-3 py-1.5 text-ui text-negative hover:bg-negative/25"
            >
              Close terminal
            </button>
          </div>
        </DialogContent>
      </Dialog>
      {phase === "connecting" && active ? (
        <div
          role="status"
          className="flex h-8 shrink-0 items-center border-t border-hairline bg-shell px-3 text-ui text-muted-foreground"
        >
          Reconnecting to shell…
        </div>
      ) : null}
      {(fault || phase === "error") && active ? (
        <div className="dock-alert flex h-10 shrink-0 items-center gap-3 border-t border-hairline bg-shell pr-1.5 pl-3 text-ui">
          <span className="min-w-0 flex-1 truncate text-negative">
            {fault ?? "Terminal connection lost. Reconnecting…"}
          </span>
          <button
            type="button"
            onClick={() => void terminalActions.refresh()}
            className={dockButton("plain")}
          >
            Reconnect
          </button>
        </div>
      ) : null}
    </div>
  )
}

function Action({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="pressable mt-1 rounded-md bg-raised px-2.5 py-1.5 text-ui font-medium text-foreground hover:bg-foreground/15"
    >
      {label}
    </button>
  )
}

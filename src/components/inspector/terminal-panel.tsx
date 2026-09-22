import { useEffect, useState } from "react"
import { RefreshCwIcon, TerminalSquareIcon } from "lucide-react"
import { Blank } from "@/components/ui/kit"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { terminalGroupFor } from "@/lib/terminal-layout"
import { TerminalGroup } from "./terminal/terminal-group"
import { TerminalToolbar } from "./terminal/terminal-toolbar"
import { usePrefs } from "@/state/prefs"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import { createHook } from "@/state/store"
import { terminalActions, terminalStore } from "@/state/terminal"
import { SessionTab } from "./terminal/session-tab"

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
  const workspaceIds = workspaceGroups.flatMap((group) => group.sessionIds)
  const hasSidebar = workspaceIds.length > 1

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
      className="relative flex h-full min-h-0 min-w-0 flex-col bg-surface"
    >
      {!hasSidebar ? (
        <div className="absolute top-2 right-2 z-20 rounded-md border border-hairline bg-surface">
          <TerminalToolbar />
        </div>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {active ? (
            groups
              .filter((group) => retainedIds.includes(group.id))
              .map((group) => (
                <TerminalGroup
                  key={group.id}
                  group={group}
                  sessions={sessions}
                  visible={group.id === activeGroup?.id}
                  activeId={activeId}
                />
              ))
          ) : (
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
        {hasSidebar ? (
          <aside
            className="flex w-40 shrink-0 flex-col border-l border-hairline bg-shell/30"
            aria-label="Terminal sessions"
          >
            <TerminalToolbar />
            <div
              role="tablist"
              aria-label="Terminal sessions"
              aria-orientation="vertical"
              onKeyDown={(event) => {
                if (
                  !(event.target instanceof HTMLElement) ||
                  event.target.getAttribute("role") !== "tab"
                )
                  return
                const index = workspaceIds.indexOf(activeId ?? "")
                const next =
                  event.key === "ArrowDown"
                    ? (index + 1) % workspaceIds.length
                    : event.key === "ArrowUp"
                      ? (index - 1 + workspaceIds.length) % workspaceIds.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? workspaceIds.length - 1
                          : undefined
                if (next === undefined) return
                event.preventDefault()
                terminalActions.activate(workspaceIds[next])
                event.currentTarget
                  .querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  .item(next)
                  ?.focus()
              }}
              className="flex min-h-0 flex-col gap-0.5 overflow-y-auto p-1"
            >
              {workspaceGroups.map((group) => (
                <div key={group.id} className="flex flex-col gap-0.5">
                  {group.sessionIds.length > 1 ? (
                    <div className="px-1.5 pt-2 pb-1 text-label text-faint">
                      {group.orientation === "vertical"
                        ? "Stacked"
                        : "Side by side"}
                    </div>
                  ) : null}
                  {group.sessionIds.map((id) => {
                    const session = sessions.find((entry) => entry.id === id)!
                    return (
                      <SessionTab
                        key={id}
                        session={session}
                        title={titles[id] ?? session.title}
                        active={id === activeId}
                        onSelect={() => terminalActions.activate(id)}
                        onClose={() => terminalActions.requestClose(id)}
                      />
                    )
                  })}
                </div>
              ))}
            </div>
          </aside>
        ) : null}
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
          className="border-t border-hairline px-3 py-1 text-label text-muted-foreground"
        >
          Reconnecting to shell…
        </div>
      ) : null}
      {(fault || phase === "error") && active ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-negative/30 bg-negative/10 px-2.5 py-1.5 text-label text-negative">
          <span className="min-w-0 flex-1 truncate">
            {fault ?? "Terminal connection lost. Reconnecting…"}
          </span>
          <button
            type="button"
            onClick={() => void terminalActions.refresh()}
            className="pressable flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-negative/10"
          >
            <RefreshCwIcon className="size-3" />
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

import { Fragment } from "react"
import { Group, Panel, Separator } from "react-resizable-panels"
import type { TerminalGroup as GroupModel } from "@/lib/terminal-layout"
import type { TerminalSession } from "@/lib/types"
import { cn } from "@/lib/utils"
import { prefsStore, setPref, usePrefs } from "@/state/prefs"
import { terminalActions } from "@/state/terminal"
import { TerminalViewport } from "./terminal-viewport"

export function TerminalGroup({
  group,
  sessions,
  visible,
  activeId,
}: {
  group: GroupModel
  sessions: TerminalSession[]
  visible: boolean
  activeId?: string
}) {
  const sizes = usePrefs((prefs) => prefs.terminalPaneSizes)
  const paneIds = group.sessionIds.join(":")
  const restoreSizes = group.sessionIds.every((id) => sizes[id] > 0)
  const total = restoreSizes
    ? group.sessionIds.reduce((sum, id) => sum + sizes[id], 0)
    : group.sessionIds.length
  const defaultLayout = Object.fromEntries(
    group.sessionIds.map((id) => [
      id,
      (100 * (restoreSizes ? sizes[id] : 1)) / total,
    ])
  )
  const split = group.sessionIds.length > 1
  const panes = group.sessionIds.flatMap((id) => {
    const session = sessions.find((s) => s.id === id)
    return session ? [session] : []
  })
  return (
    <div className={cn("h-full min-h-0 min-w-0 flex-1", !visible && "hidden")}>
      <Group
        key={paneIds}
        defaultLayout={defaultLayout}
        orientation={group.orientation}
        className="h-full"
        onLayoutChanged={(layout) => {
          setPref("terminalPaneSizes", {
            ...prefsStore.get().terminalPaneSizes,
            ...layout,
          })
        }}
      >
        {panes.map((session, index) => (
          <Fragment key={session.id}>
            {index > 0 ? (
              <Separator
                aria-label="Resize terminal panes"
                className={cn(
                  "relative bg-hairline outline-none focus-visible:bg-foreground/40",
                  group.orientation === "horizontal" ? "w-px" : "h-px"
                )}
              />
            ) : null}
            <Panel id={session.id} minSize="15%">
              <div
                className="flex h-full min-h-0 min-w-0 flex-col"
                onFocusCapture={() => terminalActions.activate(session.id)}
                onPointerDownCapture={() =>
                  terminalActions.activate(session.id)
                }
              >
                <TerminalViewport
                  session={session}
                  active={visible}
                  focused={visible && session.id === activeId}
                  split={split}
                />
              </div>
            </Panel>
          </Fragment>
        ))}
      </Group>
    </div>
  )
}

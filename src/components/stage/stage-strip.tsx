import { IconAction } from "@/components/ui/kit"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { MakoMark } from "@/components/ui/mako-mark"
import { SessionTabList } from "@/components/stage/session-tabs"
import { useMemo } from "react"
import { useOnScreen, useThreadTabs, type OnScreen } from "@/state/thread-sessions"
import { closeWorkbenchPane } from "@/state/session-panes"
import { activeAcp, useAcp } from "@/state/acp"
import { usePrefs } from "@/state/prefs"
import { useSession } from "@/state/session"
import { useThreads } from "@/state/threads"
import { AGENT_TAB_ID, viewer, useViewer } from "@/state/viewer"
import { cn } from "@/lib/utils"
import { Columns2Icon, Rows2Icon, XIcon } from "lucide-react"

export function StageStrip({
  paneId,
  canClosePane,
}: {
  paneId: string
  canClosePane: boolean
}) {
  const pane = useViewer((state) =>
    state.panes.find((candidate) => candidate.id === paneId)
  )
  const documents = useViewer((state) => state.documents)
  const split = useViewer((state) => state.split)
  const hasSecondPane = useViewer((state) => state.panes.length === 2)
  const viewing = useThreads((state) => state.viewing?.ref)
  const liveHarness = useAcp((state) => activeAcp(state)?.harness)
  const liveTitle = useAcp((state) => activeAcp(state)?.title)
  const liveThreadPath = useAcp((state) => activeAcp(state)?.threadPath)
  const nativeTitle = useSession((state) => state.meta?.sessionName)
  const renamed = usePrefs((prefs) => {
    const path = viewing?.path ?? liveThreadPath
    return path ? prefs.titleOverrides[path] : undefined
  })
  const active = useOnScreen()
  const bound = pane?.session
  // A chat without focus shows its own Session, and so do its tabs.
  const here = useMemo<OnScreen>(
    () => (bound ? { thread: bound.thread, session: bound.tab } : active),
    [active, bound]
  )
  const sessionTabs = useThreadTabs(here)

  if (!pane) return null
  const canSplit = pane.activeId !== AGENT_TAB_ID
  const viewingOwnsAgent = Boolean(
    viewing && (!liveHarness || viewing.path !== liveThreadPath)
  )
  const agentHarness = viewingOwnsAgent ? viewing?.harness : liveHarness
  // The same session is named once, wherever it appears: a rename in the
  // rail follows it here, and a nameless one is "New thread" in both places.
  const agentTitle =
    renamed ??
    (viewingOwnsAgent ? viewing?.title : liveTitle) ??
    nativeTitle ??
    "New thread"

  return (
    <div className="flex h-10 shrink-0 items-center border-b border-hairline bg-shell">
      <div
        role="tablist"
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-2"
      >
        {pane.tabIds.map((id) => {
          const document = documents[id]
          const agent = id === AGENT_TAB_ID
          if (!agent && !document) return null
          const active = id === pane.activeId
          if (agent && sessionTabs.length > 0)
            return (
              <SessionTabList
                key={`${id}:${here.thread ?? ""}`}
                tabs={sessionTabs}
                here={here}
                paneId={pane.id}
                agentActive={active}
              />
            )
          const title = agent ? agentTitle : document.title
          const pinned = agent || document.pinned
          return (
            <div
              key={id}
              data-active={active || undefined}
              className={cn(
                "group relative flex h-7 w-56 min-w-16 max-w-56 shrink items-center gap-0.5 overflow-hidden rounded-md",
                active
                  ? "bg-raised text-foreground"
                  : "bg-shell text-faint hover:bg-fill-hover hover:text-muted-foreground"
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                data-tab-id={id}
                title={
                  agent
                    ? title
                    : pinned
                      ? document.path
                      : `${document.path} · preview, double-click to pin`
                }
                onMouseDown={(event) => {
                  if (event.button === 0 && event.detail > 0) {
                    viewer.activate(pane.id, id)
                  }
                }}
                onClick={(event) => {
                  if (event.detail === 0) viewer.activate(pane.id, id)
                }}
                onKeyDown={(event) => {
                  if (
                    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                      event.key
                    )
                  ) {
                    return
                  }
                  event.preventDefault()
                  const index = pane.tabIds.indexOf(id)
                  const next =
                    event.key === "Home"
                      ? pane.tabIds[0]
                      : event.key === "End"
                        ? pane.tabIds.at(-1)
                        : pane.tabIds[
                            (index +
                              (event.key === "ArrowRight" ? 1 : -1) +
                              pane.tabIds.length) %
                              pane.tabIds.length
                          ]
                  if (!next) return
                  viewer.activate(pane.id, next)
                  const list = event.currentTarget.closest('[role="tablist"]')
                  requestAnimationFrame(() => {
                    list
                      ?.querySelector<HTMLButtonElement>(
                        `[data-tab-id="${CSS.escape(next)}"]`
                      )
                      ?.focus()
                  })
                }}
                onAuxClick={(event) => {
                  if (!agent && event.button === 1) viewer.closeTab(pane.id, id)
                }}
                onDoubleClick={() => {
                  if (!agent) viewer.pin(id)
                }}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 truncate px-1.5 text-left text-ui font-medium"
              >
                {agent ? (
                  agentHarness ? (
                    <HarnessIcon harness={agentHarness} className="size-4" />
                  ) : (
                    <MakoMark className="size-4 text-foreground/75" />
                  )
                ) : null}
                <span className="truncate">{title}</span>
              </button>
              {!agent ? (
                <button
                  type="button"
                  aria-label={`Close ${title}`}
                  onClick={() => viewer.closeTab(pane.id, id)}
                  className={cn(
                    "pressable -ml-1 flex size-5 shrink-0 items-center justify-center rounded text-faint hover:bg-fill-hover hover:text-foreground",
                    active
                      ? "opacity-80"
                      : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-80"
                  )}
                >
                  <XIcon className="size-3" />
                </button>
              ) : null}
            </div>
          )
        })}
      </div>
      {!canClosePane ? (
        <div className="flex shrink-0 items-center gap-0.5 px-1">
          <IconAction
            label="Split right"
            size="xs"
            disabled={!canSplit}
            data-on={hasSecondPane && split === "right"}
            onClick={() => viewer.splitPane("right")}
          >
            <Columns2Icon />
          </IconAction>
          <IconAction
            label="Split down"
            size="xs"
            disabled={!canSplit}
            data-on={hasSecondPane && split === "down"}
            onClick={() => viewer.splitPane("down")}
          >
            <Rows2Icon />
          </IconAction>
        </div>
      ) : (
        <IconAction
          label="Close pane"
          size="xs"
          className="m-1"
          onClick={() => closeWorkbenchPane(pane.id)}
        >
          <XIcon />
        </IconAction>
      )}
    </div>
  )
}

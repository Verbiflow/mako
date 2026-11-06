import { memo, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { ArchiveIcon, Columns2Icon, PencilLineIcon, PlusIcon, Rows2Icon, ScrollTextIcon, XIcon } from "lucide-react"
import { ThreadMark } from "@/components/rail/thread-status"
import { IconAction } from "@/components/ui/kit"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger, MenuItem, MenuSeparator } from "@/components/ui/menu"
import { formatChord } from "@/extend/commands"
import { presenceThreadStatus } from "@/lib/presence-status"
import type { ThreadRef } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  closeDraftTab,
  closeThreadTab,
  newThreadHere,
  onScreenTab,
  sessionTabTitle,
  tabThread,
  type OnScreen,
  type SessionTab,
} from "@/state/thread-sessions"
import { archiveSessionTab } from "@/state/session-archive"
import { openInPane, openTabInPane } from "@/state/session-panes"
import { pressTab } from "@/state/tab-drag"
import { sameThreadStatus, threadStatus, useThreads, type ThreadStatus } from "@/state/threads"
import { useThreadTitles } from "@/state/thread-titles"
import { AGENT_TAB_ID, viewer } from "@/state/viewer"
import { useWindowRoutes } from "@/state/window-routes"

/** A tab that mounts this long after its Thread's strip did joined while you watched. */
const ARRIVAL_MS = 32

/** Only news belongs on a tab: running, waiting on background work, blocked, failed, or an answer you have not read. */
function shownStatus(status: ThreadStatus, onScreen: boolean): ThreadStatus | null {
  if (status.kind === "working" || status.kind === "background" || status.kind === "external-active" || status.kind === "needs-permission" || status.kind === "failed")
    return status
  return status.kind === "review" && status.unread && !onScreen ? status : null
}

const IDLE: ThreadStatus = { kind: "idle" }

const NativeTabMark = memo(function NativeTabMark({ threadRef, harness, onScreen }: { threadRef: ThreadRef; harness: string; onScreen: boolean }) {
  const status = useThreads((state) => threadStatus(threadRef, state), sameThreadStatus)
  return <ThreadMark status={shownStatus(status, onScreen) ?? IDLE} harness={harness} lit={onScreen} cut={onScreen ? "var(--raised)" : "var(--shell)"} />
})

/** A tab's one mark: its agent's glyph with its news round it, as its rail row wears it. */
function TabMark({ tab, harness, onScreen }: { tab: SessionTab; harness: string; onScreen: boolean }) {
  if (tab.kind !== "draft" && tab.ref) return <NativeTabMark threadRef={tab.ref} harness={harness} onScreen={onScreen} />
  const shown = tab.kind !== "draft" && tab.presence ? shownStatus(presenceThreadStatus(tab.presence), onScreen) : null
  return <ThreadMark status={shown ?? IDLE} harness={harness} lit={onScreen} cut={onScreen ? "var(--raised)" : "var(--shell)"} />
}

function moveFocus(event: KeyboardEvent<HTMLButtonElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
  event.preventDefault()
  const list = event.currentTarget.closest('[role="tablist"]')
  const tabs = [...(list?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])]
  const index = tabs.indexOf(event.currentTarget)
  const next =
    event.key === "Home"
      ? tabs[0]
      : event.key === "End"
        ? tabs.at(-1)
        : tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length]
  next?.focus()
  next?.click()
}

/** A Thread tab's own actions. */
function ThreadTabMenu({ tab, thread, title, children }: {
  tab: Extract<SessionTab, { kind: "session" }>
  thread: string
  title: string
  children: ReactNode
}) {
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-52">
        <MenuItem data-session-action="open-transcript" onSelect={() => { void viewer.openTranscript({ live: tab.presence?.key, path: tab.ref?.path ?? tab.presence?.threadPath }, title) }}>
          <ScrollTextIcon className="size-3.5" />Open transcript
        </MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={() => { openInPane(tab, thread, "right") }}>
          <Columns2Icon className="size-3.5" />Open to the right
        </MenuItem>
        <MenuItem onSelect={() => { openInPane(tab, thread, "down") }}>
          <Rows2Icon className="size-3.5" />Open below
        </MenuItem>
        <MenuSeparator />
        <MenuItem data-session-action="close-tab" onSelect={() => { closeThreadTab(tab) }}>
          <XIcon className="size-3.5" />Close tab
        </MenuItem>
        <MenuItem onSelect={() => { void archiveSessionTab(tab) }}>
          <ArchiveIcon className="size-3.5" />Archive thread
        </MenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function ThreadTabButton({
  tab,
  paneId,
  selected,
  stripSince,
  menu,
}: {
  tab: SessionTab
  paneId: string
  selected: boolean
  stripSince: number
  /** Its own menu: opening it in another pane, its transcript, archiving it. */
  menu: boolean
}) {
  const [arrived] = useState(() => performance.now() - stripSince > ARRIVAL_MS)
  const composerHarness = useThreads((state) => state.composerHarness)
  const thread = tabThread(tab)
  // A Thread's name comes from the host a beat after its tab.
  useThreadTitles((state) => (thread ? state.byThread[thread]?.title : undefined))
  const title = sessionTabTitle(tab)
  const harness =
    tab.kind === "draft"
      ? selected ? composerHarness : tab.draft.harness
      : (tab.presence?.harness ?? tab.ref?.harness)
  const open = () => openTabInPane(paneId, thread, tab)
  const close = () => {
    if (tab.kind === "draft") closeDraftTab(tab.draft)
    else closeThreadTab(tab)
  }
  // Past what fits the strip scrolls, and the tab on screen stays in view.
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (selected) box.current?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [selected])
  const body = (
    <div
      ref={box}
      data-active={selected || undefined}
      data-new={arrived || undefined}
      onAuxClick={(event) => {
        if (event.button === 1) close()
      }}
      className={cn(
        "session-tab group @container/tab relative flex h-7 w-56 min-w-28 max-w-56 shrink items-center overflow-hidden",
        selected
          ? "bg-raised text-foreground"
          : "bg-shell text-faint hover:bg-fill-hover hover:text-muted-foreground"
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        tabIndex={selected ? 0 : -1}
        data-tab-id={selected ? AGENT_TAB_ID : undefined}
        data-session-tab={tab.id}
        title={tab.kind === "draft" ? `New thread here${selected ? "" : ", not sent yet"}` : title}
        onPointerDown={(event) => {
          if (thread && menu) pressTab(event, { tab, thread, title }, event.currentTarget)
        }}
        onMouseDown={(event) => {
          if (event.button === 0 && event.detail > 0) open()
        }}
        onClick={(event) => {
          if (event.detail === 0) open()
        }}
        onKeyDown={moveFocus}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 truncate px-1.5 text-left text-ui font-medium"
      >
        {harness ? (
          <TabMark tab={tab} harness={harness} onScreen={selected} />
        ) : (
          <PencilLineIcon aria-hidden className="size-3.5" />
        )}
        <span className="truncate">{title}</span>
      </button>
      <span className="flex shrink-0 items-center gap-0.5 pr-1">
        <button
          type="button"
          aria-label={tab.kind === "draft" ? "Close new thread" : `Close ${title}`}
          title={tab.kind === "draft" ? "Close. Unsent text is kept for the next new tab." : "Close this tab. The thread stays in the sidebar."}
          onClick={close}
          className={cn(
            "pressable -mr-0.5 flex size-5 shrink-0 items-center justify-center text-faint hover:bg-fill-hover hover:text-foreground",
            selected
              ? "opacity-80"
              : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-80 group-focus-within:pointer-events-auto group-focus-within:opacity-80"
          )}
        >
          <XIcon className="size-3" />
        </button>
      </span>
    </div>
  )
  return tab.kind === "session" && thread && menu ? (
    <ThreadTabMenu tab={tab} thread={thread} title={title}>{body}</ThreadTabMenu>
  ) : body
}

/**
 * The agent slot of the workbench strip: what's open across Threads, then `+`. A tab that joins while you watch slides
 * in from the `+` side.
 */
export function ThreadTabList({
  tabs,
  here,
  paneId,
  agentActive,
  add = true,
}: {
  tabs: readonly SessionTab[]
  here: OnScreen
  paneId: string
  agentActive: boolean
  /** A pane without focus shows its one conversation, with no `+` of its own. */
  add?: boolean
}) {
  const [since] = useState(() => performance.now())
  const current = onScreenTab(here)
  // A window that routes has no host of its own to archive through, nor panes to open one in.
  const routed = useWindowRoutes((state) => state.routes !== null)
  return (
    <>
      {tabs.map((tab) => (
        <ThreadTabButton
          key={tab.id}
          tab={tab}
          paneId={paneId}
          selected={agentActive && tab.id === current}
          stripSince={since}
          menu={!routed}
        />
      ))}
      {add ? <AddThreadButton /> : null}
    </>
  )
}

/** The strip's `+`: a new Thread beside the one on screen, reachable however far the tabs scroll. */
function AddThreadButton() {
  return (
    <IconAction label="New thread here" keys={formatChord("mod+t")} size="xs" data-add-session="new" className="sticky right-0 z-[1] shrink-0 bg-shell" onClick={() => { newThreadHere() }}>
      <PlusIcon />
    </IconAction>
  )
}

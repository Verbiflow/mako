import { memo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { ArchiveIcon, Columns2Icon, ListPlusIcon, PencilLineIcon, PlusIcon, Rows2Icon, SplitIcon, XIcon } from "lucide-react"
import { ThreadStatusMark } from "@/components/rail/thread-status"
import { IconAction, Keys } from "@/components/ui/kit"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { formatChord } from "@/extend/commands"
import { presenceThreadStatus } from "@/lib/thread-fold"
import type { ThreadRef } from "@/lib/types"
import { cn } from "@/lib/utils"
import { usePrefs } from "@/state/prefs"
import {
  closeDraftTab,
  newSessionInThread,
  onScreenTab,
  sessionTabTitle,
  type OnScreen,
  type SessionTab,
} from "@/state/thread-sessions"
import { archiveSessionTab, openAddSessionHere, openAddToThread, splitIntoNewThread } from "@/state/thread-regroup"
import { openInPane, openTabInPane } from "@/state/session-panes"
import { pressTab } from "@/state/tab-drag"
import { sameThreadStatus, threadStatus, useThreads, type ThreadStatus } from "@/state/threads"
import { AGENT_TAB_ID } from "@/state/viewer"

/** A tab that mounts this long after its Thread's strip did joined while you watched. */
const ARRIVAL_MS = 32

/** Only news belongs on a tab: running, blocked, failed, or an answer you have not read. */
function shownStatus(status: ThreadStatus, onScreen: boolean): ThreadStatus | null {
  if (status.kind === "working" || status.kind === "external-active" || status.kind === "needs-permission" || status.kind === "failed")
    return status
  return status.kind === "review" && status.unread && !onScreen ? status : null
}

const NativeTabStatus = memo(function NativeTabStatus({ threadRef, onScreen }: { threadRef: ThreadRef; onScreen: boolean }) {
  const status = useThreads((state) => threadStatus(threadRef, state), sameThreadStatus)
  const shown = shownStatus(status, onScreen)
  return shown ? <ThreadStatusMark status={shown} /> : null
})

function TabStatus({ tab, onScreen }: { tab: SessionTab; onScreen: boolean }) {
  if (tab.kind === "draft") return null
  if (tab.ref) return <NativeTabStatus threadRef={tab.ref} onScreen={onScreen} />
  const shown = tab.presence ? shownStatus(presenceThreadStatus(tab.presence), onScreen) : null
  return shown ? <ThreadStatusMark status={shown} /> : null
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

/**
 * A Session tab's own actions. They act on this Session alone; the rail
 * row's menu acts on the whole Thread.
 */
function SessionTabMenu({ tab, thread, title, alone, children }: {
  tab: Extract<SessionTab, { kind: "session" }>
  thread: string
  title: string
  alone: boolean
  children: ReactNode
}) {
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-52">
        <MenuItem onSelect={() => openAddToThread({ sessions: [tab.id], from: thread, title, cwd: tab.ref?.cwd ?? tab.presence?.cwd })}>
          <ListPlusIcon className="size-3.5" />Add to thread…
        </MenuItem>
        <MenuItem disabled={alone} onSelect={() => { void splitIntoNewThread([tab.id]) }}>
          <SplitIcon className="size-3.5" />Split into new thread
        </MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={() => { openInPane(tab, thread, "right") }}>
          <Columns2Icon className="size-3.5" />Open to the right
        </MenuItem>
        <MenuItem onSelect={() => { openInPane(tab, thread, "down") }}>
          <Rows2Icon className="size-3.5" />Open below
        </MenuItem>
        <MenuSeparator />
        <MenuItem disabled={alone} onSelect={() => { void archiveSessionTab(tab, thread) }}>
          <ArchiveIcon className="size-3.5" />Archive session
        </MenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function SessionTabButton({
  tab,
  thread,
  paneId,
  selected,
  stripSince,
  closable,
}: {
  tab: SessionTab
  thread?: string
  paneId: string
  selected: boolean
  stripSince: number
  /** False while this is the Thread's only Session: archiving it is archiving the Thread, from its row. */
  closable: boolean
}) {
  const [arrived] = useState(() => performance.now() - stripSince > ARRIVAL_MS)
  const overrides = usePrefs((prefs) => prefs.titleOverrides)
  const composerHarness = useThreads((state) => state.composerHarness)
  const title = tab.kind === "draft" && !selected ? "Draft" : sessionTabTitle(tab, overrides)
  const harness =
    tab.kind === "draft"
      ? selected ? composerHarness : tab.draft.harness
      : (tab.presence?.harness ?? tab.ref?.harness)
  const open = () => openTabInPane(paneId, thread, tab)
  const close = tab.kind === "draft" || closable
    ? () => {
        if (tab.kind === "draft") closeDraftTab(tab.draft)
        else if (thread) void archiveSessionTab(tab, thread)
      }
    : undefined
  const body = (
    <div
      data-active={selected || undefined}
      data-new={arrived || undefined}
      onAuxClick={(event) => {
        if (event.button === 1) close?.()
      }}
      className={cn(
        "session-tab group relative flex h-7 w-56 min-w-16 max-w-56 shrink items-center overflow-hidden rounded-md",
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
        title={tab.kind === "draft" ? `New session in this Thread${selected ? "" : ", not sent yet"}` : title}
        onPointerDown={(event) => {
          if (thread) pressTab(event, { tab, thread, title }, event.currentTarget)
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
          <HarnessIcon harness={harness} className="size-4" />
        ) : (
          <PencilLineIcon aria-hidden className="size-3.5" />
        )}
        <span className="truncate">{title}</span>
      </button>
      <span className="flex shrink-0 items-center gap-0.5 pr-1">
        <TabStatus tab={tab} onScreen={selected} />
        {close ? (
          <button
            type="button"
            aria-label={tab.kind === "draft" ? "Close new tab" : `Archive ${title}`}
            title={tab.kind === "draft" ? "Close. Unsent text is kept for the next new tab." : "Archive this session. Restore it from Archived."}
            onClick={close}
            className={cn(
              "pressable -mr-0.5 flex size-5 shrink-0 items-center justify-center rounded text-faint hover:bg-fill-hover hover:text-foreground",
              selected
                ? "opacity-80"
                : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-80 group-focus-within:pointer-events-auto group-focus-within:opacity-80"
            )}
          >
            <XIcon className="size-3" />
          </button>
        ) : null}
      </span>
    </div>
  )
  return tab.kind === "session" && thread ? (
    <SessionTabMenu tab={tab} thread={thread} title={title} alone={!closable}>{body}</SessionTabMenu>
  ) : body
}

/**
 * The agent slot of the workbench strip for a Thread: one tab per Session,
 * the new tab last, then `+`. A tab that joins while you watch slides in
 * from the `+` side. Mount one list per Thread, so switching Threads paints
 * the strip still.
 */
export function SessionTabList({
  tabs,
  here,
  paneId,
  agentActive,
}: {
  tabs: readonly SessionTab[]
  here: OnScreen
  paneId: string
  agentActive: boolean
}) {
  const [since] = useState(() => performance.now())
  const current = onScreenTab(here)
  const closable = tabs.filter((tab) => tab.kind === "session").length > 1
  return (
    <>
      {tabs.map((tab) => (
        <SessionTabButton
          key={tab.id}
          tab={tab}
          thread={here.thread}
          paneId={paneId}
          selected={agentActive && tab.id === current}
          stripSince={since}
          closable={closable}
        />
      ))}
      <AddSessionMenu />
    </>
  )
}

/** The strip's `+`: a new Session in this Thread, or one that exists already, moved here. */
function AddSessionMenu() {
  const picked = useRef(false)
  const choose = (run: () => void) => () => {
    picked.current = true
    run()
  }
  return (
    <Menu modal={false}>
      <MenuTrigger asChild>
        <IconAction label="Add a session to this Thread" size="xs" className="shrink-0 data-[state=open]:bg-fill-selected data-[state=open]:text-foreground">
          <PlusIcon />
        </IconAction>
      </MenuTrigger>
      <MenuContent
        align="start"
        className="min-w-56"
        onCloseAutoFocus={(event) => {
          if (picked.current) event.preventDefault()
          picked.current = false
        }}
      >
        <MenuItem data-add-session="new" onSelect={choose(() => { newSessionInThread() })}>
          <PlusIcon className="size-3.5" />
          <span className="flex-1">New session</span>
          <Keys keys={formatChord("mod+t")} />
        </MenuItem>
        <MenuItem data-add-session="existing" onSelect={choose(() => { openAddSessionHere() })}>
          <ListPlusIcon className="size-3.5" />
          <span className="flex-1">Add existing session…</span>
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

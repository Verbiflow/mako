import { memo, useState, type KeyboardEvent } from "react"
import { PencilLineIcon, PlusIcon } from "lucide-react"
import { ThreadStatusMark } from "@/components/rail/thread-status"
import { IconAction } from "@/components/ui/kit"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { formatChord } from "@/extend/commands"
import { presenceThreadStatus } from "@/lib/thread-fold"
import type { ThreadRef } from "@/lib/types"
import { cn } from "@/lib/utils"
import { usePrefs } from "@/state/prefs"
import {
  newSessionInThread,
  onScreenTab,
  openSessionTab,
  sessionTabTitle,
  type OnScreen,
  type SessionTab,
} from "@/state/thread-sessions"
import { sameThreadStatus, threadStatus, useThreads, type ThreadStatus } from "@/state/threads"
import { AGENT_TAB_ID, viewer } from "@/state/viewer"

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

function SessionTabButton({
  tab,
  paneId,
  selected,
  stripSince,
}: {
  tab: SessionTab
  paneId: string
  selected: boolean
  stripSince: number
}) {
  const [arrived] = useState(() => performance.now() - stripSince > ARRIVAL_MS)
  const overrides = usePrefs((prefs) => prefs.titleOverrides)
  const composerHarness = useThreads((state) => state.composerHarness)
  const title = tab.kind === "draft" && !selected ? "Draft" : sessionTabTitle(tab, overrides)
  const harness =
    tab.kind === "draft"
      ? selected ? composerHarness : tab.draft.harness
      : (tab.presence?.harness ?? tab.ref?.harness)
  const open = () => {
    viewer.activate(paneId, AGENT_TAB_ID)
    openSessionTab(tab)
  }
  return (
    <div
      data-active={selected || undefined}
      data-new={arrived || undefined}
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
      <span className="flex shrink-0 items-center pr-1">
        <TabStatus tab={tab} onScreen={selected} />
      </span>
    </div>
  )
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
  return (
    <>
      {tabs.map((tab) => (
        <SessionTabButton
          key={tab.id}
          tab={tab}
          paneId={paneId}
          selected={agentActive && tab.id === current}
          stripSince={since}
        />
      ))}
      <NewSessionButton />
    </>
  )
}

export function NewSessionButton() {
  return (
    <IconAction
      label="New session in this Thread"
      keys={formatChord("mod+t")}
      size="xs"
      className="shrink-0"
      onClick={() => {
        newSessionInThread()
      }}
    >
      <PlusIcon />
    </IconAction>
  )
}

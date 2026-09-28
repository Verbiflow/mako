import { useEffect, useRef, useState } from "react"
import { XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { prefsStore, setPref } from "@/state/prefs"
import type { TerminalSession } from "@/lib/types"
import { dockTab } from "./dock-tab-style"

export function SessionTab({
  session,
  title,
  ordinal,
  shown,
  active,
  onSelect,
  onClose,
}: {
  session: TerminalSession
  title: string
  /** Set when an earlier tab has the same title. */
  ordinal?: number
  /** Its pane is on screen: the tab is focused, or shares the visible split. */
  shown: boolean
  active: boolean
  onSelect: () => void
  onClose: () => void
}) {
  const tabRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (active)
      tabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [active])
  const cancelled = useRef(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const save = () => {
    if (cancelled.current) return
    const next = draft.trim()
    const titles = { ...prefsStore.get().terminalTitles }
    if (next && next !== session.title) titles[session.id] = next
    else delete titles[session.id]
    setPref("terminalTitles", titles)
    setEditing(false)
  }
  const failed = session.status === "exited" && Boolean(session.exitCode)
  return (
    <div
      data-dock-tab
      className={cn(
        dockTab(shown, active),
        "max-w-56 min-w-20 pr-1",
        session.status === "interrupted"
          ? "text-caution hover:text-caution"
          : failed
            ? "text-negative hover:text-negative"
            : session.status === "exited" && "text-faint"
      )}
    >
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === "Enter") save()
            if (event.key === "Escape") {
              cancelled.current = true
              setEditing(false)
            }
          }}
          onBlur={save}
          aria-label="Terminal name"
          className="-ml-1.5 h-7 min-w-0 flex-1 bg-raised px-1.5 text-ui text-foreground shadow-[inset_0_0_0_1px_var(--border)] focus:outline-none"
        />
      ) : (
        <button
          type="button"
          ref={tabRef}
          role="tab"
          aria-selected={active}
          tabIndex={active ? 0 : -1}
          title={`${title} · ${session.cwd} · Double-click to rename`}
          onClick={onSelect}
          onDoubleClick={(event) => {
            event.stopPropagation()
            cancelled.current = false
            setDraft(title)
            setEditing(true)
          }}
          className="h-full min-w-0 flex-1 truncate text-left"
        >
          {title}
          {ordinal ? (
            <span className="ml-1 text-faint tabular-nums">{ordinal}</span>
          ) : null}
        </button>
      )}
      <button
        type="button"
        aria-label={`Close ${title}`}
        onClick={onClose}
        className={cn(
          "pressable flex size-6 shrink-0 items-center justify-center text-faint transition-[opacity,background-color,color] duration-150 group-hover:opacity-100 hover:bg-fill-selected hover:text-foreground focus-visible:opacity-100",
          !active && "opacity-0"
        )}
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  )
}

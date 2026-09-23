import { useEffect, useRef, useState } from "react"
import { TerminalIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { prefsStore, setPref } from "@/state/prefs"
import type { TerminalSession } from "@/lib/types"

export function SessionTab({
  session,
  title,
  ordinal,
  active,
  onSelect,
  onClose,
}: {
  session: TerminalSession
  title: string
  /** Set when an earlier tab has the same title. */
  ordinal?: number
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
      className={cn(
        "group flex h-6 max-w-48 min-w-16 shrink-0 items-center gap-1.5 rounded-md pr-0.5 pl-2 text-label",
        active
          ? "bg-raised text-foreground"
          : "text-faint hover:bg-fill-hover hover:text-muted-foreground"
      )}
    >
      <TerminalIcon
        className={cn(
          "size-3.5 shrink-0",
          session.status === "interrupted"
            ? "text-caution"
            : failed
              ? "text-negative"
              : session.status === "exited"
                ? "text-faint/60"
                : active
                  ? "text-muted-foreground"
                  : "text-faint"
        )}
      />
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
          className="h-5 min-w-0 flex-1 rounded bg-background/40 px-1 text-label text-foreground focus:outline-none"
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
          "pressable flex size-5 shrink-0 items-center justify-center rounded text-faint group-hover:opacity-100 hover:bg-fill-hover hover:text-foreground focus:opacity-100",
          !active && "opacity-0"
        )}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  )
}

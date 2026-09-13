import { memo, useCallback, useState } from "react"
import { ArchiveIcon, PinIcon, XIcon } from "lucide-react"
import { harnessLabel } from "@/components/rail/harness-meta"
import { ThreadStatusMark } from "@/components/rail/thread-status"
import { ThreadActions } from "@/components/rail/thread-actions"
import { archivedThread, nativeThreadTarget, useThreadArchives } from "@/state/thread-lifecycle"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { workspaceName } from "@/lib/format"
import { threadFolderKey } from "@/lib/thread-folders"
import type { ThreadRef } from "@/lib/types"
import { cn } from "@/lib/utils"
import { prefsStore, setPref, togglePinned, usePrefs } from "@/state/prefs"
import { actions, shallowEqual, useSession } from "@/state/session"
import { useTabs, type TabInfo } from "@/state/tabs"
import { acpForThread, activeAcp, useAcp } from "@/state/acp"
import { sameThreadStatus, threadStatus, threads, useThreads } from "@/state/threads"

/**
 * The mark a session wears while it is attached — running in a background
 * tab of this window. The old tab strip carried these; the rail does now.
 * A leaf with its own narrow selector: a background tab's progress repaints
 * one dot, never the list. Detach appears on hover; the row itself keeps
 * meaning "bring this forward".
 */
const Attached = memo(function Attached({ path }: { path: string }) {
  const tab = useTabs(
    useCallback(
      (state: { tabs: TabInfo[]; activeId: string }) => {
        const found = state.tabs.find((entry) => entry.sessionFile === path)
        if (!found) return null
        return {
          id: found.id,
          working: found.working,
          unread: found.unread,
          active: found.id === state.activeId,
          only: state.tabs.length < 2,
        }
      },
      [path]
    ),
    shallowEqual
  )
  if (!tab) return null
  return (
    <>
      {tab.working ? (
        <span
          aria-label="Working"
          className="animate-live size-1.5 shrink-0 rounded-full bg-ember"
        />
      ) : tab.unread && !tab.active ? (
        <span aria-label="Finished while you were away" className="review-dot" />
      ) : null}
    </>
  )
})

/** The detach control for an attached background tab; lives in the row's hover pill. */
const Detach = memo(function Detach({ path }: { path: string }) {
  const tab = useTabs(
    useCallback(
      (state: { tabs: TabInfo[]; activeId: string }) => {
        const found = state.tabs.find((entry) => entry.sessionFile === path)
        return found && state.tabs.length > 1 ? found.id : null
      },
      [path]
    )
  )
  if (!tab) return null
  return (
    <button
      type="button"
      aria-label="Detach"
      title="Detach — stop holding this session open in the background"
      onClick={(event) => {
        event.stopPropagation()
        void actions.closeTab(tab)
      }}
      className="pressable flex size-6 items-center justify-center rounded text-faint hover:bg-fill-hover hover:text-foreground"
    >
      <XIcon className="size-3" />
    </button>
  )
})

export const ThreadRow = memo(function ThreadRow({
  threadRef: ref,
  indent,
  showFolder,
}: {
  threadRef: ThreadRef
  indent?: boolean
  showFolder?: boolean
}) {
  const override = usePrefs((prefs) => prefs.titleOverrides[ref.path])
  const [editing, setEditing] = useState<string | null>(null)
  // A thread whose CLI is being driven from here right now wears a pulse —
  // the same promise a tab's dot makes: something is working behind this row.
  const status = useThreads((state) => threadStatus(ref, state), sameThreadStatus)
  const archived = useThreadArchives((state) => archivedThread(ref, state.keys))
  const target = nativeThreadTarget(ref)
  const working = status.kind === "working"
  const activeElsewhere = status.kind === "external-active"
  const isPinned = usePrefs((prefs) => prefs.pinnedThreads.includes(ref.path))
  const active = useSession((state) => state.meta?.sessionFile === ref.path)
  const selectedPath = useThreads(
    (state) => state.opening?.ref.path ?? state.viewing?.ref.path
  )
  const livePath = useAcp((state) => activeAcp(state)?.threadPath)
  const liveProvider = useAcp((state) => acpForThread(state, ref)?.harness)
  const selectedLive = useAcp((state) =>
    Boolean(
      state.activeKey && acpForThread(state, ref)?.key === state.activeKey
    )
  )

  const open = () => {
    void threads.view(ref)
  }

  // One selection at a time: while a thread is open in the viewer, IT is
  // the selection — the native tab keeps its state but not its highlight,
  // because two lit rows read as a broken click.
  const focusedPath = selectedPath ?? livePath
  const lit = selectedPath
    ? selectedPath === ref.path
    : selectedLive || (focusedPath ? focusedPath === ref.path : active)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        open()
      }}
      onAuxClick={(event) => {
        if (event.button === 1) open()
      }}
      // The row's full text, shown by the rail's own tip (`rail-tip.tsx`),
      // never a native `title`: on macOS those arrive late or not at all.
      data-tip={[
        override ?? ref.title ?? "Untitled session",
        ref.archived
          ? "Archived: the native store lost this; Mako kept it. Reply to bring it back to life."
          : undefined,
        [
          ...(ref.lineage ?? []).map((origin) => harnessLabel(origin.harness)),
          harnessLabel(ref.harness),
        ].join(" → "),
        ref.model,
        ref.cwd,
        "Double-click the title to rename",
      ]
        .filter(Boolean)
        .join("\n")}
      data-active={lit || undefined}
      data-thread-row
      data-flip-key={ref.path}
      data-conversation-id={target.kind === "live" ? target.id : undefined}
      data-thread-indent={indent || undefined}
      className={cn(
        "group relative flex h-8 w-full items-center gap-2 rounded-md pr-1.5 text-left",
        indent ? "pl-[26px]" : "pl-1.5",
        "transition-colors duration-100 hover:bg-fill-hover data-active:bg-raised"
      )}
    >
      {/* Where this conversation has lived: earlier harnesses dimmed and
          tucked behind, the current one in front. One mark when it has
          only ever been one place — which is most sessions. */}
      <span className="flex shrink-0 items-center -space-x-1">
        {(ref.lineage ?? []).slice(-1).map((origin, index) => (
          <HarnessIcon
            key={`${origin.harness}-${index}`}
            harness={origin.harness}
            className="size-3 opacity-40"
          />
        ))}
        <HarnessIcon
          harness={liveProvider ?? ref.harness}
          className={cn(
            "size-3",
            (working || activeElsewhere) && "animate-live"
          )}
        />
      </span>
      {editing !== null ? (
        <input
          autoFocus
          value={editing}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setEditing(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === "Enter") {
              const next = editing.trim()
              const all = { ...prefsStore.get().titleOverrides }
              if (next && next !== ref.title) all[ref.path] = next
              else delete all[ref.path]
              setPref("titleOverrides", all)
              setEditing(null)
            }
            if (event.key === "Escape") setEditing(null)
          }}
          onBlur={() => setEditing(null)}
          className="min-w-0 flex-1 rounded bg-raised px-1 text-ui text-foreground ring-1 ring-hairline focus:outline-none"
        />
      ) : (
        <span
          onDoubleClick={(event) => {
            event.stopPropagation()
            setEditing(override ?? ref.title ?? "")
          }}
          className={cn(
            "min-w-0 flex-[1_1_60%] truncate text-ui",
            lit ? "font-medium text-foreground" : "text-foreground/85"
          )}
        >
          {override ?? ref.title ?? "Untitled session"}
        </span>
      )}
      {showFolder && ref.cwd ? (
        <span className="min-w-10 max-w-[6rem] shrink truncate text-label text-faint/70">
          {threadFolderKey(ref) ? workspaceName(ref.cwd) : "tmp"}
        </span>
      ) : null}
      {isPinned ? (
        <PinIcon className="size-3 shrink-0 fill-current text-foreground/60" aria-label="Pinned" />
      ) : null}
      <Attached path={ref.path} />
      {ref.archived ? (
        <ArchiveIcon
          className="size-3 shrink-0 text-faint/70"
          aria-label="Saved copy: the native session is gone; Mako kept the conversation"
        />
      ) : null}
      <ThreadStatusMark status={status} updatedAt={ref.updatedAt} />
      {/* Hover pill: the row's controls, laid over the meta on hover or focus so
          a row never reserves width for buttons nobody can see. It also stays
          while a menu inside it is open: the menu is portaled, so focus leaves
          the row, and a hidden trigger has no box to anchor the menu to.
          Over the controls the row's tip stands down for their own labels. */}
      <span
        data-tip-quiet
        className="absolute top-1/2 right-7 hidden -translate-y-1/2 items-center gap-0.5 rounded-md bg-raised p-0.5 group-hover:flex group-focus-within:flex group-focus-visible:flex has-[[data-state=open]]:flex"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          aria-label={isPinned ? "Unpin" : "Pin"}
          onClick={(event) => {
            event.stopPropagation()
            togglePinned(ref.path)
          }}
          className="pressable flex size-6 items-center justify-center rounded text-faint hover:bg-fill-hover hover:text-foreground"
        >
          <PinIcon className={cn("size-3", isPinned && "fill-current")} />
        </button>
        <ThreadActions target={target} title={override ?? ref.title ?? "Untitled session"} archived={archived} running={working || activeElsewhere || status.kind === "needs-permission"} controlled={target.kind === "live" || working} />
        <Detach path={ref.path} />
      </span>
    </div>
  )
})

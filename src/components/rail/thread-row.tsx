import { memo, useCallback, useRef, useState } from "react"
import { ArchiveIcon, FolderGit2Icon, PinIcon, XIcon } from "lucide-react"
import { harnessLabel } from "@/components/rail/harness-meta"
import { ThreadStatusMark } from "@/components/rail/thread-status"
import { ThreadActions } from "@/components/rail/thread-actions"
import { archivedThread, nativeThreadTarget, useThreadArchives, type ThreadTarget } from "@/state/thread-lifecycle"
import { FoldGlyph } from "@/components/rail/fold-glyph"
import { FOLD_GLYPHS, foldedThreadStatus, foldRowHarness, type FoldedThread, type FoldRow } from "@/lib/thread-fold"
import { rowThread, useThreadGroups } from "@/state/thread-groups"
import { openFoldedThread } from "@/state/thread-sessions"
import { onScreenSession } from "@/state/session-panes"
import { pressTab } from "@/state/tab-drag"
import { useWorktrees, worktreeAt } from "@/state/worktrees"
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

/** Where a row's controls float while its mark asks for you, so hovering the row doesn't cover it. */
export const ROW_ACTIONS_BESIDE_MARK = "right-6"

/** A row's floating controls, shown while the row (`group`) is hovered or focused, or a menu of theirs is open. */
export const ROW_ACTIONS =
  "pointer-events-none absolute inset-y-0 right-0 flex items-center rounded-r-md pl-4 pr-1 opacity-0 transition-opacity duration-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100"

/** How many Sessions a folded row stands for. */
export function SessionCount({ count }: { count: number }) {
  return (
    <span
      aria-label={`${count} sessions`}
      className="tabular flex h-4 min-w-4 shrink-0 items-center justify-center rounded bg-fill-selected px-1 text-label leading-none text-muted-foreground"
    >
      {count}
    </span>
  )
}

function foldRowTarget(row: FoldRow): ThreadTarget {
  return row.kind === "native" ? nativeThreadTarget(row.ref) : { kind: "live", id: row.key }
}

export const ThreadRow = memo(function ThreadRow({
  threadRef: ref,
  folded,
  indent,
  showFolder,
}: {
  threadRef: ThreadRef
  /** Set when this row stands for a Thread with several Sessions. */
  folded?: FoldedThread
  indent?: boolean
  showFolder?: boolean
}) {
  const override = usePrefs((prefs) => prefs.titleOverrides[ref.path])
  const [editing, setEditing] = useState<string | null>(null)
  const [since] = useState(() => performance.now())
  // A thread whose CLI is being driven from here right now wears a pulse —
  // the same promise a tab's dot makes: something is working behind this row.
  const status = useThreads(
    (state) => (folded ? foldedThreadStatus(folded.members, (member) => threadStatus(member, state)) : threadStatus(ref, state)),
    sameThreadStatus
  )
  const archived = useThreadArchives((state) => archivedThread(ref, state.keys))
  const target = nativeThreadTarget(ref)
  const foldedLive = useAcp((state) =>
    Boolean(
      folded &&
        state.activeKey &&
        folded.members.some((member) =>
          member.kind === "live" ? member.presence.key === state.activeKey : acpForThread(state, member.ref)?.key === state.activeKey
        )
    )
  )
  const thread = useThreadGroups((state) => folded?.thread ?? rowThread(ref, state.threadOf))
  const draftOpen = useThreadGroups((state) => state.open !== null && state.open === thread)
  const working = status.kind === "working"
  const activeElsewhere = status.kind === "external-active"
  const isPinned = usePrefs((prefs) => prefs.pinnedThreads.includes(ref.path))
  const branch = useWorktrees((state) => worktreeAt(state.worktrees, ref.cwd)?.worktree.branch)
  const project = useWorktrees((state) => {
    const found = worktreeAt(state.worktrees, ref.cwd)
    return found && `${found.worktree.repoRoot}${found.inside}`
  })
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
    if (folded) openFoldedThread(folded.thread, folded.members)
    else void threads.view(ref)
  }
  // Opening on press, not release, lights the row a click's length sooner.
  const openedOnPress = useRef(false)

  // One selection at a time: while a thread is open in the viewer, IT is
  // the selection — the native tab keeps its state but not its highlight,
  // because two lit rows read as a broken click. A folded row is lit by
  // any of its Sessions, and by its new tab.
  const focusedPath = selectedPath ?? livePath
  const lit = draftOpen || (folded
    ? selectedPath
      ? folded.members.some((member) => member.kind === "native" && member.ref.path === selectedPath)
      : foldedLive
    : selectedPath
      ? selectedPath === ref.path
      : selectedLive || (focusedPath ? focusedPath === ref.path : active))
  const title = override ?? ref.title ?? "Untitled session"

  return (
    <div
      role="button"
      tabIndex={0}
      onPointerDown={(event) => {
        openedOnPress.current = false
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        if (event.target instanceof Element && event.target.closest("input, [data-tip-quiet]")) return
        const shown = onScreenSession()
        openedOnPress.current = true
        open()
        // Dragged into the chat, the row opens beside what was there.
        if (thread) pressTab(event, { thread, title, shown }, event.currentTarget)
      }}
      onClick={() => {
        if (openedOnPress.current) openedOnPress.current = false
        else open()
      }}
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
        title,
        folded
          ? `${folded.members.length} sessions: ${folded.members.map((member) => harnessLabel(foldRowHarness(member))).join(", ")}`
          : undefined,
        ref.archived
          ? "Archived: the native store lost this; Mako kept it. Reply to bring it back to life."
          : undefined,
        [
          ...(ref.lineage ?? []).map((origin) => harnessLabel(origin.harness)),
          harnessLabel(ref.harness),
        ].join(" → "),
        ref.model,
        ref.cwd,
        branch ? `Worktree on ${branch}` : undefined,
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
        "group relative flex h-7 w-full items-center gap-2 rounded-md pr-1 text-left",
        indent ? "pl-2" : "pl-1.5",
        "transition-colors duration-100 hover:bg-fill-hover data-active:bg-raised data-active:hover:bg-raised"
      )}
    >
      {/* Where this conversation has lived: earlier harnesses dimmed and
          tucked behind, the current one in front. One mark when it has
          only ever been one place — which is most sessions. A Thread with
          several Sessions shows the agent of each, first Session first. */}
      <span className="flex shrink-0 items-center -space-x-1">
        {[
          ...(folded ? [] : (ref.lineage ?? []).slice(-1).map((origin, index) => (
            <HarnessIcon
              key={`lineage:${origin.harness}-${index}`}
              harness={origin.harness}
              className="size-3 opacity-40"
            />
          ))),
          ...(folded?.members.slice(0, FOLD_GLYPHS) ?? [null]).map((member) => (
            <FoldGlyph
              key={member?.key ?? ref.path}
              harness={member && member.key !== ref.path ? foldRowHarness(member) : (liveProvider ?? ref.harness)}
              live={working || activeElsewhere}
              rowSince={since}
            />
          )),
        ]}
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
          {title}
        </span>
      )}
      {folded ? <SessionCount count={folded.members.length} /> : null}
      {/* The branch itself is in the tip and on the chat's strip; the row
          spends its width on the title. */}
      {branch ? (
        <FolderGit2Icon data-thread-worktree={branch} className="size-3 shrink-0 text-faint/80" aria-label={`In a worktree on ${branch}`} />
      ) : null}
      {showFolder && ref.cwd ? (
        <span className="min-w-10 max-w-[6rem] shrink truncate text-label text-faint/70">
          {threadFolderKey(ref) ? workspaceName(project ?? ref.cwd) : "tmp"}
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
      {/* The row's controls float over its trailing edge on hover or focus
          (`.rail-row-actions`), so the title keeps its width. They also stay
          while a menu inside is open: the menu is portaled, so focus leaves
          the row. Over the controls the row's tip stands down for their own
          labels. */}
      <span
        data-tip-quiet
        className={cn("rail-row-actions", ROW_ACTIONS, (status.kind === "needs-permission" || status.kind === "failed") && ROW_ACTIONS_BESIDE_MARK)}
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
        <ThreadActions
          target={target}
          title={title}
          archived={archived}
          running={working || activeElsewhere || status.kind === "needs-permission"}
          // A folded row's status may be another Session's run; its stop lives in that tab.
          controlled={!folded && (target.kind === "live" || working)}
          path={ref.path}
          thread={thread}
          session={ref.sessionId}
          cwd={ref.cwd}
          archiveTargets={folded?.members.map(foldRowTarget)}
        />
        <Detach path={ref.path} />
      </span>
      <ThreadStatusMark status={status} updatedAt={ref.updatedAt} />
    </div>
  )
})

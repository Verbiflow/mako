import { useHarnessIdentity } from "@/lib/harness-label"
import { clearPicked, offerPick, pickByClick, useRailSelection } from "@/state/rail-selection"
import { railThreadRowKeys } from "@/components/rail/rail-keys"
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ChevronRightIcon, XIcon } from "lucide-react"
import { harnessLabel } from "@/components/rail/harness-meta"
import { appMarkLabel, purposeWords, titleTone } from "@/lib/rail-marks"
import { ThreadMark } from "@/components/rail/thread-status"
import { ArchiveButton, ThreadActions, ThreadContextMenu, type ThreadMenuProps } from "@/components/rail/thread-actions"
import { ApexAvatar } from "@/components/rail/rail-avatars"
import { JumpCap, WorkGlyph } from "@/components/rail/work-status"
import { WORK_STATUS_WORDS, type WorkStatus } from "@mako/host/contracts/thread-marks"
import { useThreadMarks } from "@/state/thread-marks"
import { archivedThread, nativeThreadTarget, useThreadArchives, type ThreadTarget } from "@/state/thread-lifecycle"
import { useApexFins, useIsApex } from "@/state/fin-pips"
import { ApexAsks } from "@/components/rail/apex-asks"
import {
  foldedThreadState,
  foldRowHarness,
  sameFoldedThreadState,
  sessionStateText,
  type FoldedThread,
  type FoldRow,
} from "@/lib/thread-fold"
import { threadStatusLabel } from "@/lib/live-mark-state"
import { rowThread, useThreadGroups } from "@/state/thread-groups"
import { useThreadPurposes } from "@/state/thread-purposes"
import { renameThreadTitle, useThreadTitles } from "@/state/thread-titles"
import { openFoldedThread } from "@/state/thread-sessions"
import { onScreenSession } from "@/state/session-panes"
import { pressTab } from "@/state/tab-drag"
import { followCheckouts } from "@/state/checkout-heads"
import { appMarkOf, useThreadApp } from "@/state/thread-app"
import { useLeavingWorktrees, useWorktrees, useWorktreeSummaries, workingFolder, worktreeAt } from "@/state/worktrees"
import { worktreeTip } from "@/lib/worktree-marks"
import { threadReferenceId, threadToken } from "@/lib/mentions"
import { formatRelative, workspaceName } from "@/lib/format"
import { threadFolderKey } from "@/lib/thread-folders"
import { checkoutOf, projectFolder } from "@mako/host/contracts/worktree-paths"
import type { ThreadRef } from "@/lib/types"
import { cn } from "@/lib/utils"
import { toggleApexOpen, togglePinned, usePrefs } from "@/state/prefs"
import { actions, useSession } from "@/state/session"
import { useTabs, type TabInfo } from "@/state/tabs"
import { acpForThread, activeAcp } from "@/state/acp"
import { useRailAcp } from "@/state/acp-state"
import { keptSessionText } from "@/lib/kept-session"
import { sameThreadStatus, threadStatus, threads, useThreads, type ThreadStatus } from "@/state/threads"
import { threadLiveKey } from "@/state/thread-status"

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
      className="pressable flex size-6 items-center justify-center text-faint hover:bg-fill-hover hover:text-foreground"
    >
      <XIcon className="size-3" />
    </button>
  )
})

/**
 * A rail row's box and paint: hover, an open menu, and the one lit row (`data-active`). At rest a row is its fin, its
 * title and its time; under the pointer (`rail-calm`) the trailing slot gives way to the row's actions.
 */
export const ROW_SURFACE =
  "rail-calm group relative isolate flex h-7 w-full items-center gap-2 pr-1 pl-2 text-left transition-colors duration-100 hover:bg-fill-hover data-[state=open]:bg-fill-hover data-active:bg-raised data-active:hover:bg-raised data-picked:bg-fill-selected data-picked:hover:bg-fill-selected"

/**
 * A row's floating controls, shown while the row (`group`) is hovered or focused, or a menu of theirs is open.
 * `z-[1]` keeps them over the row's status mark, whose translucent parts paint as their own layers. Focus inside the
 * row is an arbitrary variant, not `group-has-[…]`: that compiles to `:is(.group:has(…) *)`, and with a universal last
 * part any element added anywhere restyles the whole of `main`, a frame lost for each transcript row that mounts.
 */
export const ROW_ACTIONS =
  "pointer-events-none absolute inset-y-0 right-0 z-[1] flex items-center pl-4 pr-1 opacity-0 transition-opacity duration-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-visible:pointer-events-auto group-focus-visible:opacity-100 [.group:has(:focus-visible)_&]:pointer-events-auto [.group:has(:focus-visible)_&]:opacity-100 has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100"

/**
 * A row's one trailing slot at rest: a ring while an Apex's Fins work, the status the person set, then how long ago
 * the row moved, or "Failed" in its place (faint: the fin already lists over). Hover gives the slot to the row's
 * actions; ⌘ held, to its jump key.
 */
export function RowEnd({ status, updatedAt, finsWorking, work, children }: { status: ThreadStatus; updatedAt?: string; finsWorking?: boolean; work?: WorkStatus | null; children?: ReactNode }) {
  return (
    <span data-row-end className="flex min-w-7 shrink-0 items-center justify-end gap-1.5">
      {finsWorking ? <span data-fins-working className="rail-spin" aria-hidden /> : null}
      {work ? <WorkGlyph status={work} /> : null}
      {status.kind === "failed" ? (
        <span data-status-end="failed" className="text-label text-faint">Failed</span>
      ) : (children ?? (updatedAt ? <span className="tabular text-label text-faint">{formatRelative(updatedAt)}</span> : null))}
      <JumpCap />
    </span>
  )
}

/** An Apex's leading mark: its avatar, which turns into the fold's chevron under the pointer or focus. */
export function ApexFold({ thread, open }: { thread: string; open: boolean }) {
  return (
    <span className="relative flex size-[18px] shrink-0 items-center justify-center">
      <ApexAvatar seed={thread} className="transition-opacity duration-100 group-hover:opacity-0 [.group:has(:focus-visible)_&]:opacity-0" />
      <button
        type="button"
        aria-label={open ? "Fold its Fins" : "Show all its Fins"}
        aria-expanded={open}
        data-apex-fold
        data-tip-quiet
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          toggleApexOpen(thread)
        }}
        className="absolute inset-0 flex items-center justify-center text-faint opacity-0 transition-opacity duration-100 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 [.group:has(:focus-visible)_&]:opacity-100"
      >
        <ChevronRightIcon className={cn("size-3.5 transition-transform duration-200 ease-out", open && "rotate-90")} />
      </button>
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
  useHarnessIdentity()
  const override = usePrefs((prefs) => prefs.titleOverrides[ref.path])
  const [editing, setEditing] = useState<string | null>(null)
  // A thread whose CLI is being driven from here right now wears a pulse —
  // the same promise a tab's dot makes: something is working behind this row.
  // Its status also reads the live store; this repaints the row when those facts move, so it never stays stale.
  useRailAcp((state) => threadLiveKey(state, ref))
  const ownStatus = useThreads((state) => threadStatus(ref, state), sameThreadStatus)
  const foldState = useThreads(
    (state) => (folded ? foldedThreadState(folded.members, (member) => threadStatus(member, state)) : null),
    sameFoldedThreadState
  )
  const status = foldState?.status ?? ownStatus
  const archived = useThreadArchives((state) => archivedThread(ref, state.keys))
  const target = nativeThreadTarget(ref)
  const foldedLive = useRailAcp((state) =>
    Boolean(
      folded &&
        state.activeKey &&
        folded.members.some((member) =>
          member.kind === "live" ? member.presence.key === state.activeKey : acpForThread(state, member.ref)?.key === state.activeKey
        )
    )
  )
  const thread = useThreadGroups((state) => folded?.thread ?? rowThread(ref, state.threadOf))
  const named = useThreadTitles((state) => (thread ? state.byThread[thread]?.title : undefined))
  const purpose = useThreadPurposes((state) => (thread ? state.byThread[thread] : undefined))
  const setup = purpose?.kind === "setup"
  const draftOpen = useThreadGroups((state) => state.open !== null && state.open === thread)
  const apex = useIsApex(thread)
  const fins = useApexFins(thread, apex)
  const work = useThreadMarks((state) => (thread ? state.byThread[thread]?.status : undefined)) ?? null
  const markedUnread = useThreadMarks((state) => (thread ? state.byThread[thread]?.unreadAt != null : false))
  const working = status.kind === "working"
  const activeElsewhere = status.kind === "external-active"
  const isPinned = usePrefs((prefs) => prefs.pinnedThreads.includes(ref.path))
  // The rail follows project folders; a row in a worktree, or moved by its harness, follows its own for the branch.
  const ownCheckouts = [...(ref.worktrees ?? []).filter((worktree) => !worktree.mirrors).map((worktree) => worktree.path), ref.currentCwd ?? ""].filter(Boolean).join("\n")
  useEffect(() => {
    if (ownCheckouts) followCheckouts(ownCheckouts.split("\n"))
  }, [ownCheckouts])
  const found = useWorktrees((state) => worktreeAt(state.worktrees, workingFolder(state, ref))?.worktree)
  const made = useLeavingWorktrees((state) => (found && state.byPath[found.path] ? undefined : found))
  const branch = useWorktrees((state) => made?.branch ?? worktreeAt(state.outside, workingFolder(state, ref))?.worktree.branch)
  const summary = useWorktreeSummaries((state) => (made ? state.byPath[made.path] : undefined))
  // A worktree's app is its Thread's own; the project folder's app is the project's tip.
  const checkout = useWorktrees((state) => {
    const workingIn = workingFolder(state, ref)
    const within = (worktreeAt(state.worktrees, workingIn) ?? worktreeAt(state.outside, workingIn))?.worktree
    return within && checkoutOf(within)
  })
  const appState = useThreadApp((store) => (checkout ? appMarkOf(store, checkout)?.state : undefined))
  const appPort = useThreadApp((store) => (checkout ? appMarkOf(store, checkout)?.port : undefined))
  const project = useWorktrees((state) => projectFolder(ref.worktrees, ref.cwd) ?? (ref.cwd ? state.folderMap(ref.cwd) : undefined))
  const active = useSession((state) => state.meta?.sessionFile === ref.path)
  const selectedPath = useThreads(
    (state) => state.opening?.ref.path ?? state.viewing?.ref.path
  )
  const livePath = useRailAcp((state) => activeAcp(state)?.threadPath)
  const liveProvider = useRailAcp((state) => acpForThread(state, ref)?.harness)
  const selectedLive = useRailAcp((state) =>
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
  const title = override ?? named ?? ref.title ?? "Untitled session"
  // A folded row wears the agent of the Session its status comes from; any other row, its own.
  const markHarness = foldState
    ? (foldState.sessions.find((session) => session.status.kind === status.kind)?.harness ?? (folded ? foldRowHarness(folded.members[0]!) : ref.harness))
    : (liveProvider ?? ref.harness)
  const menu: ThreadMenuProps = {
    target,
    title,
    archived,
    running: working || activeElsewhere || status.kind === "needs-permission",
    // A folded row's status may be another Session's run; its stop lives in that tab.
    controlled: !folded && (target.kind === "live" || working),
    path: ref.path,
    thread,
    cwd: ref.cwd,
    archiveTargets: folded?.members.map(foldRowTarget),
    pinned: isPinned,
    onPin: () => togglePinned(ref.path),
    onRename: () => setEditing(override ?? named ?? ref.title ?? ""),
  }
  // ⌘-click and ⇧-click pick the row instead of opening it (`rail-selection.ts`).
  const pickRow = useMemo(() => ({ key: ref.path, thread, target: nativeThreadTarget(ref) }), [ref, thread])
  useEffect(() => offerPick(pickRow), [pickRow])
  const picked = useRailSelection((state) => state.picked.some((row) => row.key === ref.path))
  const quiet = status.kind === "idle" || (status.kind === "review" && !status.unread)
  // Marked to read again, a quiet row wears the unread sphere and a full title, as an answer not yet read does.
  const unreadMark = markedUnread && quiet

  return (
    <>
    <ThreadContextMenu {...menu}>
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
          // Dropped on the composer instead, it becomes a chip there.
          if (thread) pressTab(event, { thread, title, shown, reference: threadToken(ref.harness, threadReferenceId(ref)) }, event.currentTarget)
        }}
        onClick={(event) => {
          if (pickByClick(pickRow, event, railThreadRowKeys)) return
          clearPicked()
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
        // The row's full text, shown by the rail's own tip (`rail-tip.tsx`), never a native `title`: on macOS those
        // arrive late or not at all. What the row no longer draws (the branch, its Sessions, an app, setup) is here.
        data-tip={[
          title,
          quiet ? (unreadMark ? "Marked unread" : undefined) : threadStatusLabel(status, markHarness),
          work ? WORK_STATUS_WORDS[work] : undefined,
          fins.label,
          foldState
            ? [
                `${foldState.sessions.length} sessions`,
                ...foldState.sessions.map((session) => `${harnessLabel(session.harness)} · ${sessionStateText(session.status)}`),
              ].join("\n")
            : undefined,
          purpose ? purposeWords(purpose.kind, purpose.project) : undefined,
          keptSessionText(ref)?.line,
          ref.nativeArchived && !ref.archived ? `Archived in ${harnessLabel(ref.harness)}` : undefined,
          [
            [...(ref.lineage ?? []).map((origin) => harnessLabel(origin.harness)), harnessLabel(ref.harness)].join(" → "),
            ref.model,
          ].filter(Boolean).join(" · "),
          ref.cwd,
          !made && branch ? `Worktree on ${branch}` : undefined,
          isPinned ? "Pinned" : undefined,
          appState ? appMarkLabel(appState, appPort) : undefined,
          "Double-click the title to rename",
          made ? `\n${worktreeTip(made, summary).join("\n")}` : undefined,
        ]
          .filter(Boolean)
          .join("\n")}
        data-active={lit || undefined}
        data-picked={picked || undefined}
        aria-selected={picked || undefined}
        data-thread-row
        data-thread-id={thread}
        data-flip-key={ref.path}
        data-conversation-id={target.kind === "live" ? target.id : undefined}
        data-thread-indent={indent || undefined}
        data-apex-row={apex || undefined}
        data-apex-open={apex ? fins.open : undefined}
        data-fin-counts={fins.label}
        data-thread-purpose={setup ? "setup" : undefined}
        data-thread-worktree={branch}
        data-kept={ref.archived ? (ref.copyOnly ? "copy" : "records") : undefined}
        data-work-status={work ?? undefined}
        data-marked-unread={unreadMark || undefined}
        className={ROW_SURFACE}
      >
        {apex && thread ? (
          <ApexFold thread={thread} open={fins.open} />
        ) : (
          <ThreadMark status={status} state={unreadMark ? "unread" : undefined} harness={markHarness} lit={lit} cut={lit ? "var(--raised)" : undefined} size={18} />
        )}
        {editing !== null ? (
          <input
            autoFocus
            value={editing}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => setEditing(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === "Enter") {
                void renameThreadTitle({ thread, path: ref.path, title: editing, shown: override ?? named ?? ref.title ?? "", native: ref.title })
                setEditing(null)
              }
              if (event.key === "Escape") setEditing(null)
            }}
            onBlur={() => setEditing(null)}
            className="min-w-0 flex-1 bg-raised px-1 text-ui text-foreground ring-1 ring-hairline focus:outline-none"
          />
        ) : (
          <span
            data-row-title
            onDoubleClick={(event) => {
              event.stopPropagation()
              setEditing(override ?? named ?? ref.title ?? "")
            }}
            className={cn("rail-fade min-w-0 flex-1 text-ui", titleTone(lit, status, { work, unread: unreadMark }))}
          >
            {title}
          </span>
        )}
        {showFolder && ref.cwd ? (
          <span className="max-w-[6rem] shrink-[2] truncate text-label text-faint/70">
            {threadFolderKey(ref) ? workspaceName(project ?? ref.cwd) : "tmp"}
          </span>
        ) : null}
        <RowEnd status={status} updatedAt={ref.updatedAt} finsWorking={fins.working} work={work} />
        {/* The row's controls float over its trailing edge on hover or focus
            (`.rail-row-actions`), so the title keeps its width. They also stay
            while a menu inside is open: the menu is portaled, so focus leaves
            the row. Over the controls the row's tip stands down for their own
            labels. */}
        <span
          data-tip-quiet
          className={cn("rail-row-actions", ROW_ACTIONS)}
          onClick={(event) => event.stopPropagation()}
        >
          <ArchiveButton {...menu} />
          <ThreadActions {...menu} />
          <Detach path={ref.path} />
        </span>
      </div>
    </ThreadContextMenu>
    {apex ? <ApexAsks apex={thread} apexTitle={title} open={fins.open} /> : null}
    </>
  )
})

import { useHarnessIdentity } from "@/lib/harness-label"
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { ArchiveIcon, FolderGit2Icon, PinIcon, XIcon } from "lucide-react"
import { harnessLabel } from "@/components/rail/harness-meta"
import { ReadyBesideMark, ThreadMark, ThreadStatusEnd } from "@/components/rail/thread-status"
import { AppMarkIcon } from "@/components/rail/app-mark"
import { ThreadPurposeChip } from "@/components/rail/purpose-chip"
import { ThreadActions, ThreadContextMenu, type ThreadMenuProps } from "@/components/rail/thread-actions"
import { archivedThread, nativeThreadTarget, useThreadArchives, type ThreadTarget } from "@/state/thread-lifecycle"
import { ApexCrewLine } from "@/components/rail/fin-pips"
import { useIsApex } from "@/state/fin-pips"
import { ApexAsks } from "@/components/rail/apex-asks"
import {
  foldedThreadState,
  foldRowHarness,
  sameFoldedThreadState,
  sessionStateText,
  type FoldedThread,
  type FoldRow,
} from "@/lib/thread-fold"
import { rowThread, useThreadGroups } from "@/state/thread-groups"
import { renameThreadTitle, useThreadTitles } from "@/state/thread-titles"
import { openFoldedThread } from "@/state/thread-sessions"
import { onScreenSession } from "@/state/session-panes"
import { pressTab } from "@/state/tab-drag"
import { followCheckouts } from "@/state/checkout-heads"
import { useLeavingWorktrees, useWorktrees, useWorktreeSummaries, workingFolder, worktreeAt } from "@/state/worktrees"
import { worktreeTip } from "@/lib/worktree-marks"
import { WorktreeMark } from "@/components/rail/worktree-mark"
import { threadReferenceId, threadToken } from "@/lib/mentions"
import { workspaceName } from "@/lib/format"
import { threadFolderKey } from "@/lib/thread-folders"
import { checkoutOf, projectFolder } from "@mako/host/contracts/worktree-paths"
import type { ThreadRef } from "@/lib/types"
import { cn } from "@/lib/utils"
import { togglePinned, usePrefs } from "@/state/prefs"
import { actions, useSession } from "@/state/session"
import { useTabs, type TabInfo } from "@/state/tabs"
import { acpForThread, activeAcp, useAcp } from "@/state/acp"
import { keptSessionText } from "@/lib/kept-session"
import { sameThreadStatus, threadStatus, threads, useThreads } from "@/state/threads"
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

/** A rail row's box and paint: hover, an open menu, and the one lit row (`data-active`). */
export const ROW_SURFACE =
  "group relative isolate flex h-7 w-full items-center gap-2 pr-1 text-left transition-colors duration-100 hover:bg-fill-hover data-[state=open]:bg-fill-hover data-active:bg-raised data-active:hover:bg-raised"

/**
 * A row's floating controls, shown while the row (`group`) is hovered or focused, or a menu of theirs is open.
 * `z-[1]` keeps them over the row's status mark, whose translucent parts paint as their own layers. Focus inside the
 * row is an arbitrary variant, not `group-has-[…]`: that compiles to `:is(.group:has(…) *)`, and with a universal last
 * part any element added anywhere restyles the whole of `main`, a frame lost for each transcript row that mounts.
 */
export const ROW_ACTIONS =
  "pointer-events-none absolute inset-y-0 right-0 z-[1] flex items-center pl-4 pr-1 opacity-0 transition-opacity duration-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-visible:pointer-events-auto group-focus-visible:opacity-100 [.group:has(:focus-visible)_&]:pointer-events-auto [.group:has(:focus-visible)_&]:opacity-100 has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100"

/** An Apex's row is two lines, its crew's pips under its title (`ApexCrewLine`). */
export const APEX_SURFACE = "h-11 flex-col items-stretch justify-center gap-[3px]"

/**
 * A row's first line: the row's own flex line for a Thread, a line of its own over an Apex's pips, which holds the
 * row's controls too. The same element either way, so a Thread that starts its first Fin keeps its mark mounted.
 */
export function RowLine({ apex, children }: { apex: boolean; children: ReactNode }) {
  return <span className={apex ? "relative -mr-1 flex h-5 w-auto min-w-0 items-center gap-2 pr-1" : "contents"}>{children}</span>
}

/** How many Sessions a folded row stands for. */
export function SessionCount({ count }: { count: number }) {
  return (
    <span
      aria-label={`${count} sessions`}
      className="tabular flex h-4 min-w-4 shrink-0 items-center justify-center bg-fill-selected px-1 text-label leading-none text-muted-foreground"
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
  useHarnessIdentity()
  const override = usePrefs((prefs) => prefs.titleOverrides[ref.path])
  const [editing, setEditing] = useState<string | null>(null)
  // A thread whose CLI is being driven from here right now wears a pulse —
  // the same promise a tab's dot makes: something is working behind this row.
  // Its status also reads the live store; this repaints the row when those facts move, so it never stays stale.
  useAcp((state) => threadLiveKey(state, ref))
  const ownStatus = useThreads((state) => threadStatus(ref, state), sameThreadStatus)
  const foldState = useThreads(
    (state) => (folded ? foldedThreadState(folded.members, (member) => threadStatus(member, state)) : null),
    sameFoldedThreadState
  )
  const status = foldState?.status ?? ownStatus
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
  const named = useThreadTitles((state) => (thread ? state.byThread[thread]?.title : undefined))
  const draftOpen = useThreadGroups((state) => state.open !== null && state.open === thread)
  const apex = useIsApex(thread)
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
  // A worktree's app is its Thread's own; the project folder's app is marked on the folder's header.
  const checkout = useWorktrees((state) => {
    const workingIn = workingFolder(state, ref)
    const within = (worktreeAt(state.worktrees, workingIn) ?? worktreeAt(state.outside, workingIn))?.worktree
    return within && checkoutOf(within)
  })
  const project = useWorktrees((state) => projectFolder(ref.worktrees, ref.cwd) ?? (ref.cwd ? state.folderMap(ref.cwd) : undefined))
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
          foldState
            ? [
                `${foldState.sessions.length} sessions`,
                ...foldState.sessions.map((session) => `${harnessLabel(session.harness)} · ${sessionStateText(session.status)}`),
              ].join("\n")
            : undefined,
          keptSessionText(ref)?.line,
          ref.nativeArchived && !ref.archived ? `Archived in ${harnessLabel(ref.harness)}` : undefined,
          [
            ...(ref.lineage ?? []).map((origin) => harnessLabel(origin.harness)),
            harnessLabel(ref.harness),
          ].join(" → "),
          ref.model,
          ref.cwd,
          !made && branch ? `Worktree on ${branch}` : undefined,
          "Double-click the title to rename",
          made ? `\n${worktreeTip(made, summary).join("\n")}` : undefined,
        ]
          .filter(Boolean)
          .join("\n")}
        data-active={lit || undefined}
        data-thread-row
        data-flip-key={ref.path}
        data-conversation-id={target.kind === "live" ? target.id : undefined}
        data-thread-indent={indent || undefined}
        data-apex-row={apex || undefined}
        className={cn(ROW_SURFACE, apex && APEX_SURFACE, indent ? "pl-2" : "pl-1.5")}
      >
        <RowLine apex={apex}>
        <ThreadMark status={status} harness={markHarness} lit={lit} cut={lit ? "var(--raised)" : undefined} />
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
            onDoubleClick={(event) => {
              event.stopPropagation()
              setEditing(override ?? named ?? ref.title ?? "")
            }}
            className={cn(
              "min-w-0 flex-[1_1_60%] truncate text-ui",
              lit ? "font-medium text-foreground" : "text-foreground/85"
            )}
          >
            {title}
          </span>
        )}
        <ThreadPurposeChip thread={thread} />
        {folded ? <SessionCount count={folded.members.length} /> : null}
        {/* The branch itself is in the tip and on the chat's strip; the row
            spends its width on the title. */}
        {made ? (
          <WorktreeMark worktree={made} summary={summary} />
        ) : branch ? (
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
        {ref.archived ? (
          <ArchiveIcon
            data-kept={ref.copyOnly ? "copy" : "records"}
            className="size-3 shrink-0 text-faint/70"
            aria-label={keptSessionText(ref)?.line}
          />
        ) : null}
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
          <button
            type="button"
            aria-label={isPinned ? "Unpin" : "Pin"}
            onClick={(event) => {
              event.stopPropagation()
              togglePinned(ref.path)
            }}
            className="pressable flex size-6 items-center justify-center text-faint hover:bg-fill-hover hover:text-foreground"
          >
            <PinIcon className={cn("size-3", isPinned && "fill-current")} />
          </button>
          <ThreadActions {...menu} />
          <Detach path={ref.path} />
        </span>
        {checkout ? <AppMarkIcon checkout={checkout} /> : null}
        {foldState?.readyBeside ? <ReadyBesideMark sessions={foldState.sessions} /> : null}
        <ThreadStatusEnd status={status} updatedAt={ref.updatedAt} />
        </RowLine>
        {apex ? <ApexCrewLine thread={thread} /> : null}
      </div>
    </ThreadContextMenu>
    {apex ? <ApexAsks apex={thread} apexTitle={title} indent={indent} /> : null}
    </>
  )
})

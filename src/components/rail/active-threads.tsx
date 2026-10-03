import { useHarnessIdentity } from "@/lib/harness-label"
import { useState } from "react"
import { AppMarkIcon } from "@/components/rail/app-mark"
import { ThreadPurposeChip } from "@/components/rail/purpose-chip"
import { FoldGlyph } from "@/components/rail/fold-glyph"
import { harnessLabel } from "@/components/rail/harness-meta"
import { ActivityMark, type ActivityState } from "@/components/ui/activity-mark"
import { ThreadActions, ThreadContextMenu, type ThreadMenuProps } from "@/components/rail/thread-actions"
import { ROW_ACTIONS, ROW_ACTIONS_BESIDE_MARK, ROW_SURFACE, SessionCount } from "@/components/rail/thread-row"
import { archivedLive, nativeThreadTarget, useThreadArchives, type ThreadTarget } from "@/state/thread-lifecycle"
import { workspaceName } from "@/lib/format"
import {
  FOLD_GLYPHS,
  foldedThreadState,
  foldRowHarness,
  sameFoldedThreadState,
  sessionRunning,
  sessionStateText,
  type FoldedThread,
} from "@/lib/thread-fold"
import { ReadyBesideMark, ThreadStatusMark } from "@/components/rail/thread-status"
import { threadStatus, useThreads } from "@/state/threads"
import { threadFolderKey } from "@/lib/thread-folders"
import { acp, acpForThread, useAcp } from "@/state/acp"
import type { AcpPresence } from "@/state/acp-presence"
import { rowThread, useThreadGroups } from "@/state/thread-groups"
import { useThreadPurposes } from "@/state/thread-purposes"
import { useThreadTitles } from "@/state/thread-titles"
import { openFoldedThread } from "@/state/thread-sessions"
import { useWorktrees, worktreeAt } from "@/state/worktrees"
import { cn } from "@/lib/utils"

export function LiveAgentRow({
  presence,
  folded,
  indent = false,
}: {
  presence: AcpPresence
  /** Set when this row stands for a Thread with several Sessions. */
  folded?: FoldedThread
  indent?: boolean
}) {
  useHarnessIdentity()
  const archived = useThreadArchives((state) => archivedLive(presence, state.keys))
  const thread = useThreadGroups((state) => folded?.thread ?? rowThread(presence, state.threadOf))
  const setup = useThreadPurposes((state) => (thread ? state.byThread[thread]?.kind : undefined) ?? presence.purpose) === "setup"
  const [since] = useState(() => performance.now())
  const checkout = useWorktrees((state) => worktreeAt(state.worktrees, presence.cwd)?.worktree.path)
  // Lit by the same rule as `ThreadRow`: a thread open in the viewer is the
  // selection; otherwise the live conversation on screen is.
  const draftOpen = useThreadGroups((state) => state.open !== null && state.open === thread)
  const viewedMember = useThreads((state) => {
    const path = state.opening?.ref.path ?? state.viewing?.ref.path
    return path === undefined ? undefined : Boolean(folded?.members.some((member) => member.kind === "native" && member.ref.path === path))
  })
  const liveOnScreen = useAcp((state) =>
    Boolean(
      state.activeKey &&
        (folded
          ? folded.members.some((member) => (member.kind === "live" ? member.presence.key : acpForThread(state, member.ref)?.key) === state.activeKey)
          : presence.key === state.activeKey)
    )
  )
  const lit = draftOpen || (viewedMember ?? liveOnScreen)
  const label =
    presence.status === "needs-permission"
      ? "Needs your approval"
      : presence.status === "running"
        ? "Working"
        : presence.status === "starting"
          ? "Connecting"
          : presence.status === "failed"
            ? "Failed"
            : "Ready"
  const state: ActivityState =
    presence.status === "needs-permission"
      ? "waiting"
      : presence.status === "starting"
        ? "connecting"
        : presence.status === "running"
          ? "working"
          : presence.status === "failed"
            ? "failed"
            : "idle"
  const foldState = useThreads(
    (threadState) => (folded ? foldedThreadState(folded.members, (member) => threadStatus(member, threadState)) : null),
    sameFoldedThreadState
  )
  // A folded row whose other Session is the one doing something shows that
  // Session's state; this conversation's own mark is for when it's the news.
  const otherSession = foldState && foldState.status.kind !== "idle" && foldState.sessions[0]?.status !== foldState.status
  const named = useThreadTitles((titles) => (thread ? titles.byThread[thread]?.title : undefined))
  const title =
    named ?? presence.title ?? `New ${harnessLabel(presence.harness)} conversation`
  const open = () => {
    if (folded) openFoldedThread(folded.thread, folded.members)
    else acp.activate(presence.key)
  }
  const archiveTargets = folded?.members.map((member): ThreadTarget =>
    member.kind === "native" ? nativeThreadTarget(member.ref) : { kind: "live", id: member.key }
  )
  const menu: ThreadMenuProps = {
    target: { kind: "live", id: presence.key },
    title,
    archived,
    running: presence.status === "running" || presence.status === "starting" || presence.status === "needs-permission",
    controlled: true,
    path: presence.threadPath,
    thread,
    cwd: presence.cwd,
    archiveTargets,
  }
  return (
    <ThreadContextMenu {...menu}>
      <div
        role="button"
        tabIndex={0}
        onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); open() } }}
        aria-label={[
          title,
          setup ? "setup Thread" : undefined,
          foldState
            ? `${foldState.sessions.length} sessions: ${foldState.sessions.map((session) => `${harnessLabel(session.harness)} ${sessionStateText(session.status)}`).join(", ")}`
            : label,
        ].filter(Boolean).join(", ")}
        data-thread-row
        data-flip-key={presence.key}
        data-conversation-id={presence.key}
        data-thread-indent={indent || undefined}
        data-active={lit || undefined}
        aria-current={lit || undefined}
        onClick={open}
        className={cn("pressable", ROW_SURFACE, indent ? "pl-2" : "pl-1.5")}
      >
        <span className="flex shrink-0 items-center -space-x-1">
          {(folded?.members.slice(0, FOLD_GLYPHS) ?? [null]).map((member, index) => {
            const session = foldState?.sessions[index]
            return (
              <FoldGlyph
                key={member?.key ?? presence.key}
                harness={member ? foldRowHarness(member) : presence.harness}
                live={session ? sessionRunning(session.status) : false}
                rowSince={since}
              />
            )
          })}
        </span>
        <span className={cn("min-w-0 flex-[1_1_60%] truncate text-ui", lit ? "font-medium text-foreground" : "text-foreground/85")}>
          {title}
        </span>
        <ThreadPurposeChip thread={thread} starting={presence.purpose} />
        {folded ? <SessionCount count={folded.members.length} /> : null}
        {!indent ? (
          <span className="min-w-10 max-w-[6rem] shrink truncate text-label text-faint">
            {threadFolderKey(presence) ? workspaceName(presence.cwd) : "tmp"}
          </span>
        ) : null}
        <span
          data-tip-quiet
          className={cn("rail-row-actions", ROW_ACTIONS, (presence.status === "needs-permission" || presence.status === "failed") && ROW_ACTIONS_BESIDE_MARK)}
          onClick={(event) => event.stopPropagation()}
        >
          <ThreadActions {...menu} />
        </span>
        {checkout ? <AppMarkIcon checkout={checkout} /> : null}
        {foldState?.readyBeside ? <ReadyBesideMark sessions={foldState.sessions} /> : null}
        {otherSession ? (
          <ThreadStatusMark status={foldState.status} />
        ) : (
          <span role="img" aria-label={label} title={label} className="flex shrink-0 text-muted-foreground">
            <ActivityMark state={state} size={20} />
          </span>
        )}
      </div>
    </ThreadContextMenu>
  )
}

import { useHarnessIdentity } from "@/lib/harness-label"
import { attentionLine } from "@mako/host/contracts/notifications"
import { AppMarkIcon } from "@/components/rail/app-mark"
import { ThreadPurposeChip } from "@/components/rail/purpose-chip"
import { ApexCrewLine } from "@/components/rail/fin-pips"
import { useIsApex } from "@/state/fin-pips"
import { ApexAsks } from "@/components/rail/apex-asks"
import { harnessLabel } from "@/components/rail/harness-meta"
import { ThreadActions, ThreadContextMenu, type ThreadMenuProps } from "@/components/rail/thread-actions"
import { APEX_SURFACE, ROW_ACTIONS, ROW_SURFACE, RowLine, SessionCount } from "@/components/rail/thread-row"
import { WorktreeMark } from "@/components/rail/worktree-mark"
import { archivedLive, nativeThreadTarget, useThreadArchives, type ThreadTarget } from "@/state/thread-lifecycle"
import { copyAge, formatRelative, workspaceName } from "@/lib/format"
import {
  foldedThreadState,
  presenceThreadStatus,
  sameFoldedThreadState,
  sessionStateText,
  type FoldedThread,
} from "@/lib/thread-fold"
import { ReadyBesideMark, ThreadMark, ThreadStatusEnd } from "@/components/rail/thread-status"
import { threadStatus, useThreads, type ThreadStatus } from "@/state/threads"
import { threadFolderKey } from "@/lib/thread-folders"
import { acpForThread, useAcp } from "@/state/acp"
import { openConversation, useWindowRoutes } from "@/state/window-routes"
import { CLOUD_WHERE } from "@/state/cloud-moves"
import { PlaceMark } from "@/components/ui/place-mark"
import { runPlace } from "@mako/host/contracts/account-devices"
import type { AcpPresence } from "@/state/acp-presence"
import { rowThread, useThreadGroups } from "@/state/thread-groups"
import { useThreadPurposes } from "@/state/thread-purposes"
import { useThreadTitles } from "@/state/thread-titles"
import { openFoldedThread } from "@/state/thread-sessions"
import { useWorktrees, worktreeAt } from "@/state/worktrees"
import { cn } from "@/lib/utils"

const IDLE: ThreadStatus = { kind: "idle" }

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
  const checkout = useWorktrees((state) => worktreeAt(state.worktrees, presence.cwd)?.worktree.path)
  // Lit by the same rule as `ThreadRow`: a thread open in the viewer is the
  // selection; otherwise the live conversation on screen is.
  const draftOpen = useThreadGroups((state) => state.open !== null && state.open === thread)
  const apex = useIsApex(thread)
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
  // In a browser every computer is elsewhere: the cloud and a machine of the person's own are marked, as the places
  // apart from their Macs. The row's tip names the place.
  const routed = useWindowRoutes((state) => state.routes !== null)
  const place = runPlace(presence.elsewhere === CLOUD_WHERE, presence.elsewhereKind)
  // Its device can't be heard: nothing there is shown at work, and the row says when it was last seen instead.
  const lastSeen = presence.quietSince === undefined ? undefined : `last seen ${copyAge(presence.quietSince)}`
  const where = presence.elsewhere ? `on ${presence.elsewhere}${lastSeen ? `, ${lastSeen}` : ""}` : undefined
  const label =
    presence.status === "needs-permission"
      ? attentionLine("approval", presence.waitingOn)
      : presence.status === "running"
        ? "Working"
        : presence.status === "starting"
          ? "Starting"
          : presence.status === "failed"
            ? "Failed"
            : presence.status === "background"
              ? presence.background === 1 ? "Waiting on a background task" : `Waiting on ${presence.background ?? 0} background tasks`
              : presence.openElsewhere
                ? `Open in ${harnessLabel(presence.harness)}`
                : "Ready"
  const foldState = useThreads(
    (threadState) => (folded ? foldedThreadState(folded.members, (member) => threadStatus(member, threadState)) : null),
    sameFoldedThreadState
  )
  // A folded row whose other Session is the one doing something shows that
  // Session's state; this conversation's own mark is for when it's the news.
  const otherSession = foldState && foldState.status.kind !== "idle" && foldState.sessions[0]?.status !== foldState.status
  // A device that can't be heard shows nothing of its at work.
  const quiet = presence.quietSince !== undefined && presence.status === "ready"
  const status = otherSession ? foldState.status : quiet ? IDLE : presenceThreadStatus(presence)
  const markHarness = otherSession ? (foldState.sessions.find((session) => session.status === foldState.status)?.harness ?? presence.harness) : presence.harness
  const named = useThreadTitles((titles) => (thread ? titles.byThread[thread]?.title : undefined))
  // A Thread's name titles its row, this Mac's from its store, another device's from the account's list.
  const title =
    named ?? presence.threadTitle ?? presence.title ?? `New ${harnessLabel(presence.harness)} conversation`
  const open = () => {
    if (folded) openFoldedThread(folded.thread, folded.members)
    else openConversation(presence)
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
    <>
    <ThreadContextMenu {...menu}>
      <div
        role="button"
        tabIndex={0}
        onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); open() } }}
        aria-label={[
          title,
          where,
          setup ? "setup Thread" : undefined,
          foldState
            ? `${foldState.sessions.length} sessions: ${foldState.sessions.map((session) => `${harnessLabel(session.harness)} ${sessionStateText(session.status)}`).join(", ")}`
            : label,
        ].filter(Boolean).join(", ")}
        data-thread-row
        data-tip={where ? `${title} · ${where}${presence.waitingOn ? ` · ${presence.waitingOn}` : ""}` : undefined}
        data-flip-key={presence.key}
        data-conversation-id={presence.key}
        data-thread-indent={indent || undefined}
        data-active={lit || undefined}
        aria-current={lit || undefined}
        onClick={open}
        data-apex-row={apex || undefined}
        className={cn("pressable", ROW_SURFACE, apex && APEX_SURFACE, indent ? "pl-2" : "pl-1.5")}
      >
        <RowLine apex={apex}>
        <ThreadMark
          status={status}
          state={!otherSession && presence.status === "starting" ? "starting" : undefined}
          harness={markHarness}
          lit={lit}
          cut={lit ? "var(--raised)" : undefined}
          label={otherSession ? undefined : label}
        />
        <span className={cn("min-w-0 flex-[1_1_60%] truncate text-ui", lit ? "font-medium text-foreground" : "text-foreground/85")}>
          {title}
        </span>
        <ThreadPurposeChip thread={thread} starting={presence.purpose} />
        {presence.elsewhere && (!routed || place !== "device") ? <PlaceMark place={place} data-elsewhere={place} className="text-faint/80" /> : null}
        {folded ? <SessionCount count={folded.members.length} /> : null}
        {/* The branch its owner's worktree is on, as a row this Mac made one for wears it. */}
        {presence.worktreeBranch ? <WorktreeMark worktree={{ branch: presence.worktreeBranch }} summary={undefined} /> : null}
        {!indent ? (
          <span className="min-w-10 max-w-[6rem] shrink truncate text-label text-faint">
            {threadFolderKey(presence) ? workspaceName(presence.workspace ?? presence.cwd) : "tmp"}
          </span>
        ) : null}
        <span
          data-tip-quiet
          className={cn("rail-row-actions", ROW_ACTIONS)}
          onClick={(event) => event.stopPropagation()}
        >
          <ThreadActions {...menu} />
        </span>
        {checkout ? <AppMarkIcon checkout={checkout} /> : null}
        {foldState?.readyBeside ? <ReadyBesideMark sessions={foldState.sessions} /> : null}
        {quiet ? (
          <span data-last-seen title={`Last seen ${copyAge(presence.quietSince!)}`} className="tabular shrink-0 text-label text-faint">
            {/* "seen", so it doesn't read as an idle row's time of its last change. */}
            seen {formatRelative(presence.quietSince!)}
          </span>
        ) : (
          <ThreadStatusEnd status={status} updatedAt={presence.movedAt === undefined ? undefined : new Date(presence.movedAt).toISOString()} />
        )}
        </RowLine>
        {apex ? <ApexCrewLine thread={thread} /> : null}
      </div>
    </ThreadContextMenu>
    {apex ? <ApexAsks apex={thread} apexTitle={title} indent={indent} /> : null}
    </>
  )
}

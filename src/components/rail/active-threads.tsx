import { memo, useEffect, useMemo } from "react"
import { clearPicked, offerPick, pickByClick, useRailSelection } from "@/state/rail-selection"
import { railThreadRowKeys } from "@/components/rail/rail-keys"
import { WORK_STATUS_WORDS } from "@mako/host/contracts/thread-marks"
import { useThreadMarks } from "@/state/thread-marks"
import { useHarnessIdentity } from "@/lib/harness-label"
import { attentionLine } from "@mako/host/contracts/notifications"
import { useIsApex } from "@/state/fin-pips"
import { ApexAsks } from "@/components/rail/apex-asks"
import { harnessLabel } from "@/components/rail/harness-meta"
import { ArchiveButton, ThreadActions, ThreadContextMenu, type ThreadMenuProps } from "@/components/rail/thread-actions"
import { ApexFold, ROW_ACTIONS, ROW_SURFACE, RowEnd } from "@/components/rail/thread-row"
import { purposeWords, titleTone } from "@/lib/rail-marks"
import { useApexFins } from "@/state/fin-pips"
import { archivedLive, nativeThreadTarget, useThreadArchives, type ThreadTarget } from "@/state/thread-lifecycle"
import { copyAge, formatRelative, workspaceName } from "@/lib/format"
import {
  foldedThreadState,
  presenceThreadStatus,
  sameFoldedThreadState,
  sessionStateText,
  type FoldedThread,
} from "@/lib/thread-fold"
import { ThreadMark } from "@/components/rail/thread-status"
import { threadStatusLabel } from "@/lib/live-mark-state"
import { threadStatus, useThreads, type ThreadStatus } from "@/state/threads"
import { threadFolderKey } from "@/lib/thread-folders"
import { acpForThread } from "@/state/acp"
import { useRailAcp } from "@/state/acp-state"
import { openConversation, useWindowRoutes } from "@/state/window-routes"
import { CLOUD_WHERE } from "@/state/cloud-moves"
import { PlaceMark } from "@/components/ui/place-mark"
import { runPlace } from "@mako/host/contracts/account-devices"
import type { AcpPresence } from "@/state/acp-presence"
import { rowThread, useThreadGroups } from "@/state/thread-groups"
import { useThreadPurposes } from "@/state/thread-purposes"
import { useThreadTitles } from "@/state/thread-titles"
import { openFoldedThread } from "@/state/thread-sessions"
import { cn } from "@/lib/utils"

const IDLE: ThreadStatus = { kind: "idle" }

/**
 * A conversation's row. Drawn again when its own facts change (a presence is one object while they stand,
 * `selectAcpPresence`), not each time the list around it is.
 */
export const LiveAgentRow = memo(function LiveAgentRow({
  presence,
  folded,
  indent = false,
}: {
  presence: AcpPresence
  /** Set when this row stands for a Thread with several Sessions. */
  folded?: FoldedThread
  indent?: boolean
  /** The rail's minute: the times the row says (when it moved, when its device was last seen) are read again as it turns. */
  now?: number
}) {
  useHarnessIdentity()
  const archived = useThreadArchives((state) => archivedLive(presence, state.keys))
  const thread = useThreadGroups((state) => folded?.thread ?? rowThread(presence, state.threadOf))
  const recordedPurpose = useThreadPurposes((state) => (thread ? state.byThread[thread] : undefined))
  const purposeKind = recordedPurpose?.kind ?? presence.purpose
  const setup = purposeKind === "setup"
  // Lit by the same rule as `ThreadRow`: a thread open in the viewer is the
  // selection; otherwise the live conversation on screen is.
  const draftOpen = useThreadGroups((state) => state.open !== null && state.open === thread)
  const apex = useIsApex(thread)
  const fins = useApexFins(thread, apex)
  const work = useThreadMarks((state) => (thread ? state.byThread[thread]?.status : undefined)) ?? null
  const markedUnread = useThreadMarks((state) => (thread ? state.byThread[thread]?.unreadAt != null : false))
  const viewedMember = useThreads((state) => {
    const path = state.opening?.ref.path ?? state.viewing?.ref.path
    return path === undefined ? undefined : Boolean(folded?.members.some((member) => member.kind === "native" && member.ref.path === path))
  })
  const liveOnScreen = useRailAcp((state) =>
    Boolean(
      state.activeKey &&
        (folded
          ? folded.members.some((member) => (member.kind === "live" ? member.presence.key : acpForThread(state, member.ref)?.key) === state.activeKey)
          : presence.key === state.activeKey)
    )
  )
  const lit = draftOpen || (viewedMember ?? liveOnScreen)
  // ⌘-click and ⇧-click pick the row instead of opening it (`rail-selection.ts`).
  const pickRow = useMemo(() => ({ key: presence.key, thread, target: { kind: "live" as const, id: presence.key } }), [presence.key, thread])
  useEffect(() => offerPick(pickRow), [pickRow])
  const picked = useRailSelection((state) => state.picked.some((row) => row.key === presence.key))
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
  // Marked to read again, a quiet row wears the unread sphere, as an answer not yet read does.
  const unreadMark = markedUnread && status.kind === "idle"
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
        data-thread-id={thread}
        // What the row no longer draws (where it runs, its branch, its Sessions, setup) is its tip.
        data-tip={[
          title,
          where ? `${where}${presence.waitingOn ? ` · ${presence.waitingOn}` : ""}` : status.kind === "idle" ? undefined : label,
          fins.label,
          work ? WORK_STATUS_WORDS[work] : undefined,
          foldState ? `${foldState.sessions.length} sessions` : undefined,
          purposeKind ? purposeWords(purposeKind, recordedPurpose?.project) : undefined,
          presence.worktreeBranch ? `Worktree on ${presence.worktreeBranch}` : undefined,
        ].filter(Boolean).join("\n")}
        data-flip-key={presence.key}
        data-conversation-id={presence.key}
        data-thread-indent={indent || undefined}
        data-active={lit || undefined}
        data-picked={picked || undefined}
        aria-selected={picked || undefined}
        aria-current={lit || undefined}
        onClick={(event) => {
          if (pickByClick(pickRow, event, railThreadRowKeys)) return
          clearPicked()
          open()
        }}
        data-apex-row={apex || undefined}
        data-apex-open={apex ? fins.open : undefined}
        data-fin-counts={fins.label}
        data-thread-purpose={setup ? "setup" : undefined}
        data-work-status={work ?? undefined}
        data-marked-unread={unreadMark || undefined}
        className={cn("pressable", ROW_SURFACE)}
      >
        {apex && thread ? (
          <ApexFold thread={thread} open={fins.open} label={otherSession ? threadStatusLabel(status, markHarness) : label} />
        ) : (
          <ThreadMark
            status={status}
            state={!otherSession && presence.status === "starting" ? "starting" : unreadMark ? "unread" : undefined}
            harness={markHarness}
            lit={lit}
            cut={lit ? "var(--raised)" : undefined}
            label={otherSession ? undefined : label}
            size={18}
          />
        )}
        <span data-row-title className={cn("rail-fade min-w-0 flex-1 text-ui", titleTone(lit, status, { work, unread: unreadMark }))}>
          {title}
        </span>
        {presence.elsewhere && (!routed || place !== "device") ? <PlaceMark place={place} data-elsewhere={place} className="text-faint/80" /> : null}
        {!indent ? (
          <span className="max-w-[6rem] shrink-[2] truncate text-label text-faint">
            {threadFolderKey(presence) ? workspaceName(presence.workspace ?? presence.cwd) : "tmp"}
          </span>
        ) : null}
        <RowEnd status={status} updatedAt={presence.movedAt === undefined ? undefined : new Date(presence.movedAt).toISOString()} finsWorking={fins.working} work={work}>
          {quiet ? (
            <span data-last-seen title={`Last seen ${copyAge(presence.quietSince!)}`} className="tabular text-label text-faint">
              {/* "seen", so it doesn't read as an idle row's time of its last change. */}
              seen {formatRelative(presence.quietSince!)}
            </span>
          ) : undefined}
        </RowEnd>
        <span
          data-tip-quiet
          className={cn("rail-row-actions", ROW_ACTIONS)}
          onClick={(event) => event.stopPropagation()}
        >
          <ArchiveButton {...menu} />
          <ThreadActions {...menu} />
        </span>
      </div>
    </ThreadContextMenu>
    {apex ? <ApexAsks apex={thread} apexTitle={title} open={fins.open} /> : null}
    </>
  )
})

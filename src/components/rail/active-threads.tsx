import { useHarnessIdentity } from "@/lib/harness-label"
import { attentionLine } from "@mako/host/contracts/notifications"
import { CloudIcon, LaptopIcon } from "lucide-react"
import { AppMarkIcon } from "@/components/rail/app-mark"
import { ThreadPurposeChip } from "@/components/rail/purpose-chip"
import { ApexCrewLine } from "@/components/rail/fin-pips"
import { useIsApex } from "@/state/fin-pips"
import { ApexAsks } from "@/components/rail/apex-asks"
import { harnessLabel } from "@/components/rail/harness-meta"
import { ThreadActions, ThreadContextMenu, type ThreadMenuProps } from "@/components/rail/thread-actions"
import { APEX_SURFACE, ROW_ACTIONS, ROW_SURFACE, RowLine } from "@/components/rail/thread-row"
import { WorktreeMark } from "@/components/rail/worktree-mark"
import { archivedLive, useThreadArchives } from "@/state/thread-lifecycle"
import { copyAge, formatRelative, workspaceName } from "@/lib/format"
import { presenceThreadStatus } from "@/lib/presence-status"
import { ThreadMark, ThreadStatusEnd } from "@/components/rail/thread-status"
import { useThreads, type ThreadStatus } from "@/state/threads"
import { threadFolderKey } from "@/lib/thread-folders"
import { useAcp } from "@/state/acp"
import { openConversation, useWindowRoutes } from "@/state/window-routes"
import { CLOUD_WHERE } from "@/state/cloud-moves"
import type { AcpPresence } from "@/state/acp-presence"
import { useThreadPurposes } from "@/state/thread-purposes"
import { useThreadTitles } from "@/state/thread-titles"
import { useWorktrees, worktreeAt } from "@/state/worktrees"
import { cn } from "@/lib/utils"

const IDLE: ThreadStatus = { kind: "idle" }

export function LiveAgentRow({
  presence,
  indent = false,
}: {
  presence: AcpPresence
  indent?: boolean
}) {
  useHarnessIdentity()
  const archived = useThreadArchives((state) => archivedLive(presence, state.keys))
  const thread = presence.threadId
  const setup = useThreadPurposes((state) => (thread ? state.byThread[thread]?.kind : undefined) ?? presence.purpose) === "setup"
  const checkout = useWorktrees((state) => worktreeAt(state.worktrees, presence.cwd)?.worktree.path)
  const apex = useIsApex(thread)
  // Lit by the same rule as `ThreadRow`: a thread open in the viewer is the
  // selection; otherwise the live conversation on screen is.
  const viewing = useThreads((state) => (state.opening?.ref.path ?? state.viewing?.ref.path) !== undefined)
  const lit = useAcp((state) => !viewing && state.activeKey === presence.key)
  // In a browser every computer is elsewhere: only the cloud is marked, as the place apart from the person's own Macs.
  const routed = useWindowRoutes((state) => state.routes !== null)
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
  // A device that can't be heard shows nothing of its at work.
  const quiet = presence.quietSince !== undefined && presence.status === "ready"
  const status = quiet ? IDLE : presenceThreadStatus(presence)
  const markHarness = presence.harness
  const named = useThreadTitles((titles) => (thread ? titles.byThread[thread]?.title : undefined))
  // A Thread's name titles its row, this Mac's from its store, another device's from the account's list.
  const title =
    named ?? presence.threadTitle ?? presence.title ?? `New ${harnessLabel(presence.harness)} conversation`
  const open = () => openConversation(presence)
  const menu: ThreadMenuProps = {
    target: { kind: "live", id: presence.key },
    title,
    archived,
    running: presence.status === "running" || presence.status === "starting" || presence.status === "needs-permission",
    controlled: true,
    path: presence.threadPath,
    thread,
    cwd: presence.cwd,
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
          label,
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
          state={presence.status === "starting" ? "starting" : undefined}
          harness={markHarness}
          lit={lit}
          cut={lit ? "var(--raised)" : undefined}
          label={label}
        />
        <span className={cn("min-w-0 flex-[1_1_60%] truncate text-ui", lit ? "font-medium text-foreground" : "text-foreground/85")}>
          {title}
        </span>
        <ThreadPurposeChip thread={thread} starting={presence.purpose} />
        {presence.elsewhere && (!routed || presence.elsewhere === CLOUD_WHERE) ? <ElsewhereMark where={presence.elsewhere} /> : null}
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

/** Where a Thread that isn't on this Mac runs, at a glance: a cloud machine, or another of your computers. The row's tip names it. */
function ElsewhereMark({ where }: { where: string }) {
  const Icon = where === CLOUD_WHERE ? CloudIcon : LaptopIcon
  return <Icon aria-hidden data-elsewhere={where === CLOUD_WHERE ? "cloud" : "device"} className="size-3 shrink-0 text-faint/80" />
}

import type { ThreadGroup } from "@mako/host/contracts/thread-groups"
import type { ThreadRef } from "@/lib/types"
import type { AcpPresence } from "@/state/acp-presence"
import { rowStarted, rowThread } from "@/state/thread-groups"
import { sameThreadStatus, threadStatusPriority, type ThreadStatus } from "@/state/thread-status"

/** A rail row as the fold sees it: a catalog row, or a live conversation with none. */
export type FoldRow =
  | { kind: "native"; key: string; ref: ThreadRef }
  | { kind: "live"; key: string; presence: AcpPresence }

/** A Thread with two or more rows, shown as one. */
export interface FoldedThread {
  thread: string
  /** The row that stands for the Thread: its first Session that has a row. */
  lead: string
  /** The Thread's rows in tab order, the lead first. */
  members: readonly FoldRow[]
}

export interface ThreadFold {
  byLead: ReadonlyMap<string, FoldedThread>
  /** Rows the rail leaves out because their Thread's lead row shows them. */
  hidden: ReadonlySet<string>
}

export const EMPTY_FOLD: ThreadFold = { byLead: new Map(), hidden: new Set() }

/** Marks a folded row shows; the tip names every Session. */
export const FOLD_GLYPHS = 3

export function foldRowSession(row: FoldRow): string | undefined {
  return row.kind === "native" ? row.ref.sessionId : row.presence.sessionId
}

export function foldRowHarness(row: FoldRow): string {
  return row.kind === "native" ? row.ref.harness : row.presence.harness
}

function foldRowStarted(row: FoldRow): number {
  return rowStarted(row.kind === "native" ? row.ref : row.presence)
}

/**
 * Fold rows that share a Thread into the row of its first Session: a Thread
 * is one row however many Sessions it has, wherever they run. A row's Thread
 * is the one the tab strip shows it in (`rowThread`): this Mac's store's
 * group, else the Thread its row names, which is how a Thread another device
 * or a cloud machine runs is known, from the account's list. Its Sessions go
 * in the group's order, then the rest oldest first. A Session with two rows
 * (a catalog row and a live one, or one per harness it moved through) shows
 * once: the first row stands for it, and catalog rows come first. A Thread
 * with one row visible stays an ordinary row.
 */
export function foldThreads(
  rows: Iterable<FoldRow>,
  groups: Readonly<Record<string, ThreadGroup>>,
  threadOf: Readonly<Record<string, string>>
): ThreadFold {
  const sessions = new Set<string>()
  const byThread = new Map<string, FoldRow[]>()
  const hidden = new Set<string>()
  for (const row of rows) {
    const session = foldRowSession(row)
    const thread = session === undefined ? undefined : rowThread(row.kind === "native" ? row.ref : row.presence, threadOf)
    if (session === undefined || thread === undefined) continue
    if (sessions.has(session)) {
      hidden.add(row.key)
      continue
    }
    sessions.add(session)
    const members = byThread.get(thread)
    if (members) members.push(row)
    else byThread.set(thread, [row])
  }
  const byLead = new Map<string, FoldedThread>()
  for (const [thread, rowsOfThread] of byThread) {
    if (rowsOfThread.length < 2) continue
    const order = new Map<string, number>(groups[thread]?.sessions.map((session, index) => [session.id, index]))
    const rank = (row: FoldRow) => order.get(foldRowSession(row) ?? "") ?? order.size
    const members = rowsOfThread.toSorted((left, right) => rank(left) - rank(right) || foldRowStarted(left) - foldRowStarted(right))
    const [lead, ...rest] = members
    if (!lead) continue
    byLead.set(lead.key, { thread, lead: lead.key, members })
    for (const row of rest) hidden.add(row.key)
  }
  return byLead.size || hidden.size ? { byLead, hidden } : EMPTY_FOLD
}

/** A live conversation's state in the rail's status vocabulary. */
export function presenceThreadStatus(presence: AcpPresence): ThreadStatus {
  if (presence.status === "needs-permission") return { kind: "needs-permission", since: presence.createdAt }
  if (presence.status === "failed") return { kind: "failed", at: presence.createdAt }
  if (presence.status === "running" || presence.status === "starting")
    return { kind: "working", since: presence.createdAt }
  if (presence.status === "background") return { kind: "background", count: presence.background ?? 1 }
  return { kind: "idle" }
}

/**
 * A folded Thread's state in a live row's vocabulary, for a Thread whose row
 * is a conversation's (one on another device, or in the cloud): its folder's
 * chip and the rail's asks count the Thread, not only its first Session.
 */
export function presenceStatusOf(status: ThreadStatus): AcpPresence["status"] | undefined {
  switch (status.kind) {
    case "needs-permission":
      return "needs-permission"
    case "failed":
      return "failed"
    case "working":
    case "external-active":
      return "running"
    case "background":
      return "background"
    default:
      return undefined
  }
}

/** One Session of a folded Thread, as its row reports it. */
export interface FoldedSession {
  key: string
  harness: string
  status: ThreadStatus
}

/** What a folded row says about its Sessions together. */
export interface FoldedThreadState {
  /** The row's mark: the Session that most needs you, else one still going, else one with news. */
  status: ThreadStatus
  /** Every Session, in tab order. */
  sessions: readonly FoldedSession[]
  /** A Session has an answer you haven't read while the mark is about another. */
  readyBeside: boolean
  /** The rail's ordering priority: the most any one Session asks. */
  priority: number
}

/**
 * Which Session's state the row's mark shows. Unlike `threadStatusPriority`,
 * work still under way outranks an unread answer: a Thread with one Session
 * finished and another running isn't finished, and the finished answer is
 * still shown beside the mark.
 */
function markRank(status: ThreadStatus): number {
  switch (status.kind) {
    case "needs-permission":
      return 7
    case "failed":
      return 6
    case "working":
      return 5
    case "background":
      return 4
    case "external-active":
      return 3
    case "review":
      return status.unread ? 2 : 0
    case "observed":
      return 1
    case "external-open":
    case "idle":
      return 0
  }
}

export function unreadReview(status: ThreadStatus): boolean {
  return status.kind === "review" && status.unread
}

export function foldedThreadState(
  members: readonly FoldRow[],
  nativeStatus: (ref: ThreadRef) => ThreadStatus
): FoldedThreadState {
  const sessions = members.map((row): FoldedSession => ({
    key: row.key,
    harness: foldRowHarness(row),
    status: row.kind === "native" ? nativeStatus(row.ref) : presenceThreadStatus(row.presence),
  }))
  let status: ThreadStatus = { kind: "idle" }
  let priority = 0
  for (const session of sessions) {
    if (markRank(session.status) > markRank(status)) status = session.status
    priority = Math.max(priority, threadStatusPriority(session.status))
  }
  const readyBeside = !unreadReview(status) && sessions.some((session) => unreadReview(session.status))
  return { status, sessions, readyBeside, priority }
}

export function sameFoldedThreadState(left: FoldedThreadState | null, right: FoldedThreadState | null): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  return (
    left.readyBeside === right.readyBeside &&
    left.priority === right.priority &&
    sameThreadStatus(left.status, right.status) &&
    left.sessions.length === right.sessions.length &&
    left.sessions.every((session, index) => {
      const other = right.sessions[index]
      return other !== undefined && session.key === other.key && session.harness === other.harness && sameThreadStatus(session.status, other.status)
    })
  )
}

/** A Session's state in a few words, for the folded row's tip. */
export function sessionStateText(status: ThreadStatus): string {
  switch (status.kind) {
    case "working":
      return "working"
    case "background":
      return status.count === 1 ? "waiting on a background task" : `waiting on ${status.count} background tasks`
    case "external-active":
      return status.app ? `working in ${status.app}` : "working in another app"
    case "needs-permission":
      return "needs your approval"
    case "failed":
      return "failed"
    case "review":
      return status.unread ? "answer ready" : "done"
    case "observed":
      return "updated"
    case "external-open":
      return "open in another app"
    case "idle":
      return "idle"
  }
}

export function sessionRunning(status: ThreadStatus): boolean {
  return status.kind === "working" || status.kind === "external-active"
}

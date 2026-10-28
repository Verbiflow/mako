import type { ArchivedThread, ListedSession, ListedState } from "@mako/protocol/thread-listing"
import type { WaitingMessage } from "@mako/protocol/waiting"
import { CLOUD_FOLDER_WHERE, listedOwner, listedSummary, type ListedOwner } from "@mako/host/contracts/listed-conversations"
import type { LiveSummary } from "@mako/host/contracts/live-conversations"
import type { AccountListState, WebDevice } from "./account-list"

/** One Session of a Thread, as the phone lists it: its row, who answers it, and how a window lists it. */
export interface WebSession {
  row: ListedSession
  owner: ListedOwner
  /** The host's own mapping of the row (`listedSummary`), so a browser lists it as a Mac's window does. */
  summary: LiveSummary
  /** Where it runs, in words: "Studio", "the cloud". */
  where: string
  /** When the cloud last heard from its device, while that device is quiet. */
  quietSince?: string
  waiting: readonly WaitingMessage[]
}

/** How a Thread stands, its Sessions taken together: the one most for the person first. */
export type ThreadStanding = "waiting" | "failed" | "working" | "moving" | "idle"

/** A Thread as one row: every Session of it the account lists, folded by its Thread ID as a Mac folds them. */
export interface WebThread {
  id: string
  title: string
  /** Its Sessions, the one that started first first, as a Mac's tabs are ordered. */
  sessions: readonly WebSession[]
  standing: ThreadStanding
  /** What a waiting Session waits on, in its owner's words ("Approve: npm test"). */
  waitingOn?: string
  /** Where it runs: one place, or several when its Sessions run on more than one. */
  where: string
  /** The project folder's name, when its Sessions agree on one. */
  project?: string
  /** Its newest activity, in ms since the epoch. */
  activityAt: number
  quietSince?: string
  /** Messages waiting in the account for a Session of it whose device is off. */
  waitingMessages: number
  archived?: { move: string; archivedAt: string }
}

const STANDING_ORDER = { waiting: 0, failed: 1, working: 2, moving: 3, idle: 4 } satisfies Record<ThreadStanding, number>
export const CLOUD_WHERE = "the cloud"

/** The words for where a Session runs: its device's name, or the cloud. */
export function whereOf(row: ListedSession, devices: ReadonlyMap<string, WebDevice>): string {
  if (row.runsOn.kind === "cloud") return CLOUD_WHERE
  return devices.get(row.runsOn.deviceId)?.name ?? "another computer"
}

function standingOf(state: ListedState, quiet: boolean): ThreadStanding {
  // A quiet device's rows stand as it left them, none at work or waiting on the person (`QUIET_STATUS`).
  if (quiet && (state === "working" || state === "waiting")) return "idle"
  return state === "moving" ? "moving" : state
}

function projectOf(folder: string | undefined): string | undefined {
  if (!folder) return undefined
  const parts = folder.split("/").filter(Boolean)
  return parts.at(-1)
}

function sessionOf(row: ListedSession, list: Pick<AccountListState, "devices" | "quiet" | "waiting">): WebSession {
  const where = whereOf(row, list.devices)
  const quietSince = row.runsOn.kind === "device" ? list.quiet.get(row.runsOn.deviceId) : undefined
  const session: WebSession = {
    row,
    owner: listedOwner(row),
    summary: listedSummary(row, row.runsOn.kind === "cloud" ? CLOUD_FOLDER_WHERE : where, quietSince),
    where,
    waiting: list.waiting.get(row.session) ?? [],
  }
  if (quietSince) session.quietSince = quietSince
  return session
}

function fold(id: string, sessions: WebSession[], archived?: ArchivedThread): WebThread {
  sessions.sort((left, right) => Date.parse(left.row.createdAt) - Date.parse(right.row.createdAt))
  const lead = sessions[0]!
  let standing: ThreadStanding = "idle"
  let waitingOn: string | undefined
  let activityAt = 0
  let waitingMessages = 0
  const places = new Set<string>()
  const projects = new Set<string>()
  for (const session of sessions) {
    const own = archived ? "idle" : standingOf(session.row.state, session.quietSince !== undefined)
    if (STANDING_ORDER[own] < STANDING_ORDER[standing]) standing = own
    if (own === "waiting" && !waitingOn && session.row.waitingOn) waitingOn = session.row.waitingOn
    activityAt = Math.max(activityAt, Date.parse(session.row.activityAt))
    waitingMessages += session.waiting.length
    places.add(session.where)
    const project = projectOf(session.row.folder)
    if (project) projects.add(project)
  }
  const title = sessions.find((session) => session.row.threadTitle)?.row.threadTitle ?? lead.row.title ?? "New thread"
  const thread: WebThread = {
    id,
    title,
    sessions,
    standing,
    where: places.size === 1 ? [...places][0]! : `${places.size} places`,
    activityAt,
    waitingMessages,
  }
  if (waitingOn) thread.waitingOn = waitingOn
  if (projects.size === 1) thread.project = [...projects][0]!
  const quietSince = sessions.find((session) => session.quietSince)?.quietSince
  if (quietSince && sessions.every((session) => session.quietSince)) thread.quietSince = quietSince
  if (archived) thread.archived = { move: archived.move, archivedAt: archived.archivedAt }
  return thread
}

/** The account's Threads as the list shows them: the ones it follows, and the archived cloud Threads apart. */
export interface FoldedThreads {
  threads: WebThread[]
  archived: WebThread[]
}

/**
 * The account's Threads, one per Thread ID, the ones that need the person first, then the ones at work, then the rest
 * newest first. Archived cloud Threads are folded apart, as the account keeps them.
 */
export function foldThreads(list: Pick<AccountListState, "rows" | "devices" | "quiet" | "waiting" | "archived">): FoldedThreads {
  const byThread = new Map<string, WebSession[]>()
  for (const row of list.rows) {
    const sessions = byThread.get(row.thread)
    const session = sessionOf(row, list)
    if (sessions) sessions.push(session)
    else byThread.set(row.thread, [session])
  }
  const threads = [...byThread].map(([id, sessions]) => fold(id, sessions))
  threads.sort((left, right) => STANDING_ORDER[left.standing] - STANDING_ORDER[right.standing] || right.activityAt - left.activityAt)
  const archived = list.archived.flatMap((entry) => {
    const sessions = entry.sessions.map((row) => sessionOf(row, list))
    return sessions.length ? [fold(entry.sessions[0]!.thread, sessions, entry)] : []
  })
  return { threads, archived }
}

/** The conversation a Thread opens on: one waiting on the person first, then the newest at work, then its first. */
export function openingSession(thread: WebThread): WebSession {
  const waiting = thread.sessions.find((session) => session.row.state === "waiting" && !session.quietSince)
  if (waiting) return waiting
  const working = [...thread.sessions].reverse().find((session) => session.row.state === "working" && !session.quietSince)
  return working ?? thread.sessions[0]!
}

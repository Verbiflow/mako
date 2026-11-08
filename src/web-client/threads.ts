import type { ArchivedThread, ListedSession, ListedState } from "@mako/protocol/thread-listing"
import type { WaitingMessage } from "@mako/protocol/waiting"
import type { WaitingFor } from "@mako/protocol/attention"
import { CLOUD_FOLDER_WHERE, listedApexOf, listedOwner, listedPromptedAt, listedSummary, type ListedOwner } from "@mako/host/contracts/listed-conversations"
import { byLastWorked, staleTarget, type OpenedBy, type SessionFacts } from "@mako/host/contracts/session-choice"
import type { LiveSummary } from "@mako/host/contracts/live-conversations"
import { runPlace, type RunPlace } from "@mako/host/contracts/account-devices"
import type { AccountListState, WebDevice } from "./account-list"
import type { Owner } from "./start"

/** One Session of a Thread, as the phone lists it: its row, who answers it, and how a window lists it. */
export interface WebSession {
  row: ListedSession
  owner: ListedOwner
  /** The host's own mapping of the row (`listedSummary`), so a browser lists it as a Mac's window does. */
  summary: LiveSummary
  /** Where it runs, in words: "Studio", "the cloud". */
  where: string
  /** It runs on a machine of the person's own (a `runtime` device): its rows and bar wear a server, not a laptop. */
  machine?: true
  /** When the cloud last heard from its device, while that device is quiet. */
  quietSince?: string
  waiting: readonly WaitingMessage[]
  /** What every client knows of it, for the one rule that names, orders and picks a Thread's Sessions (`session-choice.ts`). */
  facts: SessionFacts
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
  /** What it waits on the person for, as its owner says: an approval, a question, or anything else. */
  waitingFor?: WaitingFor
  /** When the earliest of its Sessions at work last changed, as its owner said (`changedAt`): its run's start. */
  workingSince?: number
  /** Where it runs: one place, or several when its Sessions run on more than one. */
  where: string
  /** Every Session of it runs on a machine of the person's own. */
  machine?: true
  /** The project folder's name, when its Sessions agree on one. */
  project?: string
  /** Its newest activity, in ms since the epoch. */
  activityAt: number
  quietSince?: string
  /** Messages waiting in the account for a Session of it whose device is off. */
  waitingMessages: number
  archived?: { move: string; archivedAt: string }
  /**
   * It's a Fin of another Thread, placed on the device that lists it (`listedApexOf`): shown under that Apex, never as
   * a Thread of its own, and opened from there, its own device answering.
   */
  apex?: { thread: string; title: string }
}

/**
 * Which Session speaks for a Thread, and in what order the list puts them: one waiting on the person, then one at work
 * (which doesn't need them yet, but will), then one that failed, then the rest. A Thread with a Session at work and
 * another that failed reads as working: the failure is said once that work ends.
 */
const STANDING_ORDER = { waiting: 0, working: 1, moving: 2, failed: 3, idle: 4 } satisfies Record<ThreadStanding, number>
/** Among waiting Sessions: an approval first, then a question, then anything else the person is waited on for. */
const WAITING_ORDER = { approval: 0, question: 1, "needs-you": 2 } satisfies Record<WaitingFor, number>

/** How a waiting Thread ranks among waiting ones: what it asks of the person. */
export function waitingRank(thread: Pick<WebThread, "waitingFor">): number {
  return WAITING_ORDER[thread.waitingFor ?? "needs-you"]
}
export const CLOUD_WHERE = "the cloud"

/** The words for where a Session runs: its device's name, or the cloud. */
export function whereOf(row: ListedSession, devices: ReadonlyMap<string, WebDevice>): string {
  if (row.runsOn.kind === "cloud") return CLOUD_WHERE
  return devices.get(row.runsOn.deviceId)?.name ?? "another computer"
}

function standingOf(state: ListedState, quiet: boolean, moving: boolean): ThreadStanding {
  // On its way to the cloud from its first step, whatever its turn is doing: the move is what the person waits on.
  if (moving && !quiet) return "moving"
  // A quiet device's rows stand as it left them, none at work or waiting on the person (`QUIET_STATUS`).
  if (quiet && (state === "working" || state === "waiting")) return "idle"
  return state === "moving" ? "moving" : state
}

export function projectOf(folder: string | undefined): string | undefined {
  if (!folder) return undefined
  const parts = folder.split("/").filter(Boolean)
  return parts.at(-1)
}

/** One listed row as the browser holds it: who answers it, where it runs, and how a window lists it. */
export function sessionOf(row: ListedSession, list: Pick<AccountListState, "rows" | "devices" | "quiet" | "waiting">): WebSession {
  const where = whereOf(row, list.devices)
  const quietSince = row.runsOn.kind === "device" ? list.quiet.get(row.runsOn.deviceId) : undefined
  const deviceKind = row.runsOn.kind === "device" ? list.devices.get(row.runsOn.deviceId)?.kind : undefined
  const session: WebSession = {
    row,
    owner: listedOwner(row),
    summary: listedSummary(row, row.runsOn.kind === "cloud" ? CLOUD_FOLDER_WHERE : where, quietSince, deviceKind, listedApexOf(row, list.rows)),
    where,
    waiting: list.waiting.get(row.session) ?? [],
    facts: listedFacts(row, quietSince !== undefined),
  }
  if (quietSince) session.quietSince = quietSince
  if (runPlace(row.runsOn.kind === "cloud", deviceKind) === "machine") session.machine = true
  return session
}

/** A listed row as the one rule reads a Session: a terminal's session by its harness's own last write, as Mako saw no message of it. */
export function listedFacts(row: ListedSession, quiet: boolean): SessionFacts {
  const facts: SessionFacts = { id: row.session, harness: row.harness, state: row.state, createdAt: Date.parse(row.createdAt) }
  if (row.title) facts.title = row.title
  const promptedAt = listedPromptedAt(row)
  if (promptedAt !== undefined) facts.promptedAt = promptedAt
  if (row.capture) facts.harnessWroteAt = Date.parse(row.activityAt)
  if (quiet) facts.quiet = true
  if (row.forkOf) {
    facts.fork = true
    facts.forkOf = row.forkOf
  }
  return facts
}

function fold(id: string, sessions: WebSession[], archived?: ArchivedThread): WebThread {
  sessions.sort((left, right) => Date.parse(left.row.createdAt) - Date.parse(right.row.createdAt))
  const lead = sessions[0]!
  let standing: ThreadStanding = "idle"
  let waitingOn: string | undefined
  let waitingFor: WaitingFor | undefined
  let workingSince: number | undefined
  let activityAt = 0
  let waitingMessages = 0
  const places = new Set<string>()
  const projects = new Set<string>()
  for (const session of sessions) {
    const own = archived ? "idle" : standingOf(session.row.state, session.quietSince !== undefined, session.row.move !== undefined)
    if (STANDING_ORDER[own] < STANDING_ORDER[standing]) standing = own
    if (own === "waiting" && (waitingFor === undefined || WAITING_ORDER[session.row.waitingFor ?? "needs-you"] < WAITING_ORDER[waitingFor])) {
      waitingFor = session.row.waitingFor ?? "needs-you"
      if (session.row.waitingOn) waitingOn = session.row.waitingOn
    }
    if (own === "working" && session.row.changedAt) workingSince = Math.min(workingSince ?? Infinity, Date.parse(session.row.changedAt))
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
  if (standing === "waiting" && waitingFor) thread.waitingFor = waitingFor
  if (standing === "working" && workingSince !== undefined) thread.workingSince = workingSince
  if (projects.size === 1) thread.project = [...projects][0]!
  if (sessions.every((session) => session.machine)) thread.machine = true
  const quietSince = sessions.find((session) => session.quietSince)?.quietSince
  if (quietSince && sessions.every((session) => session.quietSince)) thread.quietSince = quietSince
  if (archived) thread.archived = { move: archived.move, archivedAt: archived.archivedAt }
  return thread
}

/**
 * The account's Threads as the list shows them: the ones it follows, the archived cloud Threads apart, and the Fins
 * placed on other devices, each under its Apex (`WebThread.apex`), never among the Threads.
 */
export interface FoldedThreads {
  threads: WebThread[]
  archived: WebThread[]
  placed: WebThread[]
}

/** The Thread a route or a row names, among the Threads, the Fins placed elsewhere and the archived. */
export function threadById(folded: FoldedThreads, named: (thread: WebThread) => boolean): WebThread | undefined {
  return folded.threads.find(named) ?? folded.placed.find(named) ?? folded.archived.find(named)
}

/** The Fins placed elsewhere under one Apex, waiting on the person first. */
export function placedUnder(folded: Pick<FoldedThreads, "placed">, apex: string): WebThread[] {
  return folded.placed.filter((thread) => thread.apex?.thread === apex)
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
  const folded = [...byThread].map(([id, sessions]) => fold(id, sessions))
  folded.sort((left, right) => STANDING_ORDER[left.standing] - STANDING_ORDER[right.standing] || (left.standing === "waiting" ? waitingRank(left) - waitingRank(right) : 0) || right.activityAt - left.activityAt)
  // A Fin placed on another device goes under its Apex, by the Apex's row that names it among its Fins; one no row
  // names stands on its own, since there's nothing to put it under.
  const titles = new Map(folded.map((thread) => [thread.id, thread.title]))
  const threads: WebThread[] = []
  const placed: WebThread[] = []
  for (const thread of folded) {
    const apex = thread.sessions.find((session) => session.summary.parent)?.summary.parent?.thread
    if (apex === undefined || apex === thread.id) threads.push(thread)
    else placed.push({ ...thread, apex: { thread: apex, title: titles.get(apex) ?? "its Apex" } })
  }
  const archived = list.archived.flatMap((entry) => {
    const sessions = entry.sessions.map((row) => sessionOf(row, list))
    return sessions.length ? [fold(entry.sessions[0]!.thread, sessions, entry)] : []
  })
  return { threads, archived, placed }
}

/** The conversation a Thread opens on: one waiting on the person first, then the newest at work, then its first. */
export function openingSession(thread: WebThread): WebSession {
  const waiting = thread.sessions.find((session) => session.row.state === "waiting" && !session.quietSince)
  if (waiting) return waiting
  const working = [...thread.sessions].reverse().find((session) => session.row.state === "working" && !session.quietSince)
  return working ?? thread.sessions[0]!
}

/** The Session to offer instead before a send to `session` asks first (`staleTarget`), if it does. */
export function newerThan(thread: WebThread, session: WebSession, now: number, openedBy: OpenedBy): WebSession | undefined {
  const newest = staleTarget(session.facts, thread.sessions.map((each) => each.facts), now, openedBy)
  return newest && thread.sessions.find((each) => each.facts === newest)
}

/** A Thread's Sessions newest first, by when the person last worked in each (`byLastWorked`). */
export function sessionsByLastWorked(thread: WebThread): WebSession[] {
  const order = new Map(byLastWorked(thread.sessions.map((session) => session.facts)).map((facts, index) => [facts, index]))
  return [...thread.sessions].sort((left, right) => order.get(left.facts)! - order.get(right.facts)!)
}

/** Who answers a Session's calls: its Mac, or its cloud Thread's machine. */
export function ownerOf(session: WebSession): Owner {
  return session.owner.kind === "cloud" ? { kind: "cloud", threadId: session.owner.threadId } : { kind: "mac", deviceId: session.owner.deviceId }
}

/** Where a Thread or Session runs, said in one line (`placeLine`): its words, and the glyph at their head. */
export interface PlaceLine {
  text: string
  place: RunPlace
}

/**
 * Where a Thread runs and its project, in the one order every screen says them: the device's name, then the project
 * ("build-box · mako"), with the place's glyph: a cloud, a server for a machine of the person's own, a laptop for a Mac.
 * The cloud isn't named (its glyph says it), and neither is the device where `named` is false (the list, while the
 * account has one); with nothing else to say, where it runs.
 */
export function placeLine(where: string, project: string | undefined, { named = true, machine = false }: { named?: boolean; machine?: boolean } = {}): PlaceLine {
  const cloud = where === CLOUD_WHERE
  const text = [cloud || !named ? undefined : where, project].filter(Boolean).join(" · ") || (cloud ? "Cloud" : where)
  return { text, place: cloud ? "cloud" : machine ? "machine" : "device" }
}

/** A Session's one line under its title: where it runs and the project (`placeLine`). */
export function subtitle(thread: WebThread, session: WebSession): string {
  return placeLine(session.where, thread.project, { machine: session.machine }).text
}

import { LISTED_PER_FRAME, LISTED_PER_OWNER, ReportedSessionSchema, rowsForLink, type ListedState, type ReportedSession, type SessionsReport } from "@mako/protocol/thread-listing"
import type { ThreadRef } from "@mako/sessions"
import type { LifecycleWork } from "../contracts/app-lifecycle.js"
import type { ExternalThreadActivity } from "../contracts/host-events-boot.js"
import type { LiveSummary } from "../contracts/live-conversations.js"
import type { SessionExecution } from "../contracts/thread-execution.js"
import { SessionIdSchema, ThreadIdSchema, type SessionId, type ThreadId, type ThreadPlacement } from "../contracts/thread-identity.js"
import { Payload, SESSIONS_VERSION, type RuntimeLink, type ServedRuntime } from "@mako/protocol"
import type { HostEvent } from "../contracts/host-events-boot.js"
import { encodeRuntimeEvent, runtimeEventLine, type RuntimeEvent, type RuntimeEventChannel } from "../contracts/runtime-value.js"
import { archivedByKeys, liveArchiveKeys } from "../contracts/thread-lifecycle.js"
import { namedUuid } from "./cloud-moves.js"
import { syncTier } from "./sync-window.js"

/** A rail row as the report reads it: a session one of this Mac's harnesses keeps, placed in its Thread and Session. */
export type NativeRow = Pick<ThreadRef, "harness" | "nativeId" | "path" | "cwd" | "title" | "startedAt" | "updatedAt" | "threadId" | "sessionId" | "archived" | "copyOnly" | "nativeArchived">

/** What the report reads of this host: its conversations, their work, the sessions its harnesses keep, and its Thread store. */
export type ReportSources = {
  /** Every conversation this host has, loaded or not (`LiveConversations.summaries`). */
  summaries(): readonly LiveSummary[]
  /**
   * Every session this Mac's harnesses keep that the sync window may take (`HostCatalog.recent`: moved within it, or a
   * Session of a Thread that did), the ones a terminal or another app runs included, each with the Thread and Session
   * the catalog placed it in; never cut to the rail's length. A Mako conversation's own session is among them.
   */
  native(): readonly NativeRow[]
  /** What a native session's process is doing, by its path, as the activity engine reads it. */
  activity(path: string): ExternalThreadActivity | undefined
  /** The lifecycle's work, which says which conversations work or wait (`lifecycleWork`). */
  work(): readonly LifecycleWork[]
  /** What a conversation waits on, in a line, while it waits. */
  waitingOn(conversationId: string): string | undefined
  /**
   * The keys of everything archived here (`ThreadArchives.snapshot().keys`), read once a report: a conversation whose
   * listing names one (`liveArchiveKeys`) is its owner's word, so every other device's list drops it too.
   */
  hidden(): ReadonlySet<string>
  /** When a conversation last moved (its journal's last write), if known; read again only once its revision moved. */
  lastMoved(conversationId: string, revision: number): number | undefined
  placement(conversationId: string): ThreadPlacement | undefined
  execution(session: SessionId): SessionExecution | undefined
  thread(id: ThreadId): { title?: string; titleSource?: string } | undefined
  now(): number
}

const iso = (ms: number) => new Date(ms).toISOString()
const line = (text: string) => (text.length > 200 ? `${text.slice(0, 199)}…` : text)

/** The conversation a native session is opened as when another device opens it: named from its Session, so two devices opening it at once open one. */
export function nativeConversation(session: string): string {
  return namedUuid(`mako native session conversation\0${session}`)
}

/** Whether a row's Session is at work: it goes first, and is listed whatever its age. */
export const busyRow = (row: Pick<ReportedSession, "state">) => row.state === "working" || row.state === "waiting" || row.state === "moving"

/** How a list ranks two rows of one Session: one at work over one at rest, then the one that moved last. */
function preferred(left: ReportedSession, right: ReportedSession): ReportedSession {
  if (busyRow(left) !== busyRow(right)) return busyRow(left) ? left : right
  return right.activityAt > left.activityAt ? right : left
}

/** Each Thread's last activity, as the newest of its rows': a Thread is in the window whole, its older Sessions too. */
export function threadActivity(rows: readonly Pick<ReportedSession, "thread" | "activityAt">[]): Map<string, string> {
  const newest = new Map<string, string>()
  for (const row of rows) if ((newest.get(row.thread) ?? "") < row.activityAt) newest.set(row.thread, row.activityAt)
  return newest
}

/**
 * The Sessions this host owns, as the account's list shows them, one row each: its conversations, closed ones
 * included, and the sessions its harnesses keep that Mako hasn't opened (a terminal's Claude Code, Cursor's editor,
 * Codex's CLI), each filed under a Session whose owner is here (or which is leaving here, or released and not yet
 * claimed: `moving`), at the generation the store holds. Those of every Thread in the sync window, whole, and any at
 * work now (`syncTier`): the ones at work first, then by their Thread's last activity, then their own, newest first.
 * A Session that runs elsewhere is the other owner's to say; an archived conversation isn't listed, nor is a session
 * its harness deleted or archived.
 */
export function ownedSessions(sources: ReportSources): ReportedSession[] {
  const work = new Map(sources.work().map((item) => [item.id, item.status]))
  const now = sources.now()
  const bySession = new Map<string, ReportedSession>()
  const add = (row: ReportedSession) => {
    const held = bySession.get(row.session)
    bySession.set(row.session, held ? preferred(held, row) : row)
  }
  // Every path a conversation of this host reads, closed ones included: its session is that conversation's to list.
  const opened = new Set<string>()
  const summaries = sources.summaries()
  for (const summary of summaries) {
    if (summary.threadPath) opened.add(summary.threadPath)
    for (const path of summary.nativePaths ?? []) opened.add(path)
  }
  const hidden = sources.hidden()
  for (const summary of summaries) {
    const { session } = summary
    // A closed conversation is the person's still: another device's message reopens it (`reopenClosed`). An archived one
    // is read off the listing, never by loading the journal: this is a pure function of what the host already holds.
    if (archivedByKeys(liveArchiveKeys(summary), hidden, undefined)) continue
    const placed = sources.placement(session.id)
    if (!placed) continue
    const execution = sources.execution(placed.session)
    if (execution?.state === "elsewhere") continue
    const working = work.get(session.id)
    const state: ListedState = execution?.state === "leaving" || execution?.state === "in-transit" ? "moving"
      : working === "waiting" ? "waiting"
      : working ? "working"
      : session.status === "failed" ? "failed"
      : session.status === "running" || session.status === "starting" ? "working"
      : "idle"
    const movedAt = Math.max(summary.createdAt, sources.lastMoved(session.id, summary.revision) ?? 0)
    const row: ReportedSession = {
      session: placed.session,
      thread: placed.thread,
      conversation: session.id,
      harness: session.harness,
      state,
      createdAt: iso(summary.createdAt),
      activityAt: iso(movedAt),
      generation: execution?.generation ?? 1,
    }
    const thread = sources.thread(placed.thread)
    // A title the person or Mako gave the Thread; an older build's automatic one isn't shown anywhere.
    if (thread?.title && thread.titleSource !== "auto") row.threadTitle = line(thread.title)
    if (session.title) row.title = line(session.title)
    if (state === "waiting") {
      const on = sources.waitingOn(session.id)
      if (on) row.waitingOn = line(on)
    }
    if (session.cwd) row.folder = session.cwd
    if (session.nativeId) row.nativeId = session.nativeId
    // A harness or ID the protocol can't carry is left out, never the rest.
    const parsed = ReportedSessionSchema.safeParse(row)
    if (parsed.success) add(parsed.data)
  }
  const conversations = new Set(bySession.keys())
  for (const ref of sources.native()) {
    if (ref.archived || ref.copyOnly || ref.nativeArchived || !ref.updatedAt) continue
    const sessionId = SessionIdSchema.safeParse(ref.sessionId)
    const threadId = ThreadIdSchema.safeParse(ref.threadId)
    if (!sessionId.success || !threadId.success) continue
    if (conversations.has(sessionId.data) || opened.has(ref.path)) continue
    const execution = sources.execution(sessionId.data)
    if (execution?.state === "elsewhere") continue
    const activity = sources.activity(ref.path)
    const state: ListedState = execution?.state === "leaving" || execution?.state === "in-transit" ? "moving"
      : activity?.status === "needs-input" ? "waiting"
      : activity?.status === "active" ? "working"
      : "idle"
    const movedAt = Date.parse(ref.updatedAt)
    if (!Number.isFinite(movedAt)) continue
    const startedAt = ref.startedAt ? Date.parse(ref.startedAt) : Number.NaN
    const row: ReportedSession = {
      session: sessionId.data,
      thread: threadId.data,
      conversation: nativeConversation(sessionId.data),
      harness: ref.harness,
      state,
      createdAt: iso(Number.isFinite(startedAt) ? Math.min(startedAt, movedAt) : movedAt),
      activityAt: iso(movedAt),
      generation: execution?.generation ?? 1,
      nativeId: ref.nativeId,
      capture: { path: ref.path },
    }
    const thread = sources.thread(threadId.data)
    if (thread?.title && thread.titleSource !== "auto") row.threadTitle = line(thread.title)
    if (ref.title) row.title = line(ref.title)
    if (state === "waiting" && activity?.detail) row.waitingOn = line(activity.detail)
    if (ref.cwd) row.folder = ref.cwd
    const parsed = ReportedSessionSchema.safeParse(row)
    if (parsed.success) add(parsed.data)
  }
  const rows = [...bySession.values()]
  const threads = threadActivity(rows)
  const tiered = rows.filter((row) => syncTier(Date.parse(threads.get(row.thread) ?? row.activityAt), busyRow(row), now) !== undefined)
  return tiered.sort((left, right) => syncOrder(left, right, threads)).slice(0, LISTED_PER_OWNER)
}

/** The order Sessions go in: the ones at work first, then by their Thread's last activity, then their own, newest first. */
export function syncOrder(left: ReportedSession, right: ReportedSession, threads: ReadonlyMap<string, string>): number {
  if (busyRow(left) !== busyRow(right)) return busyRow(left) ? -1 : 1
  const byThread = (threads.get(right.thread) ?? right.activityAt).localeCompare(threads.get(left.thread) ?? left.activityAt)
  return byThread || right.activityAt.localeCompare(left.activityAt)
}

/** Whether two rows say the same, so an unchanged one isn't sent again. */
function sameRow(left: ReportedSession | undefined, right: ReportedSession): boolean {
  return left !== undefined && left.session === right.session && left.thread === right.thread && left.threadTitle === right.threadTitle && left.conversation === right.conversation &&
    left.harness === right.harness && left.title === right.title && left.state === right.state && left.waitingOn === right.waitingOn &&
    left.folder === right.folder && left.createdAt === right.createdAt && left.activityAt === right.activityAt && left.generation === right.generation &&
    left.nativeId === right.nativeId && left.capture?.path === right.capture?.path
}

/**
 * Turns what this host owns into reports for its link: on a new link, every Session it owns by ID and generation
 * (`owned`, so the list drops what it no longer has), then its rows in batches; after that only what changed, and
 * what left (`gone`). What a link was sent is forgotten with it: the next one hears everything again.
 */
export class SessionReporter {
  #link: RuntimeLink | undefined
  readonly #sent = new Map<string, ReportedSession>()

  /** The reports to send now on `link`, in order; none when nothing changed. */
  reports(link: RuntimeLink, rows: readonly ReportedSession[]): SessionsReport[] {
    const fresh = link !== this.#link
    if (fresh) {
      this.#link = link
      this.#sent.clear()
    }
    const now = new Map(rows.map((row) => [row.session, row]))
    const changed = rows.filter((row) => !sameRow(this.#sent.get(row.session), row))
    const gone = [...this.#sent.values()].filter((row) => !now.has(row.session)).map(({ session, generation }) => ({ session, generation }))
    if (!fresh && !changed.length && !gone.length) return []
    const batches: SessionsReport[] = []
    for (let start = 0; start < Math.max(changed.length, 1); start += LISTED_PER_FRAME) batches.push({ listed: changed.slice(start, start + LISTED_PER_FRAME), gone: [] })
    batches[0]!.gone = gone
    if (fresh) batches[0]!.owned = rows.map(({ session, generation }) => ({ session, generation }))
    return batches
  }

  /** The reports went: they're what the link holds now. */
  sent(rows: readonly ReportedSession[]): void {
    this.#sent.clear()
    for (const row of rows) this.#sent.set(row.session, row)
  }

  /** A report didn't go: the next one starts over, as on a new link. */
  forget(): void {
    this.#link = undefined
    this.#sent.clear()
  }
}

/** The runtime link a host serves its Sessions on, while it's up: the link itself (one per connection), and what serves on it. */
export type SessionLink = { link: RuntimeLink; served: Pick<ServedRuntime, "version" | "sessions" | "live"> }

/** Recomputed at most this often while things change, and at least this often regardless (a rename, a move's step). */
const REPORT_MS = 1_000
const SWEEP_MS = 30_000

/**
 * What a host tells the cloud of its Sessions, on whichever link it serves: the list's rows when they change (nothing
 * while nothing does; a sweep every half minute catches what moves without an event), and a conversation's live updates
 * while another device watches it. A Mac and a cloud machine run the same one. What's watched belongs to the link it was
 * said on, so a reconnect never carries an old link's watchers onto a new one.
 */
export class SessionPublisher {
  readonly #reporter = new SessionReporter()
  readonly #rows: () => readonly ReportedSession[] | undefined
  readonly #now: () => number
  #current: SessionLink | undefined
  #watching: { link: RuntimeLink; conversations: ReadonlySet<string> } | undefined
  #dirty = true
  #reportedAt = Number.NEGATIVE_INFINITY
  #listed: readonly ReportedSession[] | undefined

  constructor(options: { rows: () => readonly ReportedSession[] | undefined; now?: () => number }) {
    this.#rows = options.rows
    this.#now = options.now ?? Date.now
  }

  /** The Sessions the account lists of this host as last worked out, every link's version alike; undefined until then. */
  listed(): readonly ReportedSession[] | undefined {
    return this.#listed
  }

  /** Something a row may show changed: a batch, a move, a rename. */
  changed(): void {
    this.#dirty = true
  }

  /** Reports on the current link what changed since the last report there; called on the host's tick. */
  report(current: SessionLink | undefined): void {
    if (current?.link !== this.#current?.link) this.#dirty = true
    this.#current = current
    if (!current || current.served.version < SESSIONS_VERSION) return
    const now = this.#now()
    if (now - this.#reportedAt < REPORT_MS || (!this.#dirty && now - this.#reportedAt < SWEEP_MS)) return
    const all = this.#rows()
    if (!all) return
    this.#listed = all
    const rows = rowsForLink(all, current.served.version)
    this.#dirty = false
    this.#reportedAt = now
    const reports = this.#reporter.reports(current.link, rows)
    if (!reports.length) return
    if (reports.every((report) => current.served.sessions(report))) this.#reporter.sent(rows)
    else this.#reporter.forget()
  }

  /** The gateway says which of this host's conversations another device watches, on `link`: the whole set. */
  watch(link: RuntimeLink, conversations: readonly string[]): void {
    this.#watching = { link, conversations: new Set(conversations) }
  }

  /** One of the host's outgoing events, encoded: a watched conversation's batch goes to its watchers, and every batch may change a row. */
  event(channel: RuntimeEventChannel, event: RuntimeEvent): void {
    if (channel !== "event") return
    if (event.type === "live-batch") this.#dirty = true
    const conversation = event.conversation
    const current = this.#watched(conversation)
    if (!conversation || !current) return
    current.served.live(conversation, Payload.encoded(runtimeEventLine(channel, event).slice(0, -1)))
  }

  /**
   * One of this host's own events, as its conversations emit it: a batch may change a row, and a watched conversation's
   * goes to its watchers, encoded only then, so an event nobody elsewhere watches costs nothing.
   */
  own(event: HostEvent): void {
    if (event.type !== "live-batch") return
    this.#dirty = true
    if (this.#watched(event.batch.id)) this.event("event", encodeRuntimeEvent(event))
  }

  /** The current link, when another device watches `conversation` on it. */
  #watched(conversation: string | undefined): SessionLink | undefined {
    const current = this.#current
    if (!conversation || !current || this.#watching?.link !== current.link || !this.#watching.conversations.has(conversation)) return undefined
    return current
  }
}

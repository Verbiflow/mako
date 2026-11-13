import { LISTED_ASK_OPTIONS, LISTED_LINEAGE, LISTED_PER_FRAME, LISTED_PER_OWNER, ReportedSessionSchema, rowsForLink, sameHead, type ListedAsking, type ListedHead, type ListedMove, type ListedState, type ReportedSession, type SessionsReport } from "@mako/protocol/thread-listing"
import type { ThreadRef } from "@mako/sessions"
import { finAskWaiting } from "../contracts/children.js"
import type { FinAsk } from "../contracts/native-agents.js"
import type { LifecycleWork } from "../contracts/app-lifecycle.js"
import type { CheckoutHead } from "../contracts/checkout-heads.js"
import { projectFolder } from "../contracts/worktree-paths.js"
import { listedAsThread } from "../contracts/thread-list.js"
import { nativeStartedAt } from "../contracts/worked-at.js"
import type { ExternalThreadActivity } from "../contracts/host-events-boot.js"
import type { LiveSummary } from "../contracts/live-conversations.js"
import type { SessionExecution } from "../contracts/thread-execution.js"
import { SessionIdSchema, ThreadIdSchema, type SessionId, type ThreadId, type ThreadPlacement } from "../contracts/thread-identity.js"
import { COMPACT_LIVE_FORM, COMPACT_LIVE_VERSION, Payload, SESSIONS_VERSION, WHOLE_LIVE_FORM, type LiveForm, type RuntimeLink, type ServedRuntime } from "@mako/protocol"
import type { HostWork } from "../base/event-loop.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import { encodeRuntimeEvent, type RuntimeEvent, type RuntimeEventChannel } from "../contracts/runtime-value.js"
import { gatewayCompactLine, gatewayEventLine, historyChangedNotice } from "../transport/index.js"
import type { OwnerReading } from "../contracts/sync-readings.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { archivedByKeys, liveArchiveKeys } from "../contracts/thread-lifecycle.js"
import { namedUuid } from "./cloud-moves.js"
import { syncTier } from "./sync-window.js"
import { asks, needsYouWaiting, type Waiting } from "@mako/protocol/attention"

/** A rail row as the report reads it: a session one of this Mac's harnesses keeps, placed in its Thread and Session. */
export type NativeRow = Pick<ThreadRef, "harness" | "nativeId" | "path" | "cwd" | "workspace" | "worktrees" | "lineage" | "title" | "startedAt" | "updatedAt" | "threadId" | "sessionId" | "archived" | "copyOnly" | "nativeArchived" | "locked" | "heldBy" | "parent">

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
  /** What a conversation waits on, and its line, while it waits (`LiveConversations.waitingOn`). */
  waitingOn(conversationId: string): Waiting | undefined
  /**
   * The keys of everything archived here (`ThreadArchives.snapshot().keys`), read once a report: a conversation whose
   * listing names one (`liveArchiveKeys`) is its owner's word, so every other device's list drops it too.
   */
  hidden(): ReadonlySet<string>
  /** When a conversation last moved (its journal's last write), if known; read again only once its revision moved. */
  lastMoved(conversationId: string, revision: number): number | undefined
  placement(conversationId: string): ThreadPlacement | undefined
  /** The Session's place among its Thread's Sessions as this host's store keeps them (`ReportedSession.order`); undefined where unknown. */
  sessionOrder?(placement: ThreadPlacement): number | undefined
  /** Whether a Thread is a child's whose Apex is here (`listedUnderApex`): it goes up inside its parent's Thread, never as a row. */
  childThread?(thread: ThreadId): boolean
  /**
   * Who may execute each of these Sessions (`ThreadStore.executionsOf`), asked once a report for every row's Session,
   * so a report reads the store once however many rows it has, and not at all while nothing was committed.
   */
  executions(sessions: readonly SessionId[]): ReadonlyMap<SessionId, SessionExecution>
  /** Each of these Threads' names (`ThreadStore.titlesOf`), asked once a report as `executions` is. */
  titles(threads: readonly ThreadId[]): ReadonlyMap<ThreadId, { title?: string; titleSource?: string }>
  /** The Session each of these that is a fork was forked from (`ThreadStore.forksOf`), asked once a report as `executions` is. */
  forks?(sessions: readonly SessionId[]): ReadonlyMap<SessionId, SessionId>
  /** A move of this Thread to the cloud under way here (`MovesUnderWay`), said on each of its rows while it goes. */
  moving?(thread: ThreadId): ListedMove | undefined
  /**
   * The Thread worktree a folder is in, if it is in one this Mac made: the project folder it stands for on the rail
   * (`projectFolder` over the Thread store's worktrees) and its branch. Read from what the store holds.
   */
  worktree?(folder: string): { project: string; branch: string } | undefined
  /**
   * What a project folder has checked out, as far as this host has read it (`CheckoutHeadService.known`); undefined
   * until then, and the source starts reading it, so a later report says it.
   */
  head?(project: string): CheckoutHead | null | undefined
  /**
   * A Thread worktree's origin on GitHub and the branch it pushes to, as far as this host has read them; undefined
   * until then (or for one with neither), and the source starts reading them, so a later report says them.
   */
  repository?(folder: string): ReportedSession["repository"]
  /** How many things a conversation whose turn ended still waits on (`backgroundWork`); undefined while none. */
  background?(conversationId: string): number | undefined
  /** What one of a conversation's Fins asks the person, which its row waits on (`finAsking`). */
  asking?(conversationId: string): FinAsking | undefined
  /** What a conversation's agent asked through Mako's tools, which its row waits on (`LiveConversations.askWaiting`). */
  asked?(conversationId: string): Waiting | undefined
  /** A conversation's Fins, as its roster lists them for every other device (`listedFins`). */
  fins?(conversationId: string): ReportedSession["fins"]
  now(): number
}

/** A Fin's ask on its Apex's row: what the row waits on, and the ask a phone answers in a tap. */
export type FinAsking = { waiting: Waiting; asking: Omit<ListedAsking, "under"> }

/** What the person's row says of a Fin's ask that's theirs (`Agents.personAsk`): the Fin's name before its line. */
export function finAsking(found: { fin: ThreadId; name: string; line: string; ask: FinAsk; more: number } | undefined): FinAsking | undefined {
  if (!found) return undefined
  const options = found.ask.options?.slice(0, LISTED_ASK_OPTIONS).map((option) => (option.label.length > 80 ? `${option.label.slice(0, 79)}…` : option.label))
  const asking: FinAsking["asking"] = { fin: found.fin, name: found.name.slice(0, 200), ask: found.ask.id }
  if (options?.length) asking.options = options
  if (options && found.ask.recommended !== undefined && found.ask.recommended < options.length) asking.recommended = found.ask.recommended
  if (found.more) asking.more = found.more
  const waiting = finAskWaiting(found.ask, found.name, found.line)
  return { waiting: { for: waiting.for, line: line(waiting.line) }, asking }
}

const iso = (ms: number) => new Date(ms).toISOString()
const line = (text: string) => (text.length > 200 ? `${text.slice(0, 199)}…` : text)

/** The conversation a native session is opened as when another device opens it: named from its Session, so two devices opening it at once open one. */
export function nativeConversation(session: string): string {
  return namedUuid(`mako native session conversation\0${session}`)
}

/** Whether a row's Session is at work, or its Thread on its way: it goes first, and is listed whatever its age. */
export const busyRow = (row: Pick<ReportedSession, "state" | "move">) => row.state === "working" || row.state === "waiting" || row.state === "moving" || row.move !== undefined

/** How a list ranks two rows of one Session: one at work over one at rest, then the one that moved last. */
function preferred(left: ReportedSession, right: ReportedSession): ReportedSession {
  if (busyRow(left) !== busyRow(right)) return busyRow(left) ? left : right
  return right.activityAt > left.activityAt ? right : left
}

/** What a list shows of a conversation that its own turns move: where it stands, its title, what it waits on, and its background work. */
export type ConversationShown = Pick<ReportedSession, "state" | "title" | "waitingOn" | "waitingFor" | "background" | "promptedAt" | "asking" | "fins">

/**
 * What a conversation waits on the person for, by the one rule every surface asks by: what it names (an approval, a
 * question, `waitingOn`), else, while its lifecycle has it waiting on the person with nothing more to say, needs-you.
 * Undefined when nothing it says asks (`asks`, the protocol's own predicate).
 */
export function personWaiting(said: Waiting | undefined, working: LifecycleWork["status"] | undefined): Waiting | undefined {
  const waiting = said ?? (working === "waiting" ? needsYouWaiting(undefined) : undefined)
  return waiting && asks(waiting.for) ? waiting : undefined
}

/**
 * What a list shows of one of this host's conversations that its own turns move, as its row says it: each conversation's
 * row is made with this (`ownedSessions`), and each of its batches is checked against it (`SessionPublisher.own`), so
 * whether a batch moved anything a list shows is decided by the row's own rule, never a second one. `working` is the
 * lifecycle's word on it; `execution`, when known, whether it's leaving this host; `background`, what its ended turn
 * left running, said only while that's why it's at work; `promptedAt`, the person's last message to it
 * (`personPromptedAt`), which moves its project on every rail, a steer into a running turn included.
 */
export function conversationShown(conversation: {
  session: Pick<LiveSummary["session"], "id" | "status" | "title">
  working: LifecycleWork["status"] | undefined
  execution?: SessionExecution | undefined
  waitingOn: (conversationId: string) => Waiting | undefined
  background?: number | undefined
  promptedAt?: number | undefined
  asking?: ((conversationId: string) => FinAsking | undefined) | undefined
  /** What its agent asked through Mako's tools (`LiveConversations.askWaiting`). */
  asked?: ((conversationId: string) => Waiting | undefined) | undefined
  fins?: ((conversationId: string) => ReportedSession["fins"]) | undefined
}): ConversationShown {
  const { session, working, execution } = conversation
  const state: ListedState = execution?.state === "leaving" || execution?.state === "in-transit" ? "moving"
    : working === "waiting" ? "waiting"
    : working ? "working"
    : session.status === "failed" ? "failed"
    : session.status === "running" || session.status === "starting" ? "working"
    : "idle"
  const shown: ConversationShown = { state }
  if (session.title) shown.title = line(session.title)
  if (conversation.promptedAt !== undefined) shown.promptedAt = iso(conversation.promptedAt)
  if (state === "working" && session.status !== "running" && session.status !== "starting" && conversation.background) shown.background = conversation.background
  if (state === "waiting") {
    // A native agent of its waiting on the person says nothing more than that it does.
    const on = personWaiting(conversation.waitingOn(session.id), working) ?? needsYouWaiting(undefined)
    shown.waitingOn = on.line
    shown.waitingFor = on.for
  }
  // Its own ask goes first; a Fin's waits behind it, and a move says nothing more.
  const under = state === "working" || state === "idle" || state === "failed" ? state : undefined
  // What its agent asked through Mako's tools leaves it working or idle, and waits on the person all the same.
  const asked = under && conversation.asked?.(session.id)
  const fin = under && !asked && conversation.asking?.(session.id)
  if (asked) {
    shown.state = "waiting"
    shown.waitingOn = asked.line
    shown.waitingFor = asked.for
    delete shown.background
  } else if (fin) {
    shown.state = "waiting"
    shown.waitingOn = fin.waiting.line
    shown.waitingFor = fin.waiting.for
    shown.asking = { ...fin.asking, under }
    delete shown.background
  }
  const fins = conversation.fins?.(session.id)
  if (fins) shown.fins = fins
  return shown
}

/** A checkout's head as a list says it: what it has checked out, without where its worktree's main checkout is. */
export function listedHead(head: CheckoutHead): ListedHead {
  return head.kind === "detached" ? { kind: "detached", commit: head.commit } : { kind: head.kind, name: head.name }
}

/**
 * The harnesses a Session ran in before `harness`, oldest first, each once in a row, as its rail row wears them: from
 * every harness it ran in, in order, the current one last.
 */
export function earlierHarnesses(ran: readonly string[], harness: string): string[] {
  const order: string[] = []
  for (const each of ran) if (order.at(-1) !== each) order.push(each)
  if (order.at(-1) === harness) order.pop()
  return order.slice(-LISTED_LINEAGE)
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
  // Every path a conversation of this host reads, closed ones included: its session is that conversation's to list.
  const opened = new Set<string>()
  const summaries = sources.summaries()
  for (const summary of summaries) {
    if (summary.threadPath) opened.add(summary.threadPath)
    for (const path of summary.nativePaths ?? []) opened.add(path)
  }
  const hidden = sources.hidden()
  // The rows that may be listed, each placed in its Thread and Session; what the store says of those is read for all
  // of them at once below.
  const conversations: { summary: LiveSummary; placed: ThreadPlacement }[] = []
  for (const summary of summaries) {
    // A closed conversation is the person's still: another device's message reopens it (`reopenClosed`). An archived one
    // is read off the listing, never by loading the journal: this is a pure function of what the host already holds.
    if (archivedByKeys(liveArchiveKeys(summary), hidden, undefined)) continue
    const placed = sources.placement(summary.session.id)
    if (!placed || sources.childThread?.(placed.thread)) continue
    conversations.push({ summary, placed })
  }
  const natives: { ref: NativeRow; session: SessionId; thread: ThreadId }[] = []
  for (const ref of sources.native()) {
    if (ref.archived || ref.copyOnly || ref.nativeArchived || !ref.updatedAt) continue
    // A child's Session is listed inside its parent's Thread, as that Thread's roster, never as a row.
    if (!listedAsThread(ref)) continue
    const sessionId = SessionIdSchema.safeParse(ref.sessionId)
    const threadId = ThreadIdSchema.safeParse(ref.threadId)
    if (!sessionId.success || !threadId.success) continue
    if (opened.has(ref.path)) continue
    natives.push({ ref, session: sessionId.data, thread: threadId.data })
  }
  const placedSessions = [...conversations.map(({ placed }) => placed.session), ...natives.map(({ session }) => session)]
  const executions = sources.executions(placedSessions)
  const forks = sources.forks?.(placedSessions)
  const titles = sources.titles([...new Set([...conversations.map(({ placed }) => placed.thread), ...natives.map(({ thread }) => thread)])])
  // What the rail shows of a row besides its state: the project it's filed under and what that has checked out, the
  // worktree it works in, and the agents it ran in before.
  const rail = (folder: string | undefined, worktrees: NativeRow["worktrees"], lineage: readonly string[], harness: string): Pick<ReportedSession, "project" | "worktree" | "lineage" | "repository"> => {
    const fields: Pick<ReportedSession, "project" | "worktree" | "lineage" | "repository"> = {}
    if (folder) {
      const made = sources.worktree?.(folder)
      const project = made?.project ?? projectFolder(worktrees, folder) ?? folder
      const head = sources.head?.(project)
      fields.project = head ? { folder: project, head: listedHead(head) } : { folder: project }
      if (made) fields.worktree = { branch: made.branch }
      const repository = made && sources.repository?.(folder)
      if (repository) fields.repository = repository
    }
    const earlier = earlierHarnesses(lineage, harness)
    if (earlier.length) fields.lineage = earlier
    return fields
  }
  // A title the person or Mako gave the Thread; an older build's automatic one isn't shown anywhere.
  const threadTitle = (thread: ThreadId) => {
    const found = titles.get(thread)
    return found?.title && found.titleSource !== "auto" ? line(found.title) : undefined
  }

  const bySession = new Map<string, ReportedSession>()
  const add = (row: ReportedSession) => {
    const held = bySession.get(row.session)
    bySession.set(row.session, held ? preferred(held, row) : row)
  }
  for (const { summary, placed } of conversations) {
    const { session } = summary
    const execution = executions.get(placed.session)
    if (execution?.state === "elsewhere") continue
    const shown = conversationShown({ session, working: work.get(session.id), execution, waitingOn: sources.waitingOn, background: sources.background?.(session.id), promptedAt: summary.promptedAt, asking: sources.asking, fins: sources.fins })
    const movedAt = Math.max(summary.createdAt, sources.lastMoved(session.id, summary.revision) ?? 0)
    const row: ReportedSession = {
      session: placed.session,
      thread: placed.thread,
      conversation: session.id,
      harness: session.harness,
      ...shown,
      createdAt: iso(summary.createdAt),
      activityAt: iso(movedAt),
      generation: execution?.generation ?? 1,
    }
    const titled = threadTitle(placed.thread)
    if (titled) row.threadTitle = titled
    const move = sources.moving?.(placed.thread)
    if (move) row.move = move
    if (session.cwd) row.folder = session.cwd
    if (session.nativeId) row.nativeId = session.nativeId
    const forkOf = forks?.get(placed.session)
    if (forkOf) row.forkOf = forkOf
    const order = sources.sessionOrder?.(placed)
    if (order !== undefined) row.order = order
    Object.assign(row, rail(session.cwd || undefined, undefined, (summary.nativeIds ?? []).map((id) => id.provider), session.harness))
    // A harness or ID the protocol can't carry is left out, never the rest.
    const parsed = ReportedSessionSchema.safeParse(row)
    if (parsed.success) add(parsed.data)
  }
  const listedConversations = new Set(bySession.keys())
  for (const { ref, session, thread } of natives) {
    if (listedConversations.has(session)) continue
    const execution = executions.get(session)
    if (execution?.state === "elsewhere") continue
    const activity = sources.activity(ref.path)
    const state: ListedState = execution?.state === "leaving" || execution?.state === "in-transit" ? "moving"
      : activity?.status === "needs-input" ? "waiting"
      : activity?.status === "active" ? "working"
      : "idle"
    const movedAt = Date.parse(ref.updatedAt ?? "")
    const startedAt = nativeStartedAt(ref)
    if (!Number.isFinite(movedAt) || startedAt === undefined) continue
    const row: ReportedSession = {
      session,
      thread,
      conversation: nativeConversation(session),
      harness: ref.harness,
      state,
      createdAt: iso(startedAt),
      activityAt: iso(movedAt),
      generation: execution?.generation ?? 1,
      nativeId: ref.nativeId,
      capture: { path: ref.path },
    }
    const titled = threadTitle(thread)
    if (titled) row.threadTitle = titled
    const move = sources.moving?.(thread)
    if (move) row.move = move
    if (ref.title) row.title = line(ref.title)
    const forkOf = forks?.get(session)
    if (forkOf) row.forkOf = forkOf
    // The hollow ring this Mac's rail draws (`threadStatus`): its harness's app holds it, not another Mako host.
    if (state === "idle" && !ref.heldBy && (activity?.status === "open" || ref.locked)) row.openElsewhere = true
    if (state === "waiting") {
      // A terminal's harness says only that it waits for input, in its own words when it has some.
      const on = needsYouWaiting(activity?.detail)
      row.waitingOn = on.line
      row.waitingFor = on.for
    }
    if (ref.cwd) row.folder = ref.cwd
    Object.assign(row, rail(ref.workspace ?? ref.cwd, ref.worktrees, (ref.lineage ?? []).map((origin) => origin.harness), ref.harness))
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

/** A Session's place among its Thread's Sessions, as the store that owns the Thread keeps them: what its row says as `order`. */
export function sessionOrderIn(sessions: readonly string[] | undefined, session: string): number | undefined {
  const at = sessions?.indexOf(session) ?? -1
  return at >= 0 ? at : undefined
}

/** Whether two rows show the same but for when they last moved. */
function sameShown(left: ReportedSession, right: ReportedSession): boolean {
  return left.session === right.session && left.thread === right.thread && left.threadTitle === right.threadTitle && left.conversation === right.conversation &&
    left.harness === right.harness && left.title === right.title && left.state === right.state && left.waitingOn === right.waitingOn && left.waitingFor === right.waitingFor &&
    left.folder === right.folder && left.createdAt === right.createdAt && left.generation === right.generation &&
    left.nativeId === right.nativeId && left.capture?.path === right.capture?.path && left.background === right.background &&
    left.project?.folder === right.project?.folder && sameHead(left.project?.head, right.project?.head) &&
    left.worktree?.branch === right.worktree?.branch && (left.lineage ?? []).join("\0") === (right.lineage ?? []).join("\0") &&
    left.promptedAt === right.promptedAt && left.openElsewhere === right.openElsewhere && left.forkOf === right.forkOf && left.order === right.order &&
    JSON.stringify(left.asking) === JSON.stringify(right.asking) && JSON.stringify(left.fins) === JSON.stringify(right.fins)
}

/**
 * A row's last activity alone is said at most this often. It moves with every batch a conversation streams, and a list
 * shows it to the minute at most; said each time, it was half the account's events (each a write there and work on
 * every device). With anything else a list shows, it goes at once.
 */
export const ACTIVITY_REPORT_MS = 60_000

/**
 * The row the link holds after `row` is reported over `sent`: `sent` still, when all that moved is the row's last
 * activity, less than `ACTIVITY_REPORT_MS` on. Its repository isn't shown, but a continue clones what it says.
 */
function held(sent: ReportedSession | undefined, row: ReportedSession): ReportedSession {
  if (!sent || !sameShown(sent, row) || sent.repository?.url !== row.repository?.url || sent.repository?.branch !== row.repository?.branch) return row
  return Date.parse(row.activityAt) - Date.parse(sent.activityAt) < ACTIVITY_REPORT_MS ? sent : row
}

/**
 * Turns what this host owns into reports for its link: on a new link, every Session it owns by ID and generation
 * (`owned`, so the list drops what it no longer has), then its rows in batches; after that only what changed, and
 * what left (`gone`). A row whose last activity alone moved waits until it's moved a minute (`ACTIVITY_REPORT_MS`).
 * What a link was sent is forgotten with it: the next one hears everything again.
 */
export class SessionReporter {
  #link: RuntimeLink | undefined
  readonly #sent = new Map<string, ReportedSession>()

  /**
   * The reports to send now on `link`, in order; none when nothing changed. A row whose shown fields changed says when
   * (`changedAt`, by its conversation), so the device that hears it knows how long the change took.
   */
  reports(link: RuntimeLink, rows: readonly ReportedSession[], changedAt: (row: ReportedSession) => string | undefined = () => undefined): SessionsReport[] {
    const fresh = link !== this.#link
    if (fresh) {
      this.#link = link
      this.#sent.clear()
    }
    const now = new Map(rows.map((row) => [row.session, row]))
    const changed = rows.filter((row) => {
      const sent = this.#sent.get(row.session)
      return held(sent, row) !== sent
    })
    const gone = [...this.#sent.values()].filter((row) => !now.has(row.session)).map(({ session, generation }) => ({ session, generation }))
    if (!fresh && !changed.length && !gone.length) return []
    const batches: SessionsReport[] = []
    const said = changed.map((row) => {
      const sent = this.#sent.get(row.session)
      const at = sent && sameShown(sent, row) ? undefined : changedAt(row)
      return at ? { ...row, changedAt: at } : row
    })
    for (let start = 0; start < Math.max(said.length, 1); start += LISTED_PER_FRAME) batches.push({ listed: said.slice(start, start + LISTED_PER_FRAME), gone: [] })
    batches[0]!.gone = gone
    if (fresh) batches[0]!.owned = rows.map(({ session, generation }) => ({ session, generation }))
    return batches
  }

  /** The reports went: they're what the link holds now. */
  sent(rows: readonly ReportedSession[]): void {
    const next = rows.map((row) => held(this.#sent.get(row.session), row))
    this.#sent.clear()
    for (const row of next) this.#sent.set(row.session, row)
  }

  /** A report didn't go: the next one starts over, as on a new link. */
  forget(): void {
    this.#link = undefined
    this.#sent.clear()
  }
}

/**
 * One update of a watched conversation, numbered and kept to be sent again on a new link: its line whole (or the notice
 * in its place), and in the compact live form where it has one that fits (`gatewayCompactLine`), the same string as the
 * event's own.
 */
type KeptUpdate = { n: number; event: RuntimeEvent; text: string; compact?: string; correlationId?: string }

/** The runtime link a host serves its Sessions on, while it's up: the link itself (one per connection), and what serves on it. */
export type SessionLink = { link: RuntimeLink; served: Pick<ServedRuntime, "version" | "sessions" | "live"> }

/** Some native sessions' rows as they are now, and every Session they stand for, a row or not (`rowsOfNative`). */
export interface NativeRowsOf {
  rows: readonly ReportedSession[]
  sessions: ReadonlySet<string>
}

/** Recomputed at most this often while things change, and at least this often regardless (a rename, a move's step). */
const REPORT_MS = 1_000
/**
 * The whole list is worked out again at least this often, the safety net for what changes without an event: every
 * change that has one (a batch, a native session's write or row, a move, an archive, a rename) reworks its own rows, or
 * the whole list for a structural one, as it comes.
 */
export const SWEEP_MS = 5 * 60_000
/** A change is reported this soon after it, the first in a quiet stretch; the tick then paces the rest. */
const SOON_MS = 200
/** How long a change to a row's Fins alone waits for others with it: one report for a burst of steps. */
export const FINS_COALESCE_MS = 250
/**
 * A change a list shows (a conversation starting or ending work, waiting on a person, renamed; a Session archived) goes
 * on the next turn of the event loop, with whatever else changed in that turn, at most this many times in any second:
 * two changes a moment apart (a turn's request ending, then its session) both go at once, and a state that flaps (a
 * tool call on and off) reports ten times a second at most, not once a batch.
 */
const SHOWN_PER_SECOND = 10
/**
 * A watched conversation's updates are kept this much, from the last the gateway said it relayed (`watch`'s `after`), to
 * be sent again on a new link: what went into a link's last moments, or wasn't sent while it was down. Past it, the
 * watchers are told to read the conversation again instead.
 */
const KEPT_BYTES = 512 * 1024
const KEPT_UPDATES = 1_024
/** The work a report runs as, on the host's tick and soon after a change alike: what it reads in is counted to it. */
export const REPORT_WORK = "tell the account this host's Sessions"

/**
 * What a host tells the cloud of its Sessions, on whichever link it serves: the list's rows when they change (a change a
 * list shows, on the next turn of the event loop; any other within `SOON_MS` of the first, then at most once a second;
 * nothing while nothing does; a whole reconcile every `SWEEP_MS` catches what moves without an event), and a conversation's live
 * updates while another device watches it. A Mac and a cloud machine run the same one. What's watched belongs to the link it was
 * said on, so a reconnect never carries an old link's watchers onto a new one.
 */
export class SessionPublisher {
  readonly #reporter = new SessionReporter()
  readonly #rows: () => readonly ReportedSession[] | undefined
  readonly #rowsOf: ((conversations: ReadonlySet<string>) => readonly ReportedSession[] | undefined) | undefined
  readonly #rowsOfNative: ((paths: ReadonlySet<string>) => NativeRowsOf | undefined) | undefined
  readonly #now: () => number
  #current: SessionLink | undefined
  /** The link the last report went out on: a link not reported on yet is told every row. */
  #reportedLink: RuntimeLink | undefined
  /** What the gateway said is watched on `link`, and the live form each one's watchers read where that's above 1. */
  #watching: { link: RuntimeLink; conversations: ReadonlySet<string>; forms: Readonly<Record<string, LiveForm>> } | undefined
  #dirty = true
  /**
   * Conversations whose batches came since the last report, when nothing else changed: only their rows are worked out
   * again (`rowsOf`). Every batch of every working conversation is one, so the whole list isn't rebuilt each second.
   */
  readonly #touched = new Set<string>()
  /**
   * Native sessions, by path, whose writes or catalog rows moved since the last report: only their rows are worked out
   * again (`rowsOfNative`). A day of agents writes several a second; each once reworked the whole list.
   */
  readonly #touchedNative = new Set<string>()
  #reportedAt = Number.NEGATIVE_INFINITY
  /** When the whole list was last worked out: at least every `SWEEP_MS`, for what moves without an event. */
  #wholeAt = Number.NEGATIVE_INFINITY
  #listed: readonly ReportedSession[] | undefined
  readonly #reportNow: (() => void) | undefined
  readonly #sent: (() => void) | undefined
  readonly #rowsSent: (() => void) | undefined
  readonly #work: Pick<HostWork, "run">
  readonly #schedule: (run: () => void, afterMs: number) => void
  #soonAsked = false
  readonly #shown: ((conversation: string) => ConversationShown | undefined) | undefined
  /** What a list shows of each conversation as its last batch left it, so a batch that moved it is told from one that didn't. */
  readonly #shownOf = new Map<string, { key: string; base: string; promptedAt: string | undefined }>()
  /** A change a list shows is waiting for its report: the next report goes whatever the second's pacing says. */
  #urgent = false
  #shownAsked = false
  #finsAsked = false
  /** When the early reports of the last second went, oldest first, at most `SHOWN_PER_SECOND`. */
  readonly #shownAt: number[] = []
  /** When what a list shows of each conversation last changed, said with its row (`changedAt`). */
  readonly #changedAt = new Map<string, number>()
  /**
   * This runtime's number for each update it sends of a watched conversation (`live`'s `n`): from the clock at its start,
   * up by one each, so a host started again numbers above what it sent before.
   */
  #n: number
  /**
   * By conversation watched on the last link the gateway named it on: its updates since, kept to send again on a new
   * link from where the gateway says it got to, and the highest number given up past the bound, if any.
   */
  readonly #kept = new Map<string, { updates: Array<KeptUpdate>; bytes: number; given?: number }>()
  /** The gateway's word on a link not yet served: what it last relayed, to send the rest once the link is. */
  #after: { link: RuntimeLink; after: Readonly<Record<string, number>> } | undefined
  /** Updates sent again on a new link, and notices to read a conversation again sent in their place, for Diagnostics. */
  #resent = 0
  #notices = 0

  constructor(options: {
    rows: () => readonly ReportedSession[] | undefined
    /**
     * The rows of these conversations alone, as `rows` would make them: a batch reworks its own conversation's row, never
     * the whole list. Without it, every batch reworks the whole list.
     */
    rowsOf?: (conversations: ReadonlySet<string>) => readonly ReportedSession[] | undefined
    /**
     * The rows of these native sessions alone, by path, as `rows` would make them (a native session's row, or the
     * conversation of this host that opens it), and every Session they stand for, listed or not: a native session's write
     * reworks its own rows, never the whole list. Undefined when it can't tell (a session gone from the sync window),
     * and the whole list is worked out instead. Without it, each such change reworks the whole list.
     */
    rowsOfNative?: (paths: ReadonlySet<string>) => NativeRowsOf | undefined
    /**
     * What a list shows of one conversation now (`conversationShown`), read when its batch comes: a batch that moved it
     * is reported on the next turn of the event loop. Without it, every batch waits for the tick.
     */
    shown?: (conversation: string) => ConversationShown | undefined
    now?: () => number
    /**
     * Reports on the link the host serves now, exactly as its tick does (`report` with that link): a change is
     * reported so within `SOON_MS`. Without it, a change waits for the tick.
     */
    reportNow?: () => void
    /**
     * A watched conversation's update went out: the link it went on is asked whether it's alive if it's been silent a
     * while (`CloudLink.probeIfSilent`), so a stalled link the owner sends into is replaced in seconds.
     */
    sent?: () => void
    /** Rows that changed went to the account: what follows the list (its Sessions' uploads) looks again now. */
    rowsSent?: () => void
    /** Names the early report as the tick's job is named (`REPORT_WORK`), so what it reads in is counted to it. */
    work?: Pick<HostWork, "run">
    schedule?: (run: () => void, afterMs: number) => void
  }) {
    this.#rows = options.rows
    this.#rowsOf = options.rowsOf
    this.#rowsOfNative = options.rowsOfNative
    this.#shown = options.shown
    this.#now = options.now ?? Date.now
    this.#reportNow = options.reportNow
    this.#sent = options.sent
    this.#rowsSent = options.rowsSent
    this.#work = options.work ?? { run: (_label, fn) => fn() }
    this.#schedule = options.schedule ?? ((run, afterMs) => setTimeout(run, afterMs).unref?.())
    this.#n = this.#now()
  }

  /** The Sessions the account lists of this host as last worked out, every link's version alike; undefined until then. */
  listed(): readonly ReportedSession[] | undefined {
    return this.#listed
  }

  /**
   * Something a row may show changed: a batch, a move, a rename. Reported soon, on the link the host serves then
   * (`reportNow`), never on one held from before: a link that closed or was replaced meanwhile isn't reported on.
   */
  changed(): void {
    this.#dirty = true
    const reportNow = this.#reportNow
    if (this.#soonAsked || !reportNow || !this.#current) return
    this.#soonAsked = true
    this.#schedule(() => {
      this.#soonAsked = false
      this.#work.run(REPORT_WORK, reportNow)
    }, SOON_MS)
  }

  /**
   * A native session moved (its file was written, its catalog row changed): its rows alone are reported soon, as
   * `changed` reports, without working the whole list out again.
   */
  nativeChanged(path: string): void {
    if (!this.#rowsOfNative) return this.changed()
    this.#touchedNative.add(path)
    const reportNow = this.#reportNow
    if (this.#soonAsked || !reportNow || !this.#current) return
    this.#soonAsked = true
    this.#schedule(() => {
      this.#soonAsked = false
      this.#work.run(REPORT_WORK, reportNow)
    }, SOON_MS)
  }

  /**
   * Something a list shows changed for certain: a conversation's state, a Session archived here. Reported on the next
   * turn of the event loop, on the link the host serves then, bypassing the second's pacing, at most
   * `SHOWN_PER_SECOND` times a second. It doesn't wait for a held foreground: it reads what the host already holds.
   */
  showsChanged(): void {
    this.#dirty = true
    this.#rowShowsChanged()
  }

  /** What a list shows of a conversation already touched (`#touch`) changed: reported as `showsChanged` is, its row alone. */
  #rowShowsChanged(): void {
    this.#urgent = true
    const reportNow = this.#reportNow
    if (this.#shownAsked || !reportNow || !this.#current) return
    this.#shownAsked = true
    this.#schedule(() => {
      this.#shownAsked = false
      this.#shownAt.push(this.#now())
      if (this.#shownAt.length > SHOWN_PER_SECOND) this.#shownAt.shift()
      this.#work.run(REPORT_WORK, reportNow)
    }, this.#shownAt.length < SHOWN_PER_SECOND ? 0 : Math.max(0, this.#shownAt[0]! + 1_000 - this.#now()))
  }

  /** Reports on the current link what changed since the last report there; called on the host's tick. */
  report(current: SessionLink | undefined): void {
    // A link reported on before, served again after a moment without one, already holds the rows.
    if (current && current.link !== this.#reportedLink) this.#dirty = true
    this.#current = current
    if (!current || current.served.version < SESSIONS_VERSION) return
    const now = this.#now()
    const changed = this.#dirty || this.#touched.size > 0 || this.#touchedNative.size > 0
    if (!this.#urgent && (now - this.#reportedAt < REPORT_MS || (!changed && now - this.#reportedAt < SWEEP_MS))) return
    const whole = this.#dirty || now - this.#wholeAt >= SWEEP_MS
    let some = whole ? undefined : this.#touched.size ? this.#withRowsOf(this.#touched) : this.#listed
    if (some && this.#touchedNative.size) some = this.#withNativeRows(some, this.#touchedNative)
    const all = some ?? this.#rows()
    if (!all) return
    if (!some) this.#wholeAt = now
    this.#listed = all
    this.#touched.clear()
    this.#touchedNative.clear()
    const rows = rowsForLink(all, current.served.version)
    this.#dirty = false
    this.#urgent = false
    this.#reportedAt = now
    this.#reportedLink = current.link
    const reports = this.#reporter.reports(current.link, rows, (row) => {
      const at = this.#changedAt.get(row.conversation)
      return at === undefined ? undefined : new Date(at).toISOString()
    })
    if (!reports.length) return
    for (const report of reports) report.reportedAt = new Date(now).toISOString()
    if (reports.every((report) => current.served.sessions(report))) {
      this.#reporter.sent(rows)
      this.#rowsSent?.()
    } else {
      // Told again in full on the next tick, as a new link is.
      this.#reporter.forget()
      this.#reportedLink = undefined
    }
  }

  /**
   * `listed` with the rows of these native sessions worked out again: every row of a Session they stand for goes, and
   * their rows as they are now take its place. Undefined when it can't be (`rowsOfNative` can't tell), and the whole
   * list is worked out instead.
   */
  #withNativeRows(listed: readonly ReportedSession[], paths: ReadonlySet<string>): readonly ReportedSession[] | undefined {
    const fresh = this.#rowsOfNative?.(paths)
    if (!fresh) return undefined
    const bySession = new Map(fresh.rows.map((row) => [row.session, row]))
    const rows: ReportedSession[] = []
    for (const row of listed) {
      const again = bySession.get(row.session)
      if (again) {
        rows.push(again)
        bySession.delete(row.session)
      } else if (!fresh.sessions.has(row.session)) rows.push(row)
    }
    rows.push(...bySession.values())
    return rows
  }

  /**
   * The list as last worked out with the rows of `conversations` worked out again, in place; undefined when it can't
   * be (no list yet, no `rowsOf`), and the whole list is worked out instead.
   */
  #withRowsOf(conversations: ReadonlySet<string>): readonly ReportedSession[] | undefined {
    const listed = this.#listed
    if (!listed || !this.#rowsOf) return undefined
    const fresh = this.#rowsOf(conversations)
    if (!fresh) return undefined
    const bySession = new Map(fresh.map((row) => [row.session, row]))
    const rows: ReportedSession[] = []
    for (const row of listed) {
      const again = bySession.get(row.session)
      if (again) {
        rows.push(again)
        bySession.delete(row.session)
      } else if (!conversations.has(row.conversation)) rows.push(row)
    }
    rows.push(...bySession.values())
    return rows
  }

  /**
   * The host's link to the cloud is up and served (enrolled): watched conversations go out on it from now, without
   * waiting for the next report to learn of it, and what the gateway said it missed is sent.
   */
  linked(current: SessionLink): void {
    this.#current = current
    this.#resend()
  }

  /**
   * The gateway says which of this host's conversations another device watches, on `link`: the whole set, from link
   * version 9 the number of the last update it relayed of each (`after`), so a new link sends what came after, and from
   * 13 the live form every watcher of each reads (`forms`), the one its updates go in from now (`live-form.ts`).
   */
  watch(link: RuntimeLink, conversations: readonly string[], after?: Readonly<Record<string, number>>, forms: Readonly<Record<string, LiveForm>> = {}): void {
    const before = this.#watching?.link === link ? this.#watching.forms : {}
    for (const conversation of conversations) {
      const form = forms[conversation] ?? WHOLE_LIVE_FORM
      const was = before[conversation] ?? WHOLE_LIVE_FORM
      if (form !== was) hostLog("sync", "a watched conversation's watchers read another live form; its updates go in it from now", { conversation, form, was })
    }
    this.#watching = { link, conversations: new Set(conversations), forms }
    for (const conversation of this.#kept.keys()) if (!this.#watching.conversations.has(conversation)) this.#kept.delete(conversation)
    if (after) this.#after = { link, after }
    this.#resend()
  }

  /** Once the link the gateway's `after` was said on is the one served: what each watched conversation missed, in order. */
  #resend(): void {
    const said = this.#after
    const current = this.#current
    if (!said || !current || said.link !== current.link || this.#watching?.link !== current.link) return
    this.#after = undefined
    for (const [conversation, last] of Object.entries(said.after)) {
      const kept = this.#kept.get(conversation)
      if (!kept || !this.#watching.conversations.has(conversation)) continue
      const missed = kept.updates.filter((update) => update.n > last)
      kept.updates = missed
      kept.bytes = missed.reduce((sum, update) => sum + update.text.length, 0)
      if (!missed.length) continue
      if (kept.given !== undefined && kept.given > last) {
        // More went by than was kept: its watchers read the conversation again rather than miss part of it.
        const notice = historyChangedNotice(missed.at(-1)!.event)
        const line = notice && gatewayEventLine("event", notice)
        if (line && line.fit !== "too-large") current.served.live(conversation, Payload.encoded(line.text), { n: missed.at(-1)!.n })
        this.#notices += 1
        hostLog("sync", "a watched conversation missed more than was kept on a new link; its watchers read it again", { conversation, missed: missed.length })
        kept.updates = []
        kept.bytes = 0
        delete kept.given
        continue
      }
      for (const update of missed) this.#send(current, conversation, update)
      this.#resent += missed.length
      hostLog("sync", "a watched conversation's updates the gateway didn't relay went again on a new link", { conversation, updates: missed.length })
    }
  }

  /** What this host sends of its own watched conversations, for Diagnostics' Sync. */
  readings(): OwnerReading {
    const watching = this.#watching
    const compact = watching ? [...watching.conversations].filter((conversation) => this.#formOf(conversation) === COMPACT_LIVE_FORM).length : 0
    const negotiated = (this.#current?.served.version ?? 0) >= COMPACT_LIVE_VERSION
    return { watched: watching?.conversations.size ?? 0, compact, negotiated, resent: this.#resent, notices: this.#notices }
  }

  /** The live form a watched conversation's updates go in on the link it's watched on. */
  #formOf(conversation: string): LiveForm {
    return this.#watching?.forms[conversation] ?? WHOLE_LIVE_FORM
  }

  /**
   * One update on `current`, in the form the gateway last said every watcher of its conversation reads: the compact one
   * where it has it and fits, else whole. The same update sent again on a new link goes in what that link says.
   */
  #send(current: SessionLink, conversation: string, update: KeptUpdate): void {
    const compact = this.#formOf(conversation) === COMPACT_LIVE_FORM ? update.compact : undefined
    const text = compact ?? update.text
    current.served.live(conversation, Payload.encoded(text), { n: update.n, ...(update.correlationId && { correlationId: update.correlationId }), ...(compact !== undefined && { form: COMPACT_LIVE_FORM }) })
  }

  /**
   * One of the host's outgoing events, encoded: a watched conversation's batch goes to its watchers, and every batch may
   * change a row. The gateway carries a cloud Thread's events and these alike, up to `MAX_EVENT_BYTES`: a batch larger
   * goes as the notice to read the conversation again (`gatewayEventLine`), so the watcher reads it rather than the link
   * closing on it.
   */
  event(channel: RuntimeEventChannel, event: RuntimeEvent): void {
    if (channel !== "event") return
    if (event.type === "live-batch") this.#touch(event.conversation)
    const conversation = event.conversation
    // Watched on the last link the gateway named it on: numbered and kept, sent now if that link is the one up.
    if (!conversation || !this.#watching?.conversations.has(conversation)) return
    const line = gatewayEventLine(channel, event)
    if (line.fit === "too-large") return hostWarn("sessions", "a watched conversation's event too large for the gateway wasn't sent", { conversation, type: line.type, bytes: line.bytes })
    const n = ++this.#n
    const correlationId = event.trace
    const compact = gatewayCompactLine(event)
    const update: KeptUpdate = { n, event, text: line.text, ...(compact !== undefined && { compact }), ...(correlationId && { correlationId }) }
    this.#keep(conversation, update)
    const current = this.#watched(conversation)
    if (!current) return
    this.#send(current, conversation, update)
    // A sampled update: logged here, at the gateway and on each device that hears it, under its trace.
    if (correlationId) hostLog("sync", "traced update sent", { trace: correlationId, conversation, n })
    this.#sent?.()
  }

  #keep(conversation: string, update: KeptUpdate): void {
    let kept = this.#kept.get(conversation)
    if (!kept) this.#kept.set(conversation, (kept = { updates: [], bytes: 0 }))
    const bytes = (each: KeptUpdate) => each.text.length + (each.compact?.length ?? 0)
    kept.updates.push(update)
    kept.bytes += bytes(update)
    while (kept.updates.length > KEPT_UPDATES || (kept.bytes > KEPT_BYTES && kept.updates.length > 1)) {
      const given = kept.updates.shift()!
      kept.bytes -= bytes(given)
      kept.given = given.n
    }
  }

  /**
   * One of this host's own events, as its conversations emit it: a batch may change a row, and a watched conversation's
   * goes to its watchers, encoded only then, so an event nobody elsewhere watches costs nothing.
   */
  own(event: HostEvent): void {
    // A Session archived here leaves every device's list, and a Thread renamed here is renamed there: the owner's word
    // is the one that counts, and no batch says either.
    if (event.type === "thread-archives" || event.type === "thread-titles") return this.showsChanged()
    // A project's checkout moved to another branch, or a rebase began or ended: its rows say so beside the project.
    if (event.type === "checkout-heads") return this.changed()
    // A move's steps go to whoever watches the conversation it was asked from, as its window hears them: a device that
    // has it open follows the move as it goes, each upload's bytes included. The way back's too, to a device that
    // follows this host for the conversation coming back.
    if (event.type === "thread-move-step" || event.type === "thread-return-step") {
      if (this.#watching?.conversations.has(event.conversationId)) this.event("event", { type: event.type, conversation: event.conversationId, payload: JSON.stringify(event) })
      return
    }
    if (event.type !== "live-batch") return
    this.#touch(event.batch.id)
    this.#sawBatch(event.batch.id, event.batch.trace)
    if (this.#watching?.conversations.has(event.batch.id)) this.event("event", encodeRuntimeEvent(event))
  }

  /** A batch of `conversation` came: its row alone is worked out again, or the whole list for a batch of none. */
  #touch(conversation: string | undefined): void {
    if (conversation) this.#touched.add(conversation)
    else this.#dirty = true
  }

  /** A conversation's batch came: whether it moved what a list shows of it, which then goes at once (`showsChanged`). */
  #sawBatch(conversation: string, trace: string | undefined): void {
    const shown = this.#shown?.(conversation)
    if (!shown) return
    const base = `${shown.state}\0${shown.waitingFor ?? ""}\0${shown.waitingOn ?? ""}\0${shown.title ?? ""}\0${shown.background ?? ""}\0${shown.promptedAt ?? ""}\0${shown.asking ? JSON.stringify(shown.asking) : ""}`
    const key = `${base}\0${shown.fins ? JSON.stringify(shown.fins) : ""}`
    const before = this.#shownOf.get(conversation)
    if (before?.key === key) return
    this.#shownOf.set(conversation, { key, base, promptedAt: shown.promptedAt })
    // Only its Fins moved (a step, a place in line): said within FINS_COALESCE_MS, once for all that move meanwhile.
    if (before?.base === base) {
      this.#changedAt.set(conversation, this.#now())
      if (this.#finsAsked) return
      this.#finsAsked = true
      this.#schedule(() => {
        this.#finsAsked = false
        this.#rowShowsChanged()
      }, FINS_COALESCE_MS)
      return
    }
    if (before && shown.promptedAt !== before.promptedAt)
      hostLog("sync", "a message the person sent goes on its row at once, and every rail moves its project", { conversation, promptedAt: shown.promptedAt, ...(trace && { trace }) })
    this.#changedAt.set(conversation, this.#now())
    this.#rowShowsChanged()
  }

  /** The current link, when another device watches `conversation` on it. */
  #watched(conversation: string | undefined): SessionLink | undefined {
    const current = this.#current
    if (!conversation || !current || this.#watching?.link !== current.link || !this.#watching.conversations.has(conversation)) return undefined
    return current
  }
}

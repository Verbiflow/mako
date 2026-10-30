import type { Waiting } from "@mako/protocol/attention"
import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { MAX_EVENT_BYTES, NUMBERED_LIVE_VERSION, serveRuntime, type Payload } from "@mako/protocol"
import { rowsForLink, type ListedSession, type ReportedSession, type SessionsReport } from "@mako/protocol/thread-listing"
import { AccountSessions } from "@mako/protocol/account-sessions"
import { MovesUnderWay } from "@mako/host/conversations/moves-under-way"
import { SENT_EVERY_MS, SentProgress } from "@mako/host/conversations/cloud-moves"
import type { MoveSent } from "@mako/host/contracts/cloud-threads"
import { ACTIVITY_REPORT_MS, conversationShown, nativeConversation, ownedSessions, REPORT_WORK, SessionPublisher, SessionReporter, type ConversationShown, type NativeRow, type ReportSources, type SessionLink } from "@mako/host/conversations/session-report"
import { namedWork } from "@mako/host/base/event-loop"
import type { ExternalThreadActivity } from "@mako/host/contracts/host-events-boot"
import { SessionUploads, uploadScope, UPLOAD_BATTERY_FLOOR, type UploadLinks } from "@mako/host/conversations/session-uploads"
import { followHostLog } from "@mako/host/base/host-log"
import { SYNC_WINDOW_MS } from "@mako/host/conversations/sync-window"
import { threadArchiveKey } from "@mako/host/contracts/thread-lifecycle"
import { parsePower, type PowerReading } from "@mako/host/base/power"
import type { RecordsLink } from "@mako/sessions/record-sync"
import type { CatalogSyncStatus, SyncFailure, SyncScope } from "@mako/sessions/scoped-uploads"
import type { LifecycleWork } from "@mako/host/contracts/app-lifecycle"
import type { LiveSummary } from "@mako/host/contracts/live-conversations"
import { DeviceIdSchema, MoveIdSchema, RuntimeIdSchema, type SessionExecution } from "@mako/host/contracts/thread-execution"
import { createFakeGateway } from "@mako/protocol/fake-gateway"
import { encodeRuntimeEvent, splitRuntimeEventLine } from "@mako/host/contracts/runtime-value"
import { traceOf } from "@mako/host/contracts/live-conversations"
import { SyncRecorder, describeFollow, describeList, describeOwner } from "@mako/host/contracts/sync-readings"

/**
 * The account's list of Sessions on both of its ends in Mako: what a host owns and says of it (`ownedSessions`,
 * `SessionReporter`, `SessionPublisher`), and a device holding the list in step with the account's stream
 * (`AccountSessions`).
 */

const NOW = Date.parse("2026-10-24T20:00:00.000Z")
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const summary = (id: string, createdAt: number, session: Partial<LiveSummary["session"]> = {}): LiveSummary => ({
  session: { id, harness: "codex", cwd: "/Users/ana/api", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [], ...session },
  revision: 1,
  createdAt,
})
const work = (id: string, status: LifecycleWork["status"]): LifecycleWork => ({ id, token: id, title: "", provider: "codex", cwd: "", status, stoppable: true })

/** A host with conversations c-1.. filed under Sessions uuid(1).. of Thread uuid(100), each owned here unless `executions` says. */
function host(summaries: LiveSummary[], options: { work?: LifecycleWork[]; executions?: Record<string, SessionExecution>; waiting?: Record<string, Waiting>; moved?: Record<string, number>; title?: string; native?: NativeRow[]; activity?: Record<string, ExternalThreadActivity>; archived?: string[]; threads?: Record<string, number> } = {}): ReportSources {
  const index = (id: string) => Number(id.slice(2))
  return {
    summaries: () => summaries,
    native: () => options.native ?? [],
    activity: (path) => options.activity?.[path],
    work: () => options.work ?? [],
    waitingOn: (id) => options.waiting?.[id],
    hidden: () => new Set((options.archived ?? []).map((id) => threadArchiveKey({ kind: "live", id }))),
    lastMoved: (id) => options.moved?.[id],
    // SAFETY: test IDs in the Thread store's shapes, which brand plain UUIDs.
    placement: (id) => ({ thread: uuid(options.threads?.[id] ?? 100), session: uuid(index(id)) }) as never,
    executions: (sessions) => new Map(sessions.flatMap((session) => {
      const execution = options.executions?.[session]
      return execution ? [[session, execution] as const] : []
    })),
    titles: (threads) => new Map(threads.map((thread) => [thread, options.title ? { title: options.title, titleSource: "user" } : { title: "made by an old build", titleSource: "auto" }] as const)),
    now: () => NOW,
  }
}

test("a host lists the Sessions it owns, at work first, then newest first, each as the lifecycle sees it, at the generation its store holds", () => {
  const here = (generation: number): SessionExecution => ({ state: "here", owner: { kind: "device", device: DeviceIdSchema.parse(uuid(900)) }, generation })
  const rows = ownedSessions(host(
    [
      summary("c-1", NOW - 10_000, { status: "failed", title: "Fix the flaky test" }),
      summary("c-2", NOW - 1_000, { status: "running" }),
      summary("c-3", NOW - 5_000),
      summary("c-4", NOW - 3_000),
      summary("c-5", NOW - 2_000, { status: "closed" }),
      summary("c-6", NOW - 2_500),
      summary("c-7", NOW - 2_600),
    ],
    {
      work: [work("c-2", "waiting"), work("c-3", "running")],
      waiting: { "c-2": { for: "approval", line: "Approve: npm test" } },
      executions: {
        [uuid(4)]: here(3),
        [uuid(6)]: { state: "elsewhere", owner: { kind: "cloud", runtime: RuntimeIdSchema.parse(uuid(901)) }, generation: 5 },
        [uuid(7)]: { state: "in-transit", generation: 4, move: MoveIdSchema.parse(uuid(902)), target: { kind: "cloud", runtime: RuntimeIdSchema.parse(uuid(901)) } },
      },
      title: "Webhooks",
    },
  ))
  assert.deepEqual(rows.map((row) => [row.conversation, row.state, row.generation]), [
    ["c-2", "waiting", 1],
    ["c-7", "moving", 4],
    ["c-3", "working", 1],
    ["c-5", "idle", 1],
    ["c-4", "idle", 3],
    ["c-1", "failed", 1],
  ], "the ones at work first, then the newest; a closed conversation is listed (another device's message reopens it), one elsewhere isn't; a Session in transit is, as moving, at its generation")
  assert.equal(rows[0]?.waitingOn, "Approve: npm test")
  assert.equal(rows[0]?.waitingFor, "approval", "what it waits for is said, never left to be read from the words")
  assert.equal(rows[0]?.threadTitle, "Webhooks")
  assert.equal(rows.find((row) => row.conversation === "c-1")?.title, "Fix the flaky test")
  assert.equal(ownedSessions(host([summary("c-1", NOW)]))[0]?.threadTitle, undefined, "an older build's automatic title isn't shown anywhere")
})

test("a Thread worked in within the week is listed whole, its older Sessions too; an older one only while a Session of it works or waits; when it moved is its journal's last write", () => {
  const old = NOW - SYNC_WINDOW_MS - 1
  const threads = { "c-1": 101, "c-2": 102, "c-3": 103, "c-4": 103 }
  const rows = ownedSessions(host([summary("c-1", old), summary("c-2", old), summary("c-3", old), summary("c-4", old)], { work: [work("c-2", "running")], moved: { "c-3": NOW - 60_000 }, threads }))
  assert.deepEqual(rows.map((row) => row.conversation), ["c-2", "c-3", "c-4"], "at work first; then Thread 103 whole, its Session of 8 days ago with it")
  assert.equal(rows.find((row) => row.conversation === "c-3")?.activityAt, new Date(NOW - 60_000).toISOString())
})

/** A session a harness keeps on this Mac, as the rail lists it, placed in Session uuid(n) of Thread uuid(200 + n). */
const nativeRow = (n: number, updatedAt: number, fields: Partial<NativeRow> = {}): NativeRow => ({
  harness: "claude",
  nativeId: `native-${n}`,
  path: `/Users/ana/.claude/projects/-Users-ana-api/native-${n}.jsonl`,
  cwd: "/Users/ana/api",
  title: `Terminal session ${n}`,
  startedAt: new Date(updatedAt - 60_000).toISOString(),
  updatedAt: new Date(updatedAt).toISOString(),
  threadId: uuid(200 + n),
  sessionId: uuid(n),
  ...fields,
})

test("the sessions a terminal or another app runs are listed beside Mako's own, one row per Session, each as its process stands", () => {
  const activity = (status: ExternalThreadActivity["status"], detail?: string): ExternalThreadActivity => {
    const read: ExternalThreadActivity = { provider: "claude", since: NOW - 5_000, status }
    if (detail !== undefined) read.detail = detail
    return read
  }
  const live = summary("c-1", NOW - 1_000, { status: "running", nativeId: "native-1" })
  live.threadPath = nativeRow(1, 0).path
  // Another session's file this conversation reads too (a reopen journal's binding).
  live.nativePaths = [nativeRow(31, 0).path]
  const rows = ownedSessions(host([live], {
    native: [
      // Mako's own conversation's session: that conversation's row says it.
      nativeRow(1, NOW - 1_000),
      // Waiting on a person in the terminal, and at work there.
      nativeRow(21, NOW - 2_000),
      nativeRow(22, NOW - 3_000, { harness: "codex" }),
      // Two sessions of one Session (a conversation that went on in another harness): the newer is the row.
      nativeRow(23, NOW - 9_000),
      nativeRow(24, NOW - 4_000, { sessionId: uuid(23), threadId: uuid(223) }),
      // At rest, within the week; and older than the list keeps.
      nativeRow(25, NOW - 6_000),
      nativeRow(26, NOW - SYNC_WINDOW_MS - 1),
      // Deleted or archived by its harness; moved to the cloud; never placed in a Thread.
      nativeRow(27, NOW - 1_000, { archived: true }),
      nativeRow(28, NOW - 1_000, { nativeArchived: true }),
      nativeRow(29, NOW - 1_000),
      nativeRow(30, NOW - 1_000, { sessionId: undefined }),
      nativeRow(31, NOW - 1_000),
    ],
    activity: {
      [nativeRow(21, 0).path]: activity("needs-input", "Approve: rm -rf dist"),
      [nativeRow(22, 0).path]: activity("active"),
      [nativeRow(25, 0).path]: activity("open"),
    },
    executions: { [uuid(29)]: { state: "elsewhere", owner: { kind: "cloud", runtime: RuntimeIdSchema.parse(uuid(901)) }, generation: 2 } },
  }))
  assert.deepEqual(rows.map((each) => [each.conversation, each.state]), [
    ["c-1", "working"],
    [nativeConversation(uuid(21)), "waiting"],
    [nativeConversation(uuid(22)), "working"],
    [nativeConversation(uuid(23)), "idle"],
    [nativeConversation(uuid(25)), "idle"],
  ])
  assert.equal(rows[0]?.nativeId, "native-1", "a conversation names its native session too")
  assert.equal(rows[0]?.capture, undefined, "and is called as itself")
  const waiting = rows[1]
  assert.equal(waiting?.waitingOn, "Approve: rm -rf dist")
  assert.equal(waiting?.waitingFor, "needs-you", "a terminal's harness says only that it waits for input")
  assert.equal(waiting?.title, "Terminal session 21")
  assert.equal(waiting?.folder, "/Users/ana/api")
  assert.deepEqual(waiting?.capture, { path: nativeRow(21, 0).path }, "its device opens it by the path its catalog reads it at")
  assert.equal(rows[3]?.nativeId, "native-24", "the newer of a Session's two sessions")
  assert.equal(nativeConversation(uuid(21)), nativeConversation(uuid(21)), "named from its Session, the same on every device")
})

test("a report reads the Thread store once for every row's Session and once for their Threads, however many rows it has", () => {
  const sources = host(Array.from({ length: 40 }, (_, index) => summary(`c-${index + 1}`, NOW - index * 1_000)), {
    native: Array.from({ length: 40 }, (_, index) => nativeRow(100 + index, NOW - index * 1_000)),
    title: "Webhooks",
  })
  const executions: number[] = []
  const titles: number[] = []
  const rows = ownedSessions({
    ...sources,
    executions: (sessions) => (executions.push(sessions.length), sources.executions(sessions)),
    titles: (threads) => (titles.push(threads.length), sources.titles(threads)),
  })
  assert.equal(rows.length, 80)
  assert.deepEqual({ executions, titles }, { executions: [80], titles: [41] }, "one read of the 80 Sessions, one of their 41 Threads")
})

test("a link older than version 6 hears neither a session Mako hasn't opened nor native IDs", () => {
  const rows: ReportedSession[] = [
    { ...row(1), nativeId: "native-1" },
    { ...row(2), nativeId: "native-2", capture: { path: "/Users/ana/native-2.jsonl" } },
  ]
  assert.deepEqual(rowsForLink(rows, 6), rows)
  assert.deepEqual(rowsForLink(rows, 5), [row(1)])
  assert.equal(rows[0]?.nativeId, "native-1", "the rows themselves are left as they were")
})

const row = (n: number, state: ReportedSession["state"] = "idle"): ReportedSession => ({ session: uuid(n), thread: uuid(100), conversation: `c-${n}`, harness: "codex", state, createdAt: new Date(NOW).toISOString(), activityAt: new Date(NOW).toISOString(), generation: 1 })

const gateway = createFakeGateway()
const newLink = () => gateway.connectRuntime()

test("a link hears everything owned first, then only what changed and what went; a new link hears everything again", async () => {
  const reporter = new SessionReporter()
  const link = await newLink()
  const rows = Array.from({ length: 250 }, (_, index) => row(index + 1))
  const first = reporter.reports(link, rows)
  assert.equal(first.length, 2, "rows go 200 to a report")
  assert.equal(first[0]?.owned?.length, 250, "the first says every Session it owns")
  assert.equal(first[1]?.owned, undefined)
  reporter.sent(rows)
  assert.deepEqual(reporter.reports(link, rows), [], "nothing changed: nothing said")
  const changed = [row(1, "working"), ...rows.slice(1, 249)]
  const next = reporter.reports(link, changed)
  assert.deepEqual(next.map((report) => [report.listed.map((each) => each.conversation), report.gone.map((each) => each.session)]), [[["c-1"], [uuid(250)]]])
  reporter.sent(changed)
  const fresh = reporter.reports(await newLink(), changed)
  assert.equal(fresh[0]?.owned?.length, 249, "a new link: everything again")
})

test("a publisher reports when something changed, sweeps every half minute regardless, and relays a conversation's updates only while watched on that link", async () => {
  let now = NOW
  let rows = [row(1)]
  const sent: SessionsReport[] = []
  const live: string[] = []
  const served = (version = 5) => ({ version, sessions: (report: SessionsReport) => (sent.push(report), true), live: (conversation: string, event: Payload) => (live.push(`${conversation} ${event.text.length > 0}`), true) })
  const soon: Array<{ run: () => void; afterMs: number }> = []
  // The link the host serves now, as its account holds it: what a report soon after a change goes on, as the tick's does.
  let serving: SessionLink | undefined
  const work = namedWork()
  const computedAs: (string | undefined)[] = []
  const publisher = new SessionPublisher({
    rows: () => (computedAs.push(work.current()), rows),
    now: () => now,
    reportNow: () => publisher.report(serving),
    work,
    schedule: (run, afterMs) => { soon.push({ run, afterMs }) },
  })
  publisher.changed()
  assert.equal(soon.length, 0, "before a link, a change waits for the tick")
  const link = { link: await newLink(), served: served() }
  serving = link
  publisher.report(link)
  assert.equal(sent.length, 1)
  publisher.report(link)
  assert.equal(sent.length, 1, "not again within the second")
  now += 2_000
  publisher.report(link)
  assert.equal(sent.length, 1, "nothing changed: nothing recomputed")
  rows = [row(1, "working")]
  publisher.changed()
  publisher.changed()
  assert.deepEqual(soon.map((each) => each.afterMs), [200], "a change asks for a report soon, once")
  soon.shift()?.run()
  assert.equal(sent.length, 2, "and the report goes then, not at the next tick")
  assert.equal(computedAs.at(-1), REPORT_WORK, "named as the tick's job is, so what it reads in is counted to it")
  rows = [row(1, "waiting")]
  publisher.changed()
  soon.shift()?.run()
  assert.equal(sent.length, 2, "within the second of the last, it waits for the tick")
  now += 2_000
  // The link changed between the change and its report: the report goes on the one served now, never the one before.
  const replaced: SessionsReport[] = []
  const replacement = { link: await newLink(), served: { ...served(), sessions: (report: SessionsReport) => (replaced.push(report), true) } }
  rows = [row(1, "working")]
  publisher.changed()
  serving = replacement
  soon.shift()?.run()
  assert.deepEqual([sent.length, replaced.length], [2, 1], "reported on the link served when it went")
  serving = link
  now += 2_000
  publisher.report(link)
  assert.equal(sent.length, 3, "and back on the first, everything again")
  rows = [row(1, "idle")]
  now += 31_000
  publisher.report(link)
  assert.equal(sent.length, 4, "the sweep finds what changed without an event")

  // SAFETY: a batch as a live driver sends one, filled only as far as the publisher reads it (its conversation).
  const batch = (conversation: string) => encodeRuntimeEvent({ type: "live-batch", batch: { id: conversation, revision: 2, updates: [] } } as never)
  publisher.event("event", batch("c-1"))
  assert.deepEqual(live, [], "nobody watches")
  publisher.watch(link.link, ["c-1"])
  publisher.event("event", batch("c-1"))
  publisher.event("event", batch("c-2"))
  assert.deepEqual(live, ["c-1 true"])
  // A new link: what was watched on the old one isn't watched here until this one says so.
  const next = { link: await newLink(), served: served() }
  publisher.report(next)
  publisher.event("event", batch("c-1"))
  assert.deepEqual(live, ["c-1 true"])
  publisher.watch(next.link, ["c-1"])
  publisher.event("event", batch("c-1"))
  assert.deepEqual(live, ["c-1 true", "c-1 true"])
  // The host's own batches, as its conversations emit them: relayed only while watched, as their encoded line.
  // SAFETY: a host event as a live driver emits one, filled only as far as the publisher reads it.
  const own = (conversation: string) => ({ type: "live-batch", batch: { id: conversation, revision: 3, updates: [] } }) as never
  publisher.own(own("c-2"))
  assert.deepEqual(live, ["c-1 true", "c-1 true"], "its own batch nobody watches goes nowhere")
  publisher.own(own("c-1"))
  assert.deepEqual(live, ["c-1 true", "c-1 true", "c-1 true"], "its own batch a device watches goes to it")
  // A gateway older than the frame hears nothing.
  const older = new SessionPublisher({ rows: () => rows, now: () => now, schedule: () => {} })
  const before = sent.length
  older.report({ link: await newLink(), served: served(4) })
  assert.equal(sent.length, before)
})

test("a Thread moving to the cloud says so on every row of it from the move's first step, each step once, and not after it ends", () => {
  let now = NOW
  const moves = new MovesUnderWay(() => now)
  const thread = uuid(100)
  const sources = { ...host([summary("c-1", NOW - 60_000), summary("c-2", NOW - 50_000)], { threads: { "c-2": 200 } }), moving: (id: string) => moves.of(id) }
  assert.equal(moves.stepped(thread, "m-1", { kind: "packing" }), true, "its first step is news to every list")
  assert.equal(moves.stepped(thread, "m-1", { kind: "packing", sent: { bytes: 10, of: 100 } }), false, "how far its upload got isn't: that goes to whoever watches it")
  const packing = ownedSessions(sources)
  assert.deepEqual(packing.find((row) => row.conversation === "c-1")?.move, { to: "cloud", step: "packing", since: new Date(NOW).toISOString() })
  assert.equal(packing.find((row) => row.conversation === "c-1")?.state, "idle", "its state is still what it was: it's still here")
  assert.equal(packing.find((row) => row.conversation === "c-2")?.move, undefined, "another Thread's rows say nothing")
  now += 5_000
  assert.equal(moves.stepped(thread, "m-1", { kind: "handing-over" }), true)
  assert.equal(ownedSessions(sources).find((row) => row.conversation === "c-1")?.move?.since, new Date(NOW + 5_000).toISOString(), "a step says when it began")
  assert.equal(moves.stepped(thread, "m-1", { kind: "moved", conversations: ["c-1"] }), true, "its end is news too")
  assert.equal(ownedSessions(sources).find((row) => row.conversation === "c-1")?.move, undefined)
  assert.equal(moves.stepped(thread, "m-1", { kind: "kept-here", reason: "x" }), false, "and only once")
  assert.equal(moves.stepped(undefined, "m-2", { kind: "packing" }), false, "a conversation the store can't place moves nothing it lists")
  // A move that stops running here without its last step (it threw after the release) is listed no longer.
  moves.stepped(thread, "m-4", { kind: "handing-over" })
  assert.equal(moves.ended("m-5"), false, "another move's end changes nothing")
  assert.equal(moves.of(thread)?.step, "handing-over")
  assert.equal(moves.ended("m-4"), true, "its end is news")
  assert.equal(moves.of(thread), undefined)
  assert.equal(moves.ended("m-4"), false, "and only once")
  // A Thread long idle is listed while it moves, as one at work is.
  moves.stepped(thread, "m-3", { kind: "packing" })
  const old = { ...sources, summaries: () => [summary("c-1", NOW - SYNC_WINDOW_MS * 3)], lastMoved: () => NOW - SYNC_WINDOW_MS * 3 }
  assert.equal(ownedSessions(old).length, 1)
  assert.equal(rowsForLink(ownedSessions(old), 10)[0]?.move, undefined, "a gateway before link version 11 hears the row without it")
})

test("a move's upload says how much went, a quarter second apart at most, and the whole at its end; a file already there adds nothing", () => {
  let now = NOW
  const said: MoveSent[] = []
  const progress = new SentProgress((sent) => said.push(sent), () => now)
  const first = progress.adding(4_000_000)
  first(1_000_000)
  first(2_000_000)
  now += SENT_EVERY_MS
  first(3_000_000)
  first(4_000_000)
  const second = progress.adding(1_000_000)
  now += SENT_EVERY_MS
  second(500_000)
  progress.done()
  assert.deepEqual(said, [
    { bytes: 1_000_000, of: 4_000_000 },
    { bytes: 3_000_000, of: 4_000_000 },
    { bytes: 4_500_000, of: 5_000_000 },
    { bytes: 5_000_000, of: 5_000_000 },
  ])
  const nothing: MoveSent[] = []
  new SentProgress((sent) => nothing.push(sent)).done()
  assert.deepEqual(nothing, [], "nothing to send: nothing said")
})

test("a move's steps go to a device watching the conversation it was asked from, as its window hears them, and nowhere else", async () => {
  const live: string[] = []
  const link = { link: await newLink(), served: { version: 11, sessions: () => true, live: (conversation: string, event: Payload) => (live.push(`${conversation} ${JSON.parse(splitRuntimeEventLine(event.text)?.payload ?? "{}").step?.kind}`), true) } }
  const publisher = new SessionPublisher({ rows: () => [row(1)], now: () => NOW, schedule: () => {} })
  publisher.report(link)
  // SAFETY: a host event as the moves emit it.
  publisher.own({ type: "thread-move-step", conversationId: "c-1", move: "m-1", step: { kind: "packing" } } as never)
  assert.deepEqual(live, [], "nobody watches")
  publisher.watch(link.link, ["c-1"])
  // SAFETY: a host event as the moves emit it.
  publisher.own({ type: "thread-move-step", conversationId: "c-1", move: "m-1", step: { kind: "packing", sent: { bytes: 1, of: 2 } } } as never)
  // SAFETY: a host event as the moves emit it.
  publisher.own({ type: "thread-move-step", conversationId: "c-2", move: "m-2", step: { kind: "packing" } } as never)
  // SAFETY: a host event as the way back emits it.
  publisher.own({ type: "thread-return-step", conversationId: "c-1", move: "m-3", step: { kind: "bringing" } } as never)
  assert.deepEqual(live, ["c-1 packing", "c-1 bringing"])
})

test("a row whose last activity alone moved is said once it's moved a minute; with anything else a list shows, at once", async () => {
  const reporter = new SessionReporter()
  const link = await newLink()
  const at = (row: ReportedSession, ms: number): ReportedSession => ({ ...row, activityAt: new Date(NOW + ms).toISOString() })
  reporter.sent(reporter.reports(link, [row(1)]).flatMap((report) => report.listed))
  // A conversation streaming: its activity moves with every batch, and nothing else a list shows does.
  for (const ms of [1_000, 20_000, 40_000, ACTIVITY_REPORT_MS - 1]) {
    assert.deepEqual(reporter.reports(link, [at(row(1), ms)]), [], `nothing said ${ms} ms on`)
    reporter.sent([at(row(1), ms)])
  }
  const minute = reporter.reports(link, [at(row(1), ACTIVITY_REPORT_MS)])
  assert.equal(minute[0]?.listed[0]?.activityAt, new Date(NOW + ACTIVITY_REPORT_MS).toISOString(), "a minute after the one the link holds: said")
  reporter.sent([at(row(1), ACTIVITY_REPORT_MS)])
  const ended = reporter.reports(link, [at(row(1, "working"), ACTIVITY_REPORT_MS + 5_000)])
  assert.deepEqual(ended[0]?.listed.map((each) => [each.state, each.activityAt]), [["working", new Date(NOW + ACTIVITY_REPORT_MS + 5_000).toISOString()]], "with a state that moved, at once and with its activity")
})

test("a batch that moves what a list shows of its conversation is reported on the next turn, whatever the second's pacing; a batch that moves nothing a list shows waits; a state that flaps is said ten times a second at most", async () => {
  let now = NOW
  let rows = [row(1)]
  let shown: ConversationShown = { state: "idle" }
  const sent: SessionsReport[] = []
  const soon: Array<{ run: () => void; afterMs: number }> = []
  let serving: SessionLink | undefined
  const publisher = new SessionPublisher({
    rows: () => rows,
    shown: (conversation) => (conversation === "c-1" ? shown : undefined),
    now: () => now,
    reportNow: () => publisher.report(serving),
    schedule: (run, afterMs) => { soon.push({ run, afterMs }) },
  })
  serving = { link: await newLink(), served: { version: 6, sessions: (report: SessionsReport) => (sent.push(report), true), live: () => true } }
  publisher.report(serving)
  assert.equal(sent.length, 1, "everything, on a new link")
  // SAFETY: a host event as a live driver emits one, filled only as far as the publisher reads it.
  const batch = (conversation = "c-1") => ({ type: "live-batch", batch: { id: conversation, revision: 3, updates: [] } }) as never
  publisher.own(batch())
  assert.deepEqual(soon.map((each) => each.afterMs), [0], "the first batch heard of it is looked at on the next turn")
  soon.shift()?.run()
  assert.equal(sent.length, 1, "nothing a list shows changed: nothing said")
  now += 200
  // Tokens: every batch is checked, none moves the list.
  for (let token = 0; token < 50; token++) publisher.own(batch())
  publisher.own(batch("c-2"))
  assert.equal(soon.length, 0, "a batch that moves nothing a list shows asks for nothing")
  // The turn starts: said on the next turn, not at the tick, though the last report was a fifth of a second ago.
  shown = { state: "working" }
  rows = [row(1, "working")]
  publisher.own(batch())
  publisher.own(batch())
  assert.deepEqual(soon.map((each) => each.afterMs), [0], "once, on the next turn")
  soon.shift()?.run()
  assert.deepEqual(sent.at(-1)?.listed.map((each) => each.state), ["working"], "said within the second of the last report")
  // Two changes a moment apart (an approval asked, then answered): gathered into the report on the next turn.
  shown = { state: "waiting", waitingOn: "Approve: npm test" }
  publisher.own(batch())
  shown = { state: "working" }
  publisher.own(batch())
  assert.deepEqual(soon.map((each) => each.afterMs), [0], "gathered, on the next turn")
  soon.shift()?.run()
  // A tool call on and off, over and over: ten reports in any second, and the next waits for the second to pass.
  const waits: number[] = []
  for (let flap = 0; flap < 10; flap++) {
    shown = { state: flap % 2 ? "working" : "waiting", waitingOn: flap % 2 ? undefined : "Approve: npm test" }
    publisher.own(batch())
    waits.push(soon[0]?.afterMs ?? -1)
    if (waits.at(-1)! > 0) break
    soon.shift()?.run()
  }
  // Three went at NOW and NOW + 200 (the first look, the turn starting, the approval): seven more go at once.
  assert.deepEqual(waits, [0, 0, 0, 0, 0, 0, 0, 800], "held to ten a second")
  now += 800
  rows = [row(1, "idle")]
  shown = { state: "idle" }
  publisher.own(batch())
  soon.shift()?.run()
  assert.deepEqual([soon.length, sent.at(-1)?.listed.map((each) => each.state)], [0, ["idle"]], "what stands when it goes is what's said")
  // A Thread renamed or a Session archived here: no batch says it, and it's reported at once all the same.
  now += 1_000
  for (const event of [{ type: "thread-titles", titles: [] }, { type: "thread-archives" }]) {
    // SAFETY: host events as the Thread store emits them, filled only as far as the publisher reads them (their type).
    publisher.own(event as never)
    assert.deepEqual(soon.map((each) => each.afterMs), [0], `${event.type}: reported on the next turn`)
    soon.shift()?.run()
    now += 200
  }
  // A change before any link waits for the link's first report, which says everything.
  const later = new SessionPublisher({ rows: () => rows, shown: () => ({ state: "working" }), now: () => now, reportNow: () => {}, schedule: (run, afterMs) => { soon.push({ run, afterMs }) } })
  later.own(batch())
  assert.equal(soon.length, 0, "no link yet: nothing to report on")
})

test("what a conversation's batch is checked against is what its row says", () => {
  const sessions = [summary("c-1", NOW, { title: "Fix the build" }), summary("c-2", NOW), summary("c-3", NOW, { status: "failed" })]
  const working = new Map<string, LifecycleWork["status"]>([["c-1", "waiting"], ["c-2", "running"]])
  const asked: Waiting = { for: "question", line: "A question: which branch?" }
  const waitingOn = (id: string) => (id === "c-1" ? asked : undefined)
  const listed = ownedSessions(host(sessions, { work: [...working].map(([id, status]) => work(id, status)), waiting: { "c-1": asked } }))
  for (const each of sessions) {
    const listedRow = listed.find((candidate) => candidate.conversation === each.session.id)
    const { state, title, waitingOn: on, waitingFor } = listedRow ?? {}
    assert.deepEqual(conversationShown({ session: each.session, working: working.get(each.session.id), waitingOn }), { state, ...title !== undefined && { title }, ...on !== undefined && { waitingOn: on }, ...waitingFor !== undefined && { waitingFor } })
  }
  assert.equal(listed.find((row) => row.conversation === "c-1")?.waitingFor, "question")
})

test("a cloud machine's tick and an account with no link report on one publisher: the list is worked out once, not each second as a new link's", async () => {
  let now = NOW
  let computed = 0
  const sent: SessionsReport[] = []
  const publisher = new SessionPublisher({ rows: () => (computed++, [row(1)]), now: () => now, schedule: () => {} })
  const link = { link: await newLink(), served: { version: 6, sessions: (report: SessionsReport) => (sent.push(report), true), live: () => true } }
  publisher.report(link)
  for (let second = 0; second < 20; second++) {
    now += 1_000
    publisher.report(undefined)
    publisher.report(link)
  }
  assert.deepEqual([computed, sent.length], [1, 1], "nothing changed, the link is the one it was")
  // A report that didn't go is said again in full on the next tick, as on a new link.
  const refusing = { ...link, served: { ...link.served, sessions: () => false } }
  const changed = new SessionPublisher({ rows: () => (computed++, [row(1)]), now: () => now, schedule: () => {} })
  changed.report(refusing)
  now += 1_000
  changed.report(link)
  assert.equal(sent.length, 2)
  assert.ok(sent.at(-1)?.owned, "everything again")
})

test("a watched conversation's batch too large for the gateway goes as the notice to read it again, as a cloud Thread's does", async () => {
  const live: string[] = []
  const publisher = new SessionPublisher({ rows: () => [row(1)], now: () => NOW, schedule: () => {} })
  const link = { link: await newLink(), served: { version: 6, sessions: () => true, live: (_conversation: string, event: Payload) => (live.push(event.text), true) } }
  publisher.report(link)
  publisher.watch(link.link, ["c-1"])
  // SAFETY: a batch as a live driver sends one, filled only as far as the gateway's bound reads it.
  const batch = (text: string) => encodeRuntimeEvent({ type: "live-batch", batch: { id: "c-1", revision: 7, epoch: "e-1", updates: [{ kind: "text", text }] } } as never)
  publisher.event("event", batch("a line"))
  publisher.event("event", batch("x".repeat(MAX_EVENT_BYTES)))
  assert.equal(live.length, 2)
  assert.ok(live.every((line) => Buffer.byteLength(line) <= MAX_EVENT_BYTES), "nothing over the gateway's bound")
  const notice = splitRuntimeEventLine(live[1]!)
  assert.deepEqual(JSON.parse(notice?.payload ?? "{}"), { type: "live-batch", batch: { id: "c-1", revision: 7, epoch: "e-1", updates: [], historyChanged: true } }, "its history changed, at its revision: the watcher reads it again")
  assert.ok(live[0]!.includes("a line"), "one that fits goes whole")
})

test("a watched conversation's updates go out on a link as soon as it's served; what the gateway didn't relay goes again on the next, from what it says it got, once; past what's kept, its watchers read it again", async () => {
  type Sent = { revision: number; n?: number; historyChanged?: boolean }
  const live: Sent[] = []
  const served = { version: 9, sessions: () => true, live: (_conversation: string, event: Payload, numbered?: { n: number }) => {
    const parts = splitRuntimeEventLine(event.text)
    const { batch } = z.object({ batch: z.object({ revision: z.number(), historyChanged: z.boolean().optional() }).loose() }).parse(JSON.parse(parts?.payload ?? "{}"))
    live.push({ revision: batch.revision, ...(numbered && { n: numbered.n }), ...(batch.historyChanged && { historyChanged: true }) })
    return true
  } }
  const publisher = new SessionPublisher({ rows: () => [row(1)], now: () => NOW, schedule: () => {} })
  // SAFETY: a batch as a live driver sends one, filled only as far as the publisher reads it.
  const batch = (revision: number) => encodeRuntimeEvent({ type: "live-batch", batch: { id: "c-1", revision, epoch: "e-1", updates: [] } } as never)
  const first = { link: await newLink(), served }
  publisher.linked(first)
  publisher.watch(first.link, ["c-1"])
  publisher.event("event", batch(1))
  publisher.event("event", batch(2))
  assert.deepEqual(live.map((each) => each.revision), [1, 2], "sent on the link served, with no report first")
  const [one, two] = live.map((each) => each.n!)
  assert.ok(one! < two!, "numbered, rising")
  // The link drops: 2 went into it and was lost; 3 and 4 come while it's down, kept.
  publisher.report(undefined)
  publisher.event("event", batch(3))
  publisher.event("event", batch(4))
  assert.equal(live.length, 2)
  // The gateway on the new link says it relayed 1: 2, 3 and 4 go, in order, under their numbers. Said before or after
  // the link is served, the same.
  const second = { link: await newLink(), served }
  publisher.watch(second.link, ["c-1"], { "c-1": one! })
  assert.equal(live.length, 2, "not before the link is served")
  publisher.linked(second)
  assert.deepEqual(live.slice(2).map((each) => [each.revision, each.n]), [[2, two], [3, two! + 1], [4, two! + 2]])
  assert.deepEqual(publisher.readings(), { watched: 1, resent: 3, notices: 0 }, "Diagnostics counts what went again")
  // Said again with the same word, nothing goes twice.
  publisher.watch(second.link, ["c-1"], { "c-1": two! + 2 })
  assert.equal(live.length, 5)
  // Down while more went by than is kept: its watchers are told to read it again, at the newest revision.
  publisher.report(undefined)
  for (let revision = 5; revision < 5 + 1_100; revision++) publisher.event("event", batch(revision))
  const third = { link: await newLink(), served }
  publisher.linked(third)
  publisher.watch(third.link, ["c-1"], { "c-1": two! + 2 })
  assert.deepEqual(live.slice(5).map(({ revision, historyChanged }) => [revision, historyChanged]), [[1_104, true]], "one notice, at the newest revision, nothing else")
  assert.equal(publisher.readings().notices, 1)
  // A conversation no longer watched keeps nothing.
  publisher.watch(third.link, [])
  publisher.event("event", batch(2_000))
  publisher.watch(third.link, ["c-1"], { "c-1": 1 })
  assert.equal(live.length, 6)
})

test("a report says when it went, and each row whose list-shown fields changed says when they did; an older link hears neither", async () => {
  let now = NOW
  let rows = [row(1)]
  const sent: SessionsReport[] = []
  let shown: ConversationShown = { state: "idle" }
  const publisher = new SessionPublisher({ rows: () => rows, shown: () => shown, now: () => now, reportNow: () => {}, schedule: () => {} })
  const link = { link: await newLink(), served: { version: 9, sessions: (report: SessionsReport) => (sent.push(report), true), live: () => true } }
  publisher.report(link)
  // SAFETY: a host event as a live driver emits one, filled only as far as the publisher reads it.
  const batch = { type: "live-batch", batch: { id: "c-1", revision: 3, updates: [] } } as never
  now += 5_000
  shown = { state: "working" }
  publisher.own(batch)
  const changedAt = new Date(now).toISOString()
  now += 40
  rows = [row(1, "working")]
  publisher.report(link)
  const report = sent.at(-1)!
  assert.equal(report.reportedAt, new Date(now).toISOString())
  assert.equal(report.listed[0]?.changedAt, changedAt, "when the batch moved it, not when the report went")
  const older: SessionsReport[] = []
  const gateway = createFakeGateway()
  const runtime = await serveRuntime(await gateway.connectRuntime(), { runtimeId: "d-old", build: "test", versions: { min: 1, max: NUMBERED_LIVE_VERSION - 1 }, handle: async (operation) => ({ v: 1, id: operation.id, ok: true }) })
  runtime.sessions(report)
  await new Promise((resolve) => setImmediate(resolve))
  older.push(...gateway.reports("d-old"))
  assert.equal(older[0]?.reportedAt, undefined)
  assert.equal(older[0]?.listed[0]?.changedAt, undefined)
  runtime.close()
  await gateway.close()
})

test("one batch in twenty-five is traced, and each that starts or ends a turn, asks or answers; the readings say each followed stream and the account's list in words, every number with its noun", () => {
  const random = () => "0f3a9c2e-71b4"
  assert.equal(traceOf({ revision: 24 }, random), undefined, "an ordinary batch")
  assert.equal(traceOf({ revision: 25 }, random), "st-0f3a9c2e-71b4", "the sampled one")
  // SAFETY: a batch as a live driver emits one, filled only as far as `traceOf` reads it (its revision and status).
  assert.equal(traceOf({ revision: 3, sessionChanges: { status: "running" } } as never, random), "st-0f3a9c2e-71b4", "a turn starting")
  assert.equal(traceOf({ revision: 4, permissions: [] }, random), "st-0f3a9c2e-71b4", "an approval asked or answered")
  let now = NOW
  const readings = new SyncRecorder(() => now)
  const follow = readings.follow("session:d-1:c-1", "Retry the webhooks")
  for (const lag of [40, 60, 80, 400]) follow.heard(now - lag)
  follow.heard()
  follow.gap()
  follow.followedAgain("gap")
  follow.followedAgain("silent")
  follow.reread()
  readings.listHeard(512)
  readings.listChanged(new Date(now - 38).toISOString())
  readings.listGap({ after: 500, seq: 502, why: "skipped" })
  readings.ownerFrom(() => ({ watched: 2, resent: 14, notices: 0 }))
  now += 1_000
  const read = readings.readings()
  assert.deepEqual(read.follows[0]?.lagMs, { samples: 4, p50: 80, p95: 400 })
  assert.equal(describeFollow(read.follows[0]!), "updates arrive in 80 ms typically, 400 ms at worst · 1 skipped update asked for again · read again whole once · followed again twice (skipped an update, went silent)")
  assert.equal(describeList(read.list), "at event 512 · changes arrive in 38 ms typically, 38 ms at worst · read whole again after 1 gap")
  assert.equal(describeOwner(read.owner), "2 conversations watched from another device · 14 updates sent again after a reconnect")
  assert.equal(describeOwner({ watched: 0, resent: 0, notices: 0 }), undefined, "nothing to say")
  for (let index = 0; index < 60; index++) readings.follow(`session:d-1:c-${index + 2}`)
  assert.equal(readings.readings().follows.length, 50, "the latest fifty followed")
})

test("macOS's power reads as pmset says it: the source, the battery, and Low Power Mode in either spelling", () => {
  assert.deepEqual(parsePower("Now drawing from 'AC Power'\n -InternalBattery-0 (id=22806627)\t100%; charged; 0:00 remaining present: true\n", " powermode            2\n"), { onBattery: false, percent: 100, lowPower: false })
  assert.deepEqual(parsePower("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t17%; discharging; 1:02 remaining present: true\n", " powermode            1\n"), { onBattery: true, percent: 17, lowPower: true })
  assert.equal(parsePower("", " lowpowermode         1\n").lowPower, true, "before macOS 14")
  assert.deepEqual(parsePower("", ""), { onBattery: false, percent: undefined, lowPower: false }, "nothing said reads as plugged in")
})

test("a device's Sessions go up at work first, then each Thread whole, the most recently worked in first, by tier; catching up waits on a low battery; the scope always goes before the links", async () => {
  const plugged: PowerReading = { onBattery: false, percent: 100, lowPower: false }
  const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString()
  const at = (base: ReportedSession, activityAt: string, thread: number): ReportedSession => ({ ...base, activityAt, thread: uuid(thread) })
  const rows: ReportedSession[] = [
    // Thread 101: worked in an hour ago, with a Session of 20 days ago that goes with it.
    { ...at(row(1), hoursAgo(1), 101), nativeId: "n-1" },
    { ...at(row(6), hoursAgo(24 * 20), 101), nativeId: "n-6" },
    { ...at(row(2, "working"), hoursAgo(30), 102), nativeId: "n-2" },
    { ...at(row(3), hoursAgo(2), 103), nativeId: "n-3" },
    { ...at(row(4, "waiting"), hoursAgo(24 * 40), 104), nativeId: "n-4" },
    // Thread 105: three days ago; Thread 106: twelve days ago, outside the week.
    { ...at(row(7), hoursAgo(72), 105), nativeId: "n-7" },
    { ...at(row(8), hoursAgo(24 * 12), 106), nativeId: "n-8" },
    at(row(5), hoursAgo(1), 107),
  ]
  const pathOf = (_harness: string, nativeId: string) => (nativeId === "n-3" ? undefined : `/rail/${nativeId}.jsonl`)
  assert.deepEqual(uploadScope(rows, plugged, pathOf, NOW).sessions.map((each) => [each.nativeId, each.tier, each.busy]), [
    ["n-2", "now", true],
    ["n-4", "now", true],
    ["n-1", "day", false],
    ["n-6", "day", false],
    ["n-7", "week", false],
  ], "at work first, then each Thread whole by its last activity, each in its Thread's tier; one older than the week isn't kept; one with no native session yet, or the catalog doesn't list, waits")
  assert.equal(uploadScope(rows, { onBattery: true, percent: UPLOAD_BATTERY_FLOOR - 1, lowPower: false }, pathOf, NOW).paused, true)
  assert.equal(uploadScope(rows, { onBattery: true, percent: UPLOAD_BATTERY_FLOOR, lowPower: false }, pathOf, NOW).paused, false)
  assert.equal(uploadScope(rows, { ...plugged, lowPower: true }, pathOf, NOW).paused, true)

  const said: string[] = []
  let links: UploadLinks = { state: "off", reason: "no-cloud" }
  let listedRows: ReportedSession[] | undefined
  let power = plugged
  let powerReads = 0
  let now = NOW
  const tiers = { now: tierCount(2), day: tierCount(2), week: tierCount(1) }
  const failure = { at: NOW, harness: "codex", nativeId: "n-8", message: "The gateway answered 500 (PUT /chunks answered 500, correlation c-9)", correlationId: "c-9" }
  let catalog: CatalogSyncStatus | null = null
  const uploads = new SessionUploads({
    rows: () => listedRows,
    path: pathOf,
    links: async () => links,
    power: async () => (powerReads++, power),
    scope: async (scope: SyncScope) => void said.push(`scope ${scope.sessions.map((each) => each.nativeId).join(",")}${scope.paused ? " waiting" : ""}`),
    copies: async (given) => void said.push(given ? `copies ${given.authorization}` : "stop copies"),
    originals: async (given) => void said.push(given ? `originals ${given.authorization}` : "stop originals"),
    status: async () => catalog,
    backfill: async () => undefined,
    now: () => now,
  })
  await uploads.tick()
  assert.deepEqual([said, uploads.status()], [[], { state: "off", reason: "no-cloud" }], "no cloud: nothing leaves the Mac, and the status says why")
  const link = (index: string, authorization: string): RecordsLink => ({ id: `d-1/${index}`, base: `https://cloud.test/v1/devices/d-1/${index}`, authorization })
  links = { state: "on", copies: link("records", "Bearer a"), originals: link("originals", "Bearer a") }
  await uploads.tick()
  assert.deepEqual(said, [], "no links before the Sessions are known: they would catch up on the whole store")
  listedRows = rows
  await uploads.tick()
  assert.deepEqual(said, ["scope n-2,n-4,n-1,n-6,n-7", "copies Bearer a", "originals Bearer a"])
  assert.deepEqual(uploads.status(), { state: "starting", sessions: 5 })
  await uploads.tick()
  assert.equal(said.length, 3, "nothing changed: nothing said")
  links = { state: "on", copies: link("records", "Bearer b"), originals: link("originals", "Bearer b") }
  catalog = { paused: false, tiers, stale: 0, copies: activity(), originals: activity([failure]) }
  await uploads.tick()
  assert.deepEqual(said.slice(3), ["copies Bearer b", "originals Bearer b"], "a renewed token, the links again")
  const status = uploads.status()
  assert.equal(status.state, "failing")
  assert.deepEqual("failures" in status ? status.failures : [], [failure], "a failure is said with the gateway's correlation ID")
  // The catalog tries a refused push again, keeping when its failing began: logged once, and again once it fails anew.
  const logged: string[] = []
  const stopHearing = followHostLog((line) => line.scope === "sync" && line.level === "warn" && logged.push(String(line.fields?.["correlationId"])))
  const refused = { ...failure, since: NOW + 1_000, message: "The pack was refused (PUT /chunks answered 400, correlation c-10)", correlationId: "c-10" }
  for (const [at, correlationId] of [[NOW + 1_000, "c-10"], [NOW + 3_000, "c-11"], [NOW + 7_000, "c-12"]] as const) {
    catalog = { ...catalog, originals: activity([{ ...refused, at, correlationId }]) }
    await uploads.tick()
  }
  catalog = { ...catalog, originals: activity([{ ...refused, at: NOW + 60_000, since: NOW + 60_000, correlationId: "c-13" }]) }
  await uploads.tick()
  stopHearing()
  assert.deepEqual(logged, ["c-10", "c-13"], "a failure tried again is logged once, when it began")
  catalog = { ...catalog, originals: activity() }
  await uploads.tick()
  assert.equal(uploads.status().state, "synced", "every Session readable and whole in the account")
  power = { onBattery: true, percent: 12, lowPower: false }
  now += 30_000
  await uploads.tick()
  assert.equal(said.length, 5, "the power read at most once a minute")
  now += 30_000
  await uploads.tick()
  assert.deepEqual(said.slice(5), ["scope n-2,n-4,n-1,n-6,n-7 waiting"])
  assert.equal(powerReads, 2)
  links = { state: "off", reason: "signed-out" }
  await uploads.tick()
  assert.deepEqual(said.slice(6), ["stop copies", "stop originals"], "signed out: it stops")
  assert.deepEqual(uploads.status(), { state: "off", reason: "signed-out" })
})

/** A tier whose `sessions` are all in the account, as one Thread. */
const tierCount = (sessions: number) => ({ sessions, threads: 1, readable: sessions, held: sessions, whole: sessions, inCloud: sessions, threadsInCloud: 1 })
const activity = (failures: SyncFailure[] = []) => ({ sending: [], paused: false, pushes: 1, bytes: 10, failed: failures.length, lastSuccessAt: NOW, failures })

const listed = (n: number, state: ListedSession["state"] = "idle"): ListedSession => ({ ...row(n, state), runsOn: { kind: "device", deviceId: uuid(900) }, listedAt: new Date(NOW).toISOString() })

test("a device's list is the one it read, then each change the stream said after it, in order; one said twice or before the read changes nothing", () => {
  const list = new AccountSessions()
  assert.equal(list.known, false)
  assert.equal(list.heard({ seq: 12, event: { type: "sessions-listed", sessions: [listed(3)] } }), false, "before the read: waits")
  assert.equal(list.heard({ seq: 9, event: { type: "sessions-unlisted", sessions: [uuid(1)] } }), false)
  assert.equal(list.listed({ sessions: [listed(1), listed(2)], seq: 10 }), true)
  assert.deepEqual([...list.sessions().keys()].sort(), [uuid(1), uuid(2), uuid(3)], "the change newer than the read applies; the older doesn't")
  assert.equal(list.heard({ seq: 12, event: { type: "sessions-listed", sessions: [listed(3, "working")] } }), false, "heard twice")
  assert.equal(list.heard({ seq: 13, event: { type: "sessions-listed", sessions: [listed(3, "working")] } }), true)
  assert.equal(list.sessions().get(uuid(3))?.state, "working")
  assert.equal(list.heard({ seq: 14, event: { type: "sessions-unlisted", sessions: [uuid(2)] } }), true)
  assert.equal(list.heard({ seq: 15, event: { type: "sessions-unlisted", sessions: [uuid(2)] } }), false, "already gone")
  assert.equal(list.listed({ sessions: [...list.sessions().values()], seq: 15 }), false, "read again, the same")
  list.clear()
  assert.equal(list.known, false)
})

test("a device's list holds each Session's waiting messages as the list read and the stream said them, in order", () => {
  const list = new AccountSessions()
  const waiting = (id: number, text: string) => ({ id: uuid(500 + id), session: uuid(1), conversation: "c-1", text, from: uuid(900), at: new Date(NOW).toISOString() })
  assert.equal(list.listed({ sessions: [listed(1)], seq: 10, waiting: [waiting(1, "Merge it")] }), true)
  assert.deepEqual(list.waiting(uuid(1)).map((message) => message.text), ["Merge it"])
  assert.equal(list.heard({ seq: 9, event: { type: "messages-waiting", session: uuid(1), messages: [] } }), false, "from before the read: changes nothing")
  assert.equal(list.heard({ seq: 11, event: { type: "messages-waiting", session: uuid(1), messages: [waiting(1, "Merge it"), waiting(2, "Then tag it")] } }), true)
  assert.equal(list.waiting(uuid(1)).length, 2, "said whole, so nothing drifts")
  assert.equal(list.heard({ seq: 12, event: { type: "messages-waiting", session: uuid(1), messages: [] } }), true)
  assert.deepEqual([list.waiting(uuid(1)), list.allWaiting().size], [[], 0], "none once each was taken")
})

test("a device's list holds which devices are quiet, once each, as the list read and the stream said it, in order", () => {
  const list = new AccountSessions()
  const since = new Date(NOW - 3 * 60 * 60_000).toISOString()
  assert.equal(list.heard({ seq: 11, event: { type: "device-quiet", deviceId: uuid(900), since: null } }), false, "before the read: waits")
  assert.equal(list.listed({ sessions: [listed(1, "working")], seq: 10, quiet: [{ deviceId: uuid(900), since }] }), true)
  assert.equal(list.quietSince(uuid(900)), undefined, "back, said after the read")
  assert.equal(list.heard({ seq: 12, event: { type: "device-quiet", deviceId: uuid(900), since } }), true)
  assert.equal(list.quietSince(uuid(900)), since)
  assert.equal(list.sessions().get(uuid(1))?.state, "working", "its rows stand as it left them")
  assert.equal(list.heard({ seq: 13, event: { type: "device-quiet", deviceId: uuid(901), since: null } }), false, "one that wasn't quiet, back: nothing changed")
  assert.equal(list.listed({ sessions: [listed(1, "working")], seq: 13, quiet: [{ deviceId: uuid(900), since }] }), false, "read again, the same")
  assert.equal(list.listed({ sessions: [listed(1, "working")], seq: 14 }), true, "read again from a list that says none")
  assert.equal(list.quietSince(uuid(900)), undefined)
})

test("a device's list holds the account's archived cloud Threads as the list read and the stream said them; it keeps none of its own", () => {
  const list = new AccountSessions()
  const cloudRow = (n: number): ListedSession => ({ ...listed(n), runsOn: { kind: "cloud", threadId: "t-0123456789abcdef" } })
  const archived = { thread: "t-0123456789abcdef", move: uuid(700), archivedAt: new Date(NOW).toISOString(), by: uuid(900), sessions: [cloudRow(1)] }
  assert.equal(list.listed({ sessions: [cloudRow(1), listed(2)], seq: 10 }), true)
  assert.equal(list.archived().size, 0)
  // Archived from another device: its Sessions leave the list first (as an older Mac reads it), then it's kept archived.
  assert.equal(list.heard({ seq: 11, event: { type: "sessions-unlisted", sessions: [uuid(1)] } }), true)
  assert.equal(list.heard({ seq: 12, event: { type: "thread-archived", thread: archived } }), true)
  assert.deepEqual([[...list.sessions().keys()], [...list.archived().keys()]], [[uuid(2)], ["t-0123456789abcdef"]])
  assert.equal(list.heard({ seq: 12, event: { type: "thread-archived", thread: archived } }), false, "heard twice")
  assert.equal(list.listed({ sessions: [listed(2)], seq: 12, archived: [archived] }), false, "read again, the same")
  // Taken back by its Mac: it leaves the archived ones, and that Mac lists its Sessions as its own.
  assert.equal(list.heard({ seq: 13, event: { type: "thread-unarchived", thread: "t-0123456789abcdef" } }), true)
  assert.equal(list.archived().size, 0)
  assert.equal(list.heard({ seq: 14, event: { type: "thread-unarchived", thread: "t-0123456789abcdef" } }), false, "already back")
  assert.equal(list.listed({ sessions: [], seq: 20 }), true)
  assert.equal(list.archived().size, 0, "a gateway that says none archived: none")
})

test("a conversation its owner archived isn't listed: every other device drops it, as it would a closed one", () => {
  const rows = ownedSessions(host([summary("c-1", NOW - 1_000), summary("c-2", NOW - 2_000)], { archived: ["c-1"] }))
  assert.deepEqual(rows.map((row) => row.conversation), ["c-2"])
})

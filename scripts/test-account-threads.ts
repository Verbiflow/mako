import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import type { Waiting } from "@mako/protocol/attention"
import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { MAX_EVENT_BYTES, NUMBERED_LIVE_VERSION, serveRuntime, type Payload } from "@mako/protocol"
import { LISTED_FINS, ListedSessionSchema, ReportedSessionSchema, rowsForLink, type ListedFin, type ListedSession, type ReportedSession, type SessionsReport } from "@mako/protocol/thread-listing"
import { randomUUID } from "node:crypto"
import { entryState, type ChildState } from "@mako/host/contracts/agents"
import { childLine, childStateOf, childWord, finsAsChildren, listedFins, orderedChildren, rollup } from "@mako/host/contracts/children"
import { CHILDREN_BINDING, type NativeAgent } from "@mako/host/contracts/native-agents"
import { AccountSessions } from "@mako/protocol/account-sessions"
import { MovesUnderWay } from "@mako/host/conversations/moves-under-way"
import { SENT_EVERY_MS, SentProgress } from "@mako/host/conversations/cloud-moves"
import type { MoveSent } from "@mako/host/contracts/cloud-threads"
import { ACTIVITY_REPORT_MS, conversationShown, FINS_COALESCE_MS, finAsking, nativeConversation, ownedSessions, REPORT_WORK, SessionPublisher, SessionReporter, SWEEP_MS, type ConversationShown, type NativeRow, type ReportSources, type SessionLink } from "@mako/host/conversations/session-report"
import { namedWork } from "@mako/host/base/event-loop"
import type { ExternalThreadActivity } from "@mako/host/contracts/host-events-boot"
import type { CheckoutHead } from "@mako/host/contracts/checkout-heads"
import { SessionUploads, sessionTitles, syncStatusOf, uploadScope, UPLOAD_BATTERY_FLOOR, type UploadLinks } from "@mako/host/conversations/session-uploads"
import { describeSending } from "@mako/host/contracts/sync-status"
import { followHostLog } from "@mako/host/base/host-log"
import { SYNC_WINDOW_MS } from "@mako/host/conversations/sync-window"
import { threadArchiveKey } from "@mako/host/contracts/thread-lifecycle"
import { parsePower, type PowerReading } from "@mako/host/base/power"
import type { RecordsLink } from "@mako/sessions/record-sync"
import type { CatalogSyncStatus, SyncFailure, SyncScope } from "@mako/sessions/scoped-uploads"
import type { LifecycleWork } from "@mako/host/contracts/app-lifecycle"
import type { LiveSummary } from "@mako/host/contracts/live-conversations"
import { nativeStartedAt, personPromptedAt } from "@mako/host/contracts/worked-at"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { auditSnapshot } from "./performance-audit-fixtures.js"
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

test("a fork's row says the Session it was forked from, read for every row in one call; a Session that began another way says nothing", () => {
  const asked: number[] = []
  const sources: ReportSources = {
    ...host([summary("c-1", NOW - 3_000), summary("c-2", NOW - 2_000), summary("c-3", NOW - 1_000)]),
    // SAFETY: test IDs in the Thread store's shapes, which brand plain UUIDs.
    forks: (sessions) => (asked.push(sessions.length), new Map([[uuid(2), uuid(1)]]) as never),
  }
  const rows = ownedSessions(sources)
  assert.deepEqual(rows.map((row) => [row.conversation, row.forkOf]), [["c-3", undefined], ["c-2", uuid(1)], ["c-1", undefined]])
  assert.deepEqual(asked, [3])
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
  assert.deepEqual(rows.map((each) => each.openElsewhere), [undefined, undefined, undefined, undefined, true], "the one its app has open, at rest, wears the ring this Mac's rail draws")
  const held = ownedSessions(host([], {
    native: [nativeRow(41, NOW - 1_000, { locked: true }), nativeRow(42, NOW - 2_000, { locked: true, heldBy: "Mako's host (pid 81)" })],
  }))
  assert.deepEqual(held.map((each) => each.openElsewhere), [true, undefined], "a session file its app locks is open there; one another Mako host holds is still Mako's")
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

test("a publisher reports when something changed, reconciles every few minutes regardless, and relays a conversation's updates only while watched on that link", async () => {
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
  assert.equal(sent.length, 3, "half a minute on, nothing changed by an event, nothing recomputed")
  now += SWEEP_MS
  publisher.report(link)
  assert.equal(sent.length, 4, "the reconcile finds what changed without an event")

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

test("a row says what its owner's rail shows of it: the project it's filed under and that project's checkout, its worktree, its earlier agents, its background work", () => {
  const heads = new Map<string, CheckoutHead>([["/Users/ana/api", { kind: "rebasing", name: "pricing-table" }], ["/Users/ana/site", { kind: "branch", name: "main", linked: { path: "/Users/ana/site", repoRoot: "/Users/ana/site" } }]])
  const live = summary("c-1", NOW - 1_000, { cwd: "/Users/ana/.mako/worktrees/api-3f2a/retry-webhooks/src" })
  live.nativeIds = [{ provider: "devin", nativeId: "d-1" }, { provider: "claude", nativeId: "cl-1" }, { provider: "claude", nativeId: "cl-2" }, { provider: "codex", nativeId: "cx-1" }]
  const waiting = summary("c-2", NOW - 2_000, { cwd: "/Users/ana/site" })
  const sources: ReportSources = {
    ...host([live, waiting], { work: [work("c-2", "running")], native: [nativeRow(41, NOW - 3_000, { cwd: "/Users/ana/api-wt/payments", worktrees: [{ path: "/Users/ana/api-wt", repoRoot: "/Users/ana/api" }], lineage: [{ harness: "devin" }] })] }),
    worktree: (folder) => (folder.startsWith("/Users/ana/.mako/worktrees/api-3f2a/retry-webhooks") ? { project: `/Users/ana/api${folder.slice("/Users/ana/.mako/worktrees/api-3f2a/retry-webhooks".length)}`, branch: "mako/retry-webhooks" } : undefined),
    head: (project) => heads.get(project),
    background: (id) => (id === "c-2" ? 25 : undefined),
  }
  const rows = ownedSessions(sources)
  const row = (conversation: string) => rows.find((each) => each.conversation === conversation)
  assert.deepEqual(row("c-1")?.project, { folder: "/Users/ana/api/src" }, "a Thread worktree's Session is filed under the project it was made from, at the same place inside")
  assert.deepEqual(row("c-1")?.worktree, { branch: "mako/retry-webhooks" })
  assert.deepEqual(row("c-1")?.lineage, ["devin", "claude"], "the agents it ran in before its current one, each once in a row")
  assert.equal(row("c-1")?.background, undefined, "nothing left running: no count")
  assert.deepEqual(row("c-2")?.project, { folder: "/Users/ana/site", head: { kind: "branch", name: "main" } }, "the project's checkout, without where its main checkout is")
  assert.deepEqual([row("c-2")?.state, row("c-2")?.background], ["working", 25], "at work on what its ended turn left running, and how many")
  const terminal = rows.find((each) => each.capture)
  assert.deepEqual(terminal?.project, { folder: "/Users/ana/api/payments" }, "a terminal's session in a linked worktree is filed under its main checkout")
  assert.deepEqual(terminal?.lineage, ["devin"])
  heads.set("/Users/ana/api/src", { kind: "branch", name: "main" })
  assert.deepEqual(ownedSessions(sources).find((each) => each.conversation === "c-1")?.project?.head, { kind: "branch", name: "main" }, "once the project's checkout is read, its rows say it")
  assert.equal(conversationShown({ session: { id: "c-3", status: "running" }, working: "running", waitingOn: () => undefined, background: 3 }).background, undefined, "a turn at work is at work, whatever else runs")
})

test("an Apex's row waits on its Fin's ask that's the person's, saying what it stood at under it, and its own ask goes first", () => {
  const fin = ThreadIdSchema.parse("00000000-0000-4000-8000-00000000f1f1")
  const asks = finAsking({ fin, name: "push-wording", line: "Which tone? Plain or friendly?", ask: { kind: "report", id: "report:1", options: [{ label: "Plain" }, { label: "x".repeat(120) }, ...Array.from({ length: 6 }, (_, index) => ({ label: `more ${index}` }))], recommended: 7 }, more: 2 })
  assert.deepEqual(asks?.asking, { fin, name: "push-wording", ask: "report:1", options: ["Plain", `${"x".repeat(79)}…`, "more 0", "more 1", "more 2", "more 3"], more: 2 }, "six options at most, each clipped, and a recommendation past them dropped")
  const working = conversationShown({ session: { id: "apex", status: "running" }, working: "running", waitingOn: () => undefined, background: 2, asking: () => asks })
  assert.deepEqual({ state: working.state, waitingOn: working.waitingOn, waitingFor: working.waitingFor, under: working.asking?.under, background: working.background }, { state: "waiting", waitingOn: "push-wording: Which tone? Plain or friendly?", waitingFor: "question", under: "working", background: undefined })
  assert.equal(conversationShown({ session: { id: "apex", status: "ready" }, working: undefined, waitingOn: () => undefined, asking: () => asks }).asking?.under, "idle", "an Apex at rest under it rests")
  // What its own agent asked through Mako's tools leaves it working and waits on the person; its Fins stay on its row.
  const fins: ListedFin[] = [{ thread: ThreadIdSchema.parse(randomUUID()), name: "first", harness: "cursor", state: { kind: "working" }, startedAt: new Date(NOW).toISOString() }]
  const asked = conversationShown({ session: { id: "apex", status: "running" }, working: "running", waitingOn: () => undefined, background: 2, asking: () => asks, asked: () => ({ for: "needs-you", line: "Wants to move this Thread to the cloud" }), fins: () => fins })
  assert.deepEqual([asked.state, asked.waitingFor, asked.waitingOn, asked.background, asked.asking, asked.fins], ["waiting", "needs-you", "Wants to move this Thread to the cloud", undefined, undefined, fins])
  const own = conversationShown({ session: { id: "apex", status: "running" }, working: "waiting", waitingOn: () => ({ for: "approval", line: "Approve: git push" }), asking: () => asks })
  assert.deepEqual({ state: own.state, waitingOn: own.waitingOn, asking: own.asking }, { state: "waiting", waitingOn: "Approve: git push", asking: undefined }, "its own ask first")
  const approval = finAsking({ fin, name: "sheet-motion", line: "Approve: npm ci", ask: { kind: "approval", id: "a-1" }, more: 0 })
  assert.deepEqual(approval, { waiting: { for: "approval", line: "sheet-motion: Approve: npm ci" }, asking: { fin, name: "sheet-motion", ask: "a-1" } })
  // A limit's notice asks nothing and is no Fin's: no "has a question", and its line isn't cut short by a name.
  const notice = finAsking({ fin, name: "Usage", line: "Cursor ran out until Sun 12:00 AM PST.", ask: { kind: "report", id: "limit:cursor::1", options: [{ label: "Got it" }] }, more: 0 })
  assert.deepEqual(notice?.waiting, { for: "needs-you", line: "Cursor ran out until Sun 12:00 AM PST." })
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
  reporter.sent([at(row(1, "working"), ACTIVITY_REPORT_MS + 5_000)])
  // Its worktree's branch tracked since, the row idle: a continue clones what the row says, so it goes at once.
  const tracked = { ...at(row(1, "working"), ACTIVITY_REPORT_MS + 5_000), repository: { url: "https://github.com/octocat/Hello-World", branch: "master" } }
  assert.deepEqual(reporter.reports(link, [tracked])[0]?.listed.map((each) => each.repository), [tracked.repository], "a repository that moved: at once")
  reporter.sent([tracked])
  assert.deepEqual(reporter.reports(link, [tracked]), [], "said once")
})

test("a row says when the person last sent its Session a message, from whichever device; Mako's and an agent's turns aren't theirs; a new one is said at once", async () => {
  const person = { kind: "person" } as const
  const requests = [
    { actor: person, createdAt: NOW - 50_000 },
    { createdAt: NOW - 40_000 },
    { actor: { kind: "service" } as const, createdAt: NOW - 30_000 },
    { actor: { kind: "agent" } as const, createdAt: NOW - 20_000 },
    { actor: person },
  ]
  assert.equal(personPromptedAt(requests), NOW - 40_000, "a goal's next turn and an agent's handoff aren't the person's; a host without a Thread store names nobody, and that's them")
  assert.equal(personPromptedAt([]), undefined)
  // SAFETY: the two fields `personPromptedAt` reads of an action.
  const steer = (createdAt: number, kind: "steer" | "compact") => ({ input: { kind }, createdAt }) as never
  assert.equal(personPromptedAt(requests, [steer(NOW - 10_000, "steer"), steer(NOW - 5_000, "compact")]), NOW - 10_000, "a steer into a running turn is a message; compacting isn't")

  const rows = ownedSessions(host([{ ...summary("c-1", NOW - 60_000), promptedAt: NOW - 10_000 }, summary("c-2", NOW - 30_000)]))
  assert.deepEqual(rows.map((row) => [row.conversation, row.promptedAt]), [["c-2", undefined], ["c-1", new Date(NOW - 10_000).toISOString()]], "the summary's time, said on the row; none while the person's sent nothing")
  assert.equal(conversationShown({ session: { id: "c-1", status: "running" }, working: "running", waitingOn: () => undefined, promptedAt: NOW - 1_000 }).promptedAt, new Date(NOW - 1_000).toISOString(), "a batch is checked against it by the row's own rule")

  const reporter = new SessionReporter()
  const link = await newLink()
  reporter.sent(reporter.reports(link, [row(1, "working")]).flatMap((report) => report.listed))
  const prompted = { ...row(1, "working"), activityAt: new Date(NOW + 1_000).toISOString(), promptedAt: new Date(NOW + 1_000).toISOString() }
  assert.equal(reporter.reports(link, [prompted])[0]?.listed[0]?.promptedAt, prompted.promptedAt, "a message into a turn already running is said at once, though its state didn't move: every rail moves its project")

  const started = nativeRow(1, NOW - 5_000)
  const nativeRows = ownedSessions(host([], { native: [started] }))
  assert.equal(nativeRows[0]?.createdAt, new Date(nativeStartedAt(started)!).toISOString(), "a terminal session starts when the rail says it did, the one rule every rail ranks it by")
  assert.equal(nativeRows[0]?.promptedAt, undefined, "and no host saw its prompts arrive")
})

test("a journal says when the person last sent it a message without being read whole, as its resident snapshot does", () => {
  const root = mkdtempSync(join(tmpdir(), "mako-prompted-"))
  try {
    const snapshot = auditSnapshot(3)
    snapshot.requests = snapshot.requests.map((request, index) => ({ ...request, createdAt: NOW + index * 1_000, actor: index === 2 ? { kind: "service", name: "goal" } : request.actor }))
    const journal = new LiveJournal(root, snapshot.session.id)
    journal.commit(snapshot)
    journal.close()
    const reopened = new LiveJournal(root, snapshot.session.id)
    assert.equal(reopened.summary()?.promptedAt, NOW + 1_000, "the goal's turn after the person's isn't theirs")
    assert.equal(personPromptedAt(snapshot.requests, snapshot.control?.actions), NOW + 1_000, "the same time a loaded one's summary reads")
    reopened.close()
    const file = join(root, `${snapshot.session.id}.sqlite`)
    const raw = new DatabaseSync(file)
    raw.exec("DELETE FROM prompted")
    raw.close()
    const older = new LiveJournal(root, snapshot.session.id)
    assert.equal(older.summary()?.promptedAt, NOW + 1_000, "a journal from before it was kept reads its requests")
    older.close()
    const read = new DatabaseSync(file, { readOnly: true })
    assert.deepEqual({ ...read.prepare("SELECT at, requests FROM prompted").get() }, { at: NOW + 1_000, requests: 3 }, "once: it keeps the answer, and how many requests it read")
    read.close()
    // An older build that knows nothing of `prompted` takes a message in, and leaves the row as it was.
    const elder = new DatabaseSync(file)
    elder.prepare("INSERT INTO requests VALUES (?, ?)").run(uuid(9), JSON.stringify({ ...snapshot.requests[0], id: uuid(9), createdAt: NOW + 9_000 }))
    elder.close()
    const upgraded = new LiveJournal(root, snapshot.session.id)
    assert.equal(upgraded.summary()?.promptedAt, NOW + 9_000, "a request the row didn't count is read again, never a stale time")
    upgraded.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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

test("an Apex's row says its Fins; a change to them alone waits a quarter second for the others with it, and anything else still goes at once", async () => {
  let rows = [row(1)]
  const fin = (name: string, state: ListedFin["state"]): ListedFin => ({ thread: ThreadIdSchema.parse(randomUUID()), name, harness: "cursor", state, startedAt: new Date(NOW).toISOString() })
  let shown: ConversationShown = { state: "working", fins: [fin("one", { kind: "working", step: "Reading a" })] }
  const sent: SessionsReport[] = []
  const soon: Array<{ run: () => void; afterMs: number }> = []
  let serving: SessionLink | undefined
  const publisher = new SessionPublisher({
    rows: () => rows,
    shown: (conversation) => (conversation === "c-1" ? shown : undefined),
    now: () => NOW,
    reportNow: () => publisher.report(serving),
    schedule: (run, afterMs) => { soon.push({ run, afterMs }) },
  })
  serving = { link: await newLink(), served: { version: 19, sessions: (report: SessionsReport) => (sent.push(report), true), live: () => true } }
  publisher.report(serving)
  // SAFETY: a host event as a live driver emits one, filled only as far as the publisher reads it.
  const batch = () => ({ type: "live-batch", batch: { id: "c-1", revision: 3, updates: [] } }) as never
  publisher.own(batch())
  soon.shift()?.run()
  for (const step of ["Reading b", "Reading c", "Editing d"]) {
    shown = { ...shown, fins: [fin("one", { kind: "working", step })] }
    publisher.own(batch())
  }
  assert.deepEqual(soon.map((each) => each.afterMs), [FINS_COALESCE_MS], "three steps of a Fin: one report, a quarter second on")
  rows = [{ ...row(1), fins: shown.fins }]
  soon.shift()?.run()
  assert.deepEqual(soon.map((each) => each.afterMs), [0], "then on the next turn, as any change")
  soon.shift()?.run()
  assert.deepEqual(sent.at(-1)?.listed.map((each) => each.fins?.[0]?.state), [{ kind: "working", step: "Editing d" }], "what stands when it goes is what's said")
  shown = { state: "waiting", waitingOn: "Approve: git push", fins: shown.fins }
  publisher.own(batch())
  assert.deepEqual(soon.map((each) => each.afterMs), [0], "the Apex's own change goes on the next turn, its Fins with it")
  assert.deepEqual(conversationShown({ session: { id: "apex", status: "running" }, working: "running", waitingOn: () => undefined, fins: () => shown.fins }).fins, shown.fins, "the row says the Fins its roster lists")
  assert.equal(conversationShown({ session: { id: "apex", status: "running" }, working: "running", waitingOn: () => undefined, fins: () => undefined }).fins, undefined)
})

test("a row's Fins read on another device count, order and say each Fin as its owner's roster does, for any roster", () => {
  const cut = (line: string | undefined) => line?.slice(0, 100)
  // SAFETY: a blocked Fin's ask, filled only as far as `listedFinState` reads it (it drops the ask whole).
  const states: ChildState[] = [
    { kind: "queued", reason: "place-full", ahead: 3 }, { kind: "queued", reason: "tree-running", ahead: 0 }, { kind: "starting", step: "launching" },
    { kind: "working", step: `Running ${"x".repeat(400)}` }, { kind: "working", phase: "Reading the brief" }, { kind: "working" }, { kind: "idle" },
    { kind: "blocked", question: "Which branch?", on: "person", ask: { id: "a-1", kind: "question" } as never }, { kind: "blocked", question: "Plain or friendly?", on: "lead" },
    { kind: "blocked", question: "Approve: npm ci", on: "approval" }, { kind: "ended", outcome: "done" }, { kind: "ended", outcome: "failed", reason: "exit 1" }, { kind: "ended", outcome: "stopped" },
    { kind: "queued", reason: "tree-running", ahead: 0, after: ["li-protocol", "x".repeat(300)] }, { kind: "queued", reason: "tree-running", ahead: 1, after: ["li-flage"], held: "li-flage" },
    { kind: "queued", reason: "place-full", ahead: 0, refused: `It didn't start: ${"x".repeat(300)}` }, { kind: "queued", reason: "tree-running", ahead: 0, apexStopped: true },
    { kind: "ended", outcome: "done", decision: { question: "Merge #371?", on: "person", ask: { id: "d-1", kind: "question" } } }, { kind: "ended", outcome: "done", decision: { question: "Pick one", on: "lead", ask: { id: "d-2", kind: "question" } } },
    { kind: "ended", outcome: "stopped", reason: "out of usage", unfinished: true }, { kind: "working", answered: { by: "person", answer: `Merge ${"x".repeat(390)}` } },
    { kind: "idle", waitingOn: [{ kind: "pull-request", ref: "Verbiflow/mako#386", repository: "Verbiflow/mako", number: 386, until: "checks" }, { kind: "person", what: "merge" }, { kind: "other", text: "the deploy" }], since: NOW - 60_000 },
    // What a roster says that no selector reads: it stays with the owner.
    { kind: "blocked", question: "Which?", on: "person", waitingOn: [{ kind: "person", what: "merge" }] }, { kind: "ended", outcome: "done", waitingOn: [{ kind: "other", text: "the deploy" }] },
  ]
  let seed = 7
  const next = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n)
  for (let run = 0; run < 300; run++) {
    const roster: NativeAgent[] = Array.from({ length: next(LISTED_FINS) + 1 }, (_, index) => {
      const state = states[next(states.length)]!
      const at = NOW - next(10_000) * 1_000
      return { nativeId: `mako-child:${index}`, title: `fin-${index}`, work: "agent", background: true, state: entryState(state), bindingId: CHILDREN_BINDING, provider: ["cursor", "claude", "codex"][next(3)]!, observedAt: at, startedAt: at, child: { thread: ThreadIdSchema.parse(randomUUID()), name: `fin-${index}`, origin: "started", state } }
    })
    const fins = listedFins(roster)!
    assert.ok(ReportedSessionSchema.parse({ ...row(1), fins }), "what the owner lists, the protocol carries")
    const elsewhere = finsAsChildren(ListedSessionSchema.parse({ ...row(1), runsOn: { kind: "device", deviceId: uuid(9) }, listedAt: new Date(NOW).toISOString(), fins }).fins)
    assert.deepEqual(rollup(orderedChildren(elsewhere)), rollup(roster), "the same counts every surface shows")
    assert.deepEqual(orderedChildren(elsewhere).map((agent) => agent.child?.thread), orderedChildren(roster).map((agent) => agent.child?.thread), "in the same order")
    assert.deepEqual(elsewhere.map((agent) => childWord(childStateOf(agent))), orderedChildren(roster).map((agent) => childWord(childStateOf(agent))), "each with the same word")
    assert.deepEqual(elsewhere.map((agent) => cut(childLine(childStateOf(agent), NOW))), orderedChildren(roster).map((agent) => cut(childLine(childStateOf(agent), NOW))), "and the same line, as far as a row keeps of it")
    assert.ok(finsAsChildren(fins) === finsAsChildren(fins), "the same entries while the row's Fins are")
  }
  assert.equal(listedFins([]), undefined, "an Apex with no Fins says none")
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

test("a batch reworks its own conversation's row, never the whole list; the whole list is worked out on a structural change and at the reconcile", async () => {
  let now = NOW
  let whole = 0
  const asked: string[][] = []
  const sent: SessionsReport[] = []
  let activity = NOW
  const rowOf = (n: number) => ({ ...row(n, "working"), activityAt: new Date(activity).toISOString() })
  const publisher = new SessionPublisher({
    rows: () => (whole++, [row(1), row(2), row(3)]),
    rowsOf: (conversations) => (asked.push([...conversations]), [...conversations].map((conversation) => rowOf(Number(conversation.slice(2))))),
    now: () => now,
    schedule: () => {},
  })
  const link = { link: await newLink(), served: { version: 6, sessions: (report: SessionsReport) => (sent.push(report), true), live: () => true } }
  publisher.report(link)
  assert.equal(whole, 1)
  // SAFETY: a host event as a live driver emits one, filled only as far as the publisher reads it.
  const batch = (conversation: string) => ({ type: "live-batch", batch: { id: conversation, revision: 3, updates: [] } }) as never
  for (let second = 1; second <= 10; second++) {
    activity = NOW + second * 1_000
    publisher.own(batch("c-2"))
    now += 1_000
    publisher.report(link)
  }
  assert.equal(whole, 1, "a working conversation's batches don't rework the whole list")
  assert.equal(asked.length, 10)
  assert.ok(asked.every((each) => each.length === 1 && each[0] === "c-2"), "each report reworks the conversation its batches came for")
  assert.deepEqual(sent.slice(1).map((each) => each.listed.map((listed) => `${listed.conversation} ${listed.state}`)), [["c-2 working"]], "and says its row alone, once, as it changed")
  assert.equal(publisher.listed()?.length, 3, "the rest of the list stays")
  now += 1_000
  publisher.report(link)
  assert.equal(asked.length, 10, "nothing moved, nothing is worked out")
  publisher.showsChanged()
  now += 1_000
  publisher.report(link)
  assert.equal(whole, 2, "a change of the list itself (an archive, a rename) reworks it whole")
  now += 30_000
  publisher.own(batch("c-1"))
  publisher.report(link)
  assert.equal(whole, 2, "half a minute on, a batch still reworks its own row alone")
  now += SWEEP_MS
  publisher.own(batch("c-1"))
  publisher.report(link)
  assert.equal(whole, 3, "and the reconcile, a few minutes after the last whole one, reworks it whole, for what moves without an event")
})

test("a conversation's work moving with no batch (a checkpoint released, a start settled) reworks its row alone, on the next turn", async () => {
  let now = NOW
  let whole = 0
  const asked: string[][] = []
  const sent: SessionsReport[] = []
  let state: ReportedSession["state"] = "working"
  const soon: Array<() => void> = []
  let serving: SessionLink | undefined
  const publisher = new SessionPublisher({
    rows: () => (whole++, [row(1), row(2, state)]),
    rowsOf: (conversations) => (asked.push([...conversations]), [...conversations].map((conversation) => row(Number(conversation.slice(2)), state))),
    now: () => now,
    reportNow: () => publisher.report(serving),
    schedule: (run) => { soon.push(run) },
  })
  serving = { link: await newLink(), served: { version: 6, sessions: (report: SessionsReport) => (sent.push(report), true), live: () => true } }
  publisher.report(serving)
  state = "idle"
  publisher.conversationMoved("c-2")
  assert.equal(soon.length, 1, "asked for at once, as a change a list shows")
  now += 10
  soon.shift()!()
  assert.equal(whole, 1, "the whole list isn't worked out")
  assert.deepEqual(asked, [["c-2"]], "its own row is")
  assert.deepEqual(sent.at(-1)!.listed.map((each) => `${each.conversation} ${each.state}`), ["c-2 idle"], "and goes now, not at the reconcile")
})

test("a look at the uploads that left something undone says so, and one that didn't, doesn't", async () => {
  const link = { id: "l-1", base: "https://gateway.test/", authorization: "Bearer t" }
  let refuse = true
  let throwLinks = false
  const uploads = new SessionUploads({
    rows: () => [row(1)],
    path: () => undefined,
    links: async () => {
      if (throwLinks) throw new Error("the account didn't answer")
      return { state: "on", copies: link, originals: { ...link, id: "l-2" } }
    },
    power: async () => ({ onBattery: false, percent: undefined, lowPower: false }),
    scope: async () => {},
    copies: async () => { if (refuse) throw new Error("the catalog's process was busy") },
    originals: async () => {},
    status: async () => null,
    backfill: async () => undefined,
    now: () => NOW,
  })
  await uploads.tick()
  assert.equal(uploads.needsRetry(), true, "links the catalog didn't take are tried again on their own")
  refuse = false
  await uploads.tick()
  assert.equal(uploads.needsRetry(), false, "taken, nothing's left")
  throwLinks = true
  await assert.rejects(uploads.tick())
  assert.equal(uploads.needsRetry(), true, "a look that threw is tried again")
})

test("a native session's write or catalog row reworks its own rows, never the whole list; one gone from the window reworks it whole", async () => {
  let now = NOW
  let whole = 0
  const native: string[][] = []
  const sent: SessionsReport[] = []
  let gone = false
  // Three native sessions at /n/1, /n/2 and /n/3, their rows s-1 to s-3; /n/2's goes working.
  let second: ReportedSession["state"] = "idle"
  const nativeRow = (n: number, state: ReportedSession["state"] = "idle") => ({ ...row(n, state), conversation: `native:${n}`, session: `s-${n}` })
  const publisher = new SessionPublisher({
    rows: () => (whole++, [nativeRow(1), nativeRow(2, second), nativeRow(3)]),
    rowsOfNative: (paths) => {
      native.push([...paths])
      if (gone) return undefined
      const rows = [...paths].map((path) => nativeRow(Number(path.slice(3)), path === "/n/2" ? second : "idle"))
      return { rows, sessions: new Set(rows.map((each) => each.session)) }
    },
    now: () => now,
    schedule: () => {},
  })
  const link = { link: await newLink(), served: { version: 6, sessions: (report: SessionsReport) => (sent.push(report), true), live: () => true } }
  publisher.report(link)
  assert.equal(whole, 1)
  for (let tick = 1; tick <= 10; tick++) {
    second = tick % 2 ? "working" : "idle"
    publisher.nativeChanged("/n/2")
    now += 1_000
    publisher.report(link)
  }
  assert.equal(whole, 1, "a native session writing all the while doesn't rework the whole list")
  assert.equal(native.length, 10)
  assert.ok(native.every((each) => each.length === 1 && each[0] === "/n/2"), "each report reworks the session that moved")
  assert.ok(sent.slice(1).every((each) => each.listed.length === 1 && each.listed[0]!.session === "s-2"), "and says its row alone")
  assert.equal(publisher.listed()?.length, 3, "the rest of the list stays")
  now += 1_000
  publisher.report(link)
  assert.equal(native.length, 10, "nothing moved, nothing is worked out")
  gone = true
  publisher.nativeChanged("/n/3")
  now += 1_000
  publisher.report(link)
  assert.equal(whole, 2, "a session the window no longer holds can't be told apart: the whole list is worked out")
  gone = false
  publisher.changed()
  now += 1_000
  publisher.report(link)
  assert.equal(whole, 3, "a structural change (a catalog rescan) reworks it whole")
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
  assert.deepEqual(publisher.readings(), { watched: 1, compact: 0, negotiated: false, resent: 3, notices: 0 }, "Diagnostics counts what went again")
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
  readings.ownerFrom(() => ({ watched: 2, compact: 1, negotiated: true, resent: 14, notices: 0 }))
  now += 1_000
  const read = readings.readings()
  assert.deepEqual(read.follows[0]?.lagMs, { samples: 4, p50: 80, p95: 400 })
  assert.equal(describeFollow(read.follows[0]!), "updates arrive in 80 ms typically, 400 ms at worst · 1 skipped update asked for again · read again whole once · followed again twice (skipped an update, went silent)")
  assert.equal(describeList(read.list), "at event 512 · changes arrive in 38 ms typically, 38 ms at worst · read whole again after 1 gap")
  readings.listFrom(() => [{ promptedAt: new Date(NOW).toISOString() }, {}, { promptedAt: new Date(NOW).toISOString() }])
  assert.equal(describeList(readings.readings().list), "at event 512 · changes arrive in 38 ms typically, 38 ms at worst · read whole again after 1 gap · 2 of 3 Sessions say when you last wrote to them; the rest rank by their start", "how many rows a rail can rank by your messages, and that the rest go by their start")
  assert.equal(describeOwner(read.owner), "2 conversations watched from another device · 1 sent whole, as a device watching reads only the older form · 14 updates sent again after a reconnect")
  assert.equal(describeOwner({ watched: 0, compact: 0, negotiated: false, resent: 0, notices: 0 }), undefined, "nothing to say")
  for (let index = 0; index < 60; index++) readings.follow(`session:d-1:c-${index + 2}`)
  assert.equal(readings.readings().follows.length, 50, "the latest fifty followed")
})

test("macOS's power reads as pmset says it: the source, the battery, and Low Power Mode in either spelling", () => {
  assert.deepEqual(parsePower("Now drawing from 'AC Power'\n -InternalBattery-0 (id=22806627)\t100%; charged; 0:00 remaining present: true\n", " powermode            2\n"), { onBattery: false, percent: 100, lowPower: false })
  assert.deepEqual(parsePower("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t17%; discharging; 1:02 remaining present: true\n", " powermode            1\n"), { onBattery: true, percent: 17, lowPower: true })
  assert.equal(parsePower("", " lowpowermode         1\n").lowPower, true, "before macOS 14")
  assert.deepEqual(parsePower("", ""), { onBattery: false, percent: undefined, lowPower: false }, "nothing said reads as plugged in")
})

test("a device's Sessions go up at work first, then each Thread whole, the most recently worked in first, by tier; catching up waits on a low battery; the first scope goes before the links", async () => {
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
    { ...at(row(8), hoursAgo(24 * 12), 106), nativeId: "n-8", title: "Codex's own title", threadTitle: "Retry the webhooks" },
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
  let statusRead: Error | undefined
  const uploads = new SessionUploads({
    rows: () => listedRows,
    path: pathOf,
    links: async () => links,
    power: async () => (powerReads++, power),
    scope: async (scope: SyncScope) => void said.push(`scope ${scope.sessions.map((each) => each.nativeId).join(",")}${scope.paused ? " waiting" : ""}`),
    copies: async (given) => void said.push(given ? `copies ${given.authorization}` : "stop copies"),
    originals: async (given) => void said.push(given ? `originals ${given.authorization}` : "stop originals"),
    status: async () => {
      if (statusRead) throw statusRead
      return catalog
    },
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
  assert.deepEqual("failures" in status ? status.failures : [], [{ ...failure, title: "Retry the webhooks" }], "a failure is said with the gateway's correlation ID, and named by its Thread's title")
  // The catalog's process too busy to answer in time: the status it last answered stands.
  statusRead = new Error("The sync daemon didn't answer sync-status within 3000ms")
  await uploads.tick()
  assert.deepEqual(uploads.status(), status, "a status read that failed shows and hides nothing")
  statusRead = undefined
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

test("a renewed token reaches the catalog while it's too busy to take the scope, and at once when it says a link is due", async () => {
  const said: string[] = []
  let scopeAnswers = true
  let listed: ReportedSession[] = [{ ...row(1, "working"), nativeId: "n-1" }]
  const link = (index: string, authorization: string): RecordsLink => ({ id: `d-1/${index}`, base: `https://cloud.test/v1/devices/d-1/${index}`, authorization })
  let links: UploadLinks = { state: "on", copies: link("records", "Bearer a"), originals: link("originals", "Bearer a") }
  const uploads = new SessionUploads({
    rows: () => listed,
    path: (_harness, nativeId) => `/rail/${nativeId}.jsonl`,
    links: async () => links,
    power: async () => ({ onBattery: false, percent: 100, lowPower: false }),
    scope: async (scope) => {
      if (!scopeAnswers) throw new Error("The sync daemon request timed out")
      said.push(`scope ${scope.sessions.map((each) => each.nativeId).join(",")}`)
    },
    copies: async (given) => void said.push(`copies ${given?.authorization}`),
    originals: async (given) => void said.push(`originals ${given?.authorization}`),
    status: async () => null,
    backfill: async () => undefined,
    now: () => NOW,
  })
  await uploads.renew()
  assert.deepEqual(said, [], "no links before the first scope, asked or not")
  await uploads.tick()
  assert.deepEqual(said, ["scope n-1", "copies Bearer a", "originals Bearer a"])
  // Every Fin at work moves the scope at each tick, and the catalog's process, held, answers none of them in time.
  scopeAnswers = false
  listed = [...listed, { ...row(2, "working"), nativeId: "n-2" }]
  links = { state: "on", copies: link("records", "Bearer b"), originals: link("originals", "Bearer b") }
  await assert.rejects(uploads.tick(), /timed out/)
  assert.deepEqual(said.slice(3), ["copies Bearer b", "originals Bearer b"], "the renewed links went before the scope that timed out")
  links = { state: "on", copies: link("records", "Bearer c"), originals: link("originals", "Bearer c") }
  await uploads.renew()
  assert.deepEqual(said.slice(5), ["copies Bearer c", "originals Bearer c"], "a link the catalog says is due goes at once, not at the next tick")
})

/** A tier whose `sessions` are all in the account, as one Thread. */
const tierCount = (sessions: number) => ({ sessions, threads: 1, readable: sessions, held: sessions, whole: sessions, inCloud: sessions, threadsInCloud: 1 })
const activity = (failures: SyncFailure[] = []) => ({ sending: [], paused: false, pushes: 1, bytes: 10, failed: failures.length, lastSuccessAt: NOW, failures })

test("a tick works out the scope only when something it's made from moved, and always hears the catalog", async () => {
  const synced = { ...tierCount(1), inCloud: 1 }
  let catalog: CatalogSyncStatus = { paused: false, tiers: { now: synced, day: synced, week: synced }, stale: 0, copies: activity(), originals: activity() }
  let listed: ReportedSession[] = [{ ...row(1), nativeId: "n-1" }]
  let now = NOW
  let children = 0
  let version = "1"
  let scopes = 0
  let known = new Set(["n-1"])
  const given: string[] = []
  const link = (authorization: string): RecordsLink => ({ id: "d-1/records", base: "https://cloud.test/v1/devices/d-1/records", authorization })
  let links: UploadLinks = { state: "on", copies: link("Bearer a"), originals: link("Bearer a") }
  const uploads = new SessionUploads({
    rows: () => listed,
    path: (_harness, nativeId) => (known.has(nativeId) ? `/rail/${nativeId}.jsonl` : undefined),
    agents: () => (children += 1, new Map()),
    scopeVersion: () => version,
    links: async () => links,
    power: async () => ({ onBattery: false, percent: 100, lowPower: false }),
    scope: async () => void (scopes += 1),
    copies: async (taken) => void given.push(String(taken?.authorization)),
    originals: async () => {},
    status: async () => catalog,
    backfill: async () => undefined,
    now: () => now,
  })
  const tick = async () => {
    now += 5_000
    await uploads.tick()
  }
  await uploads.tick()
  assert.equal(uploads.status().state, "synced")
  const first = children
  for (let at = 0; at < 5; at += 1) await tick()
  assert.equal(children, first, "five quiet ticks don't work out the scope")

  catalog = { ...catalog, copies: activity([{ at: NOW, harness: "codex", nativeId: "n-1", message: "refused" }]) }
  await tick()
  assert.equal(uploads.status().state, "failing", "the catalog's word is heard on the next tick, quiet or not")
  assert.equal(children, first, "without working out the scope")
  catalog = { ...catalog, copies: activity() }
  await tick()

  listed = [...listed, { ...row(2), nativeId: "n-2" }]
  known = new Set([...known, "n-2"])
  await tick()
  assert.equal(children, first + 1, "a new Session is looked at on the next tick")
  version = "2"
  await tick()
  assert.equal(children, first + 2, "and so is anything the version says moved: a new Fin, or a file newly listed")

  now += 60_000
  await uploads.tick()
  assert.equal(children, first + 3, "a minute on it looks again, as the power is read again")

  links = { state: "on", copies: link("Bearer b"), originals: link("Bearer b") }
  await tick()
  assert.deepEqual(given.at(-1), "Bearer b", "a renewed token goes on the next tick")
})

test("signing out and into another account during a quiet stretch reads the new account at once", async () => {
  const synced = { ...tierCount(1), inCloud: 1 }
  const catalog: CatalogSyncStatus = { paused: false, tiers: { now: synced, day: synced, week: synced }, stale: 0, copies: activity(), originals: activity() }
  let now = NOW
  const given: (string | undefined)[] = []
  const link = (authorization: string): RecordsLink => ({ id: "d-1/records", base: "https://cloud.test/v1/devices/d-1/records", authorization })
  let links: UploadLinks = { state: "on", copies: link("Bearer a"), originals: link("Bearer a") }
  const uploads = new SessionUploads({
    rows: () => listed,
    path: (_harness, nativeId) => `/rail/${nativeId}.jsonl`,
    scopeVersion: () => "same",
    links: async () => links,
    power: async () => ({ onBattery: false, percent: 100, lowPower: false }),
    scope: async () => {},
    copies: async (taken) => void given.push(taken?.authorization),
    originals: async () => {},
    status: async () => catalog,
    backfill: async () => undefined,
    now: () => now,
  })
  const listed: ReportedSession[] = [{ ...row(1), nativeId: "n-1" }]
  await uploads.tick()
  assert.equal(uploads.status().state, "synced")
  links = { state: "off", reason: "signed-out" }
  now += 5_000
  await uploads.tick()
  assert.deepEqual(uploads.status(), { state: "off", reason: "signed-out" }, "signing out stops it at once")
  links = { state: "on", copies: link("Bearer b"), originals: link("Bearer b") }
  now += 5_000
  await uploads.tick()
  assert.deepEqual(given, ["Bearer a", undefined, "Bearer b"])
  assert.equal(uploads.status().state, "synced", "and the status says so, not a minute on")
})

test("the Sessions not synced are one line each, its copy's or its records', the longest failing first, with how many in all and how many only retrying", () => {
  const failing = (nativeId: string, since: number, kind: SyncFailure["kind"]): SyncFailure => ({ at: NOW, since, harness: "codex", nativeId, kind, message: `${nativeId} failed`, correlationId: `c-${nativeId}` })
  const scope: SyncScope = { sessions: [], paused: false }
  const tiers = { now: tierCount(2), day: tierCount(2), week: tierCount(1) }
  const copies = { ...activity([failing("a", NOW - 1_000, "unreachable"), failing("b", NOW - 9_000, "refused")]), retrying: 1 }
  const originals = { ...activity([failing("b", NOW - 5_000, "refused"), ...["c", "d", "e", "f", "g"].map((id, n) => failing(id, NOW - 100 * n, "unreachable"))]), retrying: 2 }
  const titles = sessionTitles([{ ...row(1), nativeId: "b", title: "Its own title" }, { ...row(2), nativeId: "a", title: " " }])
  const status = syncStatusOf(scope, { paused: false, tiers, stale: 0, copies, originals }, undefined, titles)
  assert.ok("failures" in status)
  assert.deepEqual(status.failures.map((failure) => failure.title), ["Its own title", undefined, undefined, undefined, undefined], "named by its own title without a Thread's; a blank one names nothing")
  assert.equal(status.state, "failing")
  assert.deepEqual(status.failures.map((failure) => [failure.nativeId, failure.since, failure.kind]), [["b", NOW - 9_000, "refused"], ["a", NOW - 1_000, "unreachable"], ["g", NOW - 400, "unreachable"], ["f", NOW - 300, "unreachable"], ["e", NOW - 200, "unreachable"]], "b once, since its copy began failing; the longest failing first")
  assert.deepEqual([status.notSynced, status.retrying], [7, 3])
  assert.match(describeSending(status), /^7 Sessions not synced; the first: the account turned down part of it \(correlation c-b\)\. 3 Sessions retrying after a failed push/)
  // Retrying only: not failing, and said only in Diagnostics.
  const retrying = syncStatusOf(scope, { paused: false, tiers, stale: 0, copies: { ...activity(), retrying: 1 }, originals: activity() }, undefined)
  assert.ok("failures" in retrying)
  assert.deepEqual([retrying.state, retrying.failures, retrying.retrying], ["synced", [], 1])
})

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

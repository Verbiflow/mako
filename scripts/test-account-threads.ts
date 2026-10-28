import assert from "node:assert/strict"
import { test } from "node:test"
import type { Payload } from "@mako/protocol"
import { rowsForLink, type ListedSession, type ReportedSession, type SessionsReport } from "@mako/protocol/thread-listing"
import { AccountSessions } from "@mako/host/conversations/account-threads"
import { LISTED_FOR_MS, nativeConversation, ownedSessions, SessionPublisher, SessionReporter, type NativeRow, type ReportSources } from "@mako/host/conversations/session-report"
import type { ExternalThreadActivity } from "@mako/host/contracts/host-events-boot"
import { SessionUploads, uploadScope, UPLOAD_BATTERY_FLOOR } from "@mako/host/conversations/session-uploads"
import { parsePower, type PowerReading } from "@mako/host/base/power"
import type { RecordsLink } from "@mako/sessions/record-sync"
import type { CopyScope } from "@mako/sessions/reading-copies"
import type { LifecycleWork } from "@mako/host/contracts/app-lifecycle"
import type { LiveSummary } from "@mako/host/contracts/live-conversations"
import { DeviceIdSchema, MoveIdSchema, RuntimeIdSchema, type SessionExecution } from "@mako/host/contracts/thread-execution"
import { createFakeGateway } from "@mako/protocol/fake-gateway"
import { encodeRuntimeEvent } from "@mako/host/contracts/runtime-value"

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
function host(summaries: LiveSummary[], options: { work?: LifecycleWork[]; executions?: Record<string, SessionExecution>; waiting?: Record<string, string>; moved?: Record<string, number>; title?: string; native?: NativeRow[]; activity?: Record<string, ExternalThreadActivity>; archived?: string[] } = {}): ReportSources {
  const index = (id: string) => Number(id.slice(2))
  return {
    summaries: () => summaries,
    native: () => options.native ?? [],
    activity: (path) => options.activity?.[path],
    work: () => options.work ?? [],
    waitingOn: (id) => options.waiting?.[id],
    archived: (id) => options.archived?.includes(id) ?? false,
    lastMoved: (id) => options.moved?.[id],
    // SAFETY: test IDs in the Thread store's shapes, which brand plain UUIDs.
    placement: (id) => ({ thread: uuid(100), session: uuid(index(id)) }) as never,
    execution: (session) => options.executions?.[session],
    thread: () => (options.title ? { title: options.title, titleSource: "user" } : { title: "made by an old build", titleSource: "auto" }),
    now: () => NOW,
  }
}

test("a host lists the Sessions it owns, newest first, each as the lifecycle sees it, at the generation its store holds", () => {
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
      waiting: { "c-2": "Approve: npm test" },
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
    ["c-4", "idle", 3],
    ["c-3", "working", 1],
    ["c-1", "failed", 1],
  ], "closed and elsewhere aren't listed; a Session in transit is, as moving, at its generation")
  assert.equal(rows[0]?.waitingOn, "Approve: npm test")
  assert.equal(rows[0]?.threadTitle, "Webhooks")
  assert.equal(rows.find((row) => row.conversation === "c-1")?.title, "Fix the flaky test")
  assert.equal(ownedSessions(host([summary("c-1", NOW)]))[0]?.threadTitle, undefined, "an older build's automatic title isn't shown anywhere")
})

test("a Session moved more than 30 days ago isn't listed unless it works or waits; when it moved is its journal's last write", () => {
  const old = NOW - LISTED_FOR_MS - 1
  const rows = ownedSessions(host([summary("c-1", old), summary("c-2", old), summary("c-3", old)], { work: [work("c-2", "running")], moved: { "c-3": NOW - 60_000 } }))
  assert.deepEqual(rows.map((row) => row.conversation).sort(), ["c-2", "c-3"])
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
      // At rest, within 30 days; and older than the list keeps.
      nativeRow(25, NOW - 6_000),
      nativeRow(26, NOW - LISTED_FOR_MS - 1),
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
  assert.equal(waiting?.title, "Terminal session 21")
  assert.equal(waiting?.folder, "/Users/ana/api")
  assert.deepEqual(waiting?.capture, { path: nativeRow(21, 0).path }, "its device opens it by the path its catalog reads it at")
  assert.equal(rows[3]?.nativeId, "native-24", "the newer of a Session's two sessions")
  assert.equal(nativeConversation(uuid(21)), nativeConversation(uuid(21)), "named from its Session, the same on every device")
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
  const publisher = new SessionPublisher({ rows: () => rows, now: () => now })
  const link = { link: await newLink(), served: served() }
  publisher.report(link)
  assert.equal(sent.length, 1)
  publisher.report(link)
  assert.equal(sent.length, 1, "not again within the second")
  now += 2_000
  publisher.report(link)
  assert.equal(sent.length, 1, "nothing changed: nothing recomputed")
  rows = [row(1, "working")]
  publisher.changed()
  now += 2_000
  publisher.report(link)
  assert.equal(sent.length, 2)
  rows = [row(1, "idle")]
  now += 31_000
  publisher.report(link)
  assert.equal(sent.length, 3, "the sweep finds what changed without an event")

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
  // A gateway older than the frame hears nothing.
  const older = new SessionPublisher({ rows: () => rows, now: () => now })
  const before = sent.length
  older.report({ link: await newLink(), served: served(4) })
  assert.equal(sent.length, before)
})

test("macOS's power reads as pmset says it: the source, the battery, and Low Power Mode in either spelling", () => {
  assert.deepEqual(parsePower("Now drawing from 'AC Power'\n -InternalBattery-0 (id=22806627)\t100%; charged; 0:00 remaining present: true\n", " powermode            2\n"), { onBattery: false, percent: 100, lowPower: false })
  assert.deepEqual(parsePower("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t17%; discharging; 1:02 remaining present: true\n", " powermode            1\n"), { onBattery: true, percent: 17, lowPower: true })
  assert.equal(parsePower("", " lowpowermode         1\n").lowPower, true, "before macOS 14")
  assert.deepEqual(parsePower("", ""), { onBattery: false, percent: undefined, lowPower: false }, "nothing said reads as plugged in")
})

test("a device's history goes up at work first, then newest first; catching up waits on a low battery; the scope always goes before the link", async () => {
  const plugged: PowerReading = { onBattery: false, percent: 100, lowPower: false }
  const rows: ReportedSession[] = [
    { ...row(1), nativeId: "n-1" },
    { ...row(2, "working"), nativeId: "n-2" },
    { ...row(3), nativeId: "n-3" },
    { ...row(4, "waiting"), nativeId: "n-4" },
    row(5),
  ]
  const pathOf = (_harness: string, nativeId: string) => (nativeId === "n-3" ? undefined : `/rail/${nativeId}.jsonl`)
  assert.deepEqual(uploadScope(rows, plugged, pathOf).sessions.map((each) => [each.nativeId, each.path, each.busy]), [["n-2", "/rail/n-2.jsonl", true], ["n-4", "/rail/n-4.jsonl", true], ["n-1", "/rail/n-1.jsonl", false]], "at work first, each as listed, where the rail reads it; one with no native session yet, or the rail doesn't list, waits")
  assert.equal(uploadScope(rows, { onBattery: true, percent: UPLOAD_BATTERY_FLOOR - 1, lowPower: false }, pathOf).paused, true)
  assert.equal(uploadScope(rows, { onBattery: true, percent: UPLOAD_BATTERY_FLOOR, lowPower: false }, pathOf).paused, false)
  assert.equal(uploadScope(rows, { ...plugged, lowPower: true }, pathOf).paused, true)

  const said: string[] = []
  let link: RecordsLink | undefined
  let listedRows: ReportedSession[] | undefined
  let power = plugged
  let powerReads = 0
  let now = 0
  const uploads = new SessionUploads({
    rows: () => listedRows,
    path: pathOf,
    link: async () => link,
    power: async () => (powerReads++, power),
    scope: async (scope: CopyScope) => void said.push(`scope ${scope.sessions.map((each) => each.nativeId).join(",")}${scope.paused ? " waiting" : ""}`),
    sync: async (given) => void said.push(given ? `link ${given.authorization}` : "stop"),
    now: () => now,
  })
  await uploads.tick()
  assert.deepEqual(said, [], "signed out, or no cloud: nothing leaves the Mac")
  link = { id: "d-1", base: "https://cloud.test/v1/devices/d-1/records", authorization: "Bearer a" }
  await uploads.tick()
  assert.deepEqual(said, [], "no link before the Sessions are known: it would catch up on the whole store")
  listedRows = rows
  await uploads.tick()
  assert.deepEqual(said, ["scope n-2,n-4,n-1", "link Bearer a"])
  await uploads.tick()
  assert.equal(said.length, 2, "nothing changed: nothing said")
  link = { ...link, authorization: "Bearer b" }
  await uploads.tick()
  assert.deepEqual(said.slice(2), ["link Bearer b"], "a renewed token, the link again")
  power = { onBattery: true, percent: 12, lowPower: false }
  now += 30_000
  await uploads.tick()
  assert.equal(said.length, 3, "the power read at most once a minute")
  now += 30_000
  await uploads.tick()
  assert.deepEqual(said.slice(3), ["scope n-2,n-4,n-1 waiting"])
  assert.equal(powerReads, 2)
  link = undefined
  await uploads.tick()
  assert.deepEqual(said.slice(4), ["stop"], "signed out: it stops")
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

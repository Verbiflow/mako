import assert from "node:assert/strict"
import { test } from "node:test"
import type { Payload } from "@mako/protocol"
import type { ListedSession, ReportedSession, SessionsReport } from "@mako/protocol/thread-listing"
import { AccountSessions } from "@mako/host/conversations/account-threads"
import { LISTED_FOR_MS, ownedSessions, SessionPublisher, SessionReporter, type ReportSources } from "@mako/host/conversations/session-report"
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
function host(summaries: LiveSummary[], options: { work?: LifecycleWork[]; executions?: Record<string, SessionExecution>; waiting?: Record<string, string>; moved?: Record<string, number>; title?: string } = {}): ReportSources {
  const index = (id: string) => Number(id.slice(2))
  return {
    summaries: () => summaries,
    work: () => options.work ?? [],
    waitingOn: (id) => options.waiting?.[id],
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

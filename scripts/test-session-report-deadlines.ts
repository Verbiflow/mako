import assert from "node:assert/strict"
import { mock } from "node:test"
import { createFakeGateway } from "@mako/protocol/fake-gateway"
import type { ReportedSession, SessionsReport } from "@mako/protocol/thread-listing"
import { SessionPublisher, SWEEP_MS, type SessionLink } from "@mako/host/conversations/session-report"
import { Foreground } from "@mako/host/base/foreground"

/** Actual publisher, controlled time and in-memory links; no installed host, account or network. */
const gateway = createFakeGateway()
const link = await gateway.connectRuntime()
const replacement = await gateway.connectRuntime()
mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 100_000 })
const row = (i: number): ReportedSession => ({ session: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, thread: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, conversation: `c-${i}`, harness: "fixture", state: "idle", createdAt: "2026-11-01T00:00:00.000Z", activityAt: "2026-11-01T00:00:00.000Z", generation: 1 })
const tick = (ms: number) => {
  if (!ms) { mock.timers.tick(0); return }
  for (let i = 0; i < ms; i += 100) mock.timers.tick(Math.min(100, ms - i))
}
const publishers: SessionPublisher[] = []
function fixture(size = 1, foreground?: Foreground) {
  let rows: ReportedSession[] | undefined = Array.from({ length: size }, (_, i) => row(i))
  let calls = 0, reads = 0, partial = 0
  let fault: "refuse" | "send" | "read" | undefined
  const sent: SessionsReport[] = []
  const current: SessionLink = { link, served: { version: 28, live: () => true, ephemeral: () => true, sessions: (report) => {
    if (fault === "send") throw new Error("fixture send failed")
    if (fault === "refuse") return false
    sent.push(report); return true
  } } }
  let serving: SessionLink | undefined = current
  const publisher = new SessionPublisher({
    foreground,
    rows: () => { reads++; if (fault === "read") throw new Error("fixture rows failed"); return rows },
    rowsOf: (keys) => { partial++; return rows?.filter((each) => keys.has(each.conversation)) },
    reportNow: () => { calls++; publisher.report(serving) },
  })
  publishers.push(publisher)
  return { publisher, current, sent, setRows: (next: typeof rows) => { rows = next }, setFault: (next: typeof fault) => { fault = next }, serve: (next: typeof serving) => { serving = next; publisher.report(next) }, stats: () => ({ calls, reads, partial }) }
}
// SAFETY: a driver batch filled only as far as the publisher reads; no runtime is launched.
const batch = () => ({ type: "live-batch", batch: { id: "c-0", revision: 2, updates: [] } }) as never
try {
  const idle = fixture(2_000)
  idle.publisher.linked(idle.current); tick(0)
  tick(600_000)
  assert.deepEqual(idle.stats(), { calls: 3, reads: 3, partial: 0 }, "only initial and five-minute reconciles wake an unchanged publisher")
  assert.equal(idle.sent.length, 10, "the same initial 2,000 rows go once; unchanged reconciles send no frames")
  const candidate = { seconds: 600, rows: 2_000, reportCalls: idle.stats().calls, wholeReads: idle.stats().reads, frames: idle.sent.length }
  idle.publisher.close()

  const paced = fixture()
  paced.publisher.linked(paced.current); tick(0)
  tick(100); paced.setRows([{ ...row(0), state: "working" }]); paced.publisher.changed()
  tick(899)
  assert.equal(paced.sent.length, 1)
  tick(1)
  assert.equal(paced.sent[1]?.listed[0]?.state, "working", "a 200 ms early look that was paced waits on its own remaining deadline, without a tick")
  paced.setRows([{ ...row(0), state: "idle" }]); paced.publisher.conversationMoved("c-0"); tick(0)
  assert.equal(paced.sent.at(-1)?.listed[0]?.state, "idle", "an urgent visible state bypasses normal pacing")
  paced.publisher.close()

  const streaming = fixture()
  streaming.publisher.linked(streaming.current); tick(0)
  for (let second = 1; second <= 60; second++) {
    streaming.setRows([{ ...row(0), activityAt: new Date(Date.parse(row(0).activityAt) + second * 1_000).toISOString() }])
    streaming.publisher.own(batch()); tick(1_000)
  }
  assert.deepEqual(streaming.stats(), { calls: 61, reads: 1, partial: 60 })
  assert.equal(streaming.sent.length, 2, "activity alone still goes at minute granularity while a batch reworks only its row")
  streaming.publisher.close()

  const loading = fixture()
  loading.setRows(undefined); loading.publisher.linked(loading.current); tick(0); tick(1_000)
  assert.equal(loading.stats().reads, 2)
  assert.equal(loading.sent.length, 0)
  loading.setRows([row(0)]); tick(1_000)
  assert.ok(loading.sent[0]?.owned, "a catalog not ready at enrolment is retried until it can report")
  loading.publisher.close()

  const failed = fixture()
  failed.setFault("refuse"); failed.publisher.linked(failed.current); tick(0); tick(1_000)
  assert.equal(failed.stats().calls, 2, "refused reports retry without a new event")
  failed.setFault("send"); tick(1_000)
  failed.setFault("read"); tick(1_000)
  failed.setFault(undefined); tick(1_000)
  assert.equal(failed.stats().calls, 5)
  assert.ok(failed.sent[0]?.owned, "a send/read exception recovers with a full report")
  failed.publisher.close()

  const reconnect = fixture()
  reconnect.publisher.linked(reconnect.current); tick(0)
  reconnect.publisher.changed(); reconnect.publisher.own(batch())
  reconnect.serve(undefined)
  const disconnected = reconnect.stats()
  tick(SWEEP_MS * 2)
  assert.deepEqual(reconnect.stats(), disconnected, "disconnect cancels the deadline and makes already queued early reports inert")
  const fresh = { ...reconnect.current, link: replacement }
  reconnect.publisher.linked(fresh); reconnect.serve(fresh)
  assert.ok(reconnect.sent.at(-1)?.owned, "the replacement link hears everything again")
  reconnect.publisher.changed(); reconnect.publisher.own(batch()); reconnect.publisher.conversationMoved("c-0")
  reconnect.publisher.close()
  const closed = reconnect.stats()
  tick(SWEEP_MS * 2)
  assert.deepEqual(reconnect.stats(), closed, "close cancels deadlines and guards every queued early report before stores are released")
  reconnect.publisher.linked(fresh); tick(0)
  assert.deepEqual(reconnect.stats(), closed, "a closed publisher cannot be rearmed")

  const older = fixture()
  const unsupported = { ...older.current, served: { ...older.current.served, version: 4 } }
  older.publisher.linked(unsupported); tick(SWEEP_MS)
  assert.equal(older.stats().calls, 0, "an unsupported link owns no report deadline")

  const foreground = new Foreground()
  const held = fixture(1, foreground)
  held.publisher.linked(held.current); tick(0)
  const release = foreground.hold("fixture start", SWEEP_MS * 4)
  tick(SWEEP_MS)
  assert.equal(held.stats().calls, 1, "a quiet reconcile waits behind foreground work without a polling timer")
  held.setRows([{ ...row(0), state: "working" }]); held.publisher.conversationMoved("c-0"); tick(0)
  assert.equal(held.sent.at(-1)?.listed[0]?.state, "working", "a visible state still goes immediately during foreground work")
  release(); await Promise.resolve()
  assert.equal(held.stats().calls, 2, "the old quiet waiter was retired by the urgent report")
  const releaseAgain = foreground.hold("fixture next start", SWEEP_MS * 4)
  tick(SWEEP_MS)
  held.publisher.close(); releaseAgain(); await Promise.resolve()
  assert.equal(held.stats().calls, 2, "a pending foreground waiter cannot touch stores after close")
  console.log(JSON.stringify({ candidate, proof: "actual publisher with controlled clock and in-memory link, not measured host CPU/latency" }))
  console.log("session report deadlines: initial/unready, idle reconcile, paced/urgent/streaming changes, refusal/throw recovery, disconnect/reconnect and close pass")
} finally {
  for (const publisher of publishers) publisher.close()
  mock.timers.reset()
}

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import * as migrationForms from "../dist/live-form.js"
import { SESSION_ORDER_VERSION, ADVERTISE_LINK_VERSION, LEND_LINK_VERSION, QUIET_PROJECT_LINK_VERSION, QUIET_OTHERS_LINK_VERSION, LINK_VERSION, PROTOCOL_VERSION, SUPPORTED_VERSIONS, negotiate, decodeRuntimeFrame, encodeRuntimeFrame, WireError, serveRuntime } from "../dist/index.js"
import { ReportedSessionSchema, ListedSessionSchema, rowsForLink, sameListed } from "../dist/thread-listing.js"
import { createFakeGateway } from "../dist/fake-gateway.js"
describe("Session order and borrowing version migration", () => {
  const row = { session: "00000000-0000-4000-8000-000000000001", thread: "00000000-0000-4000-8000-000000000002", conversation: "wire-migration", harness: "codex", state: "idle", createdAt: "2026-11-09T00:00:00.000Z", activityAt: "2026-11-09T00:00:00.000Z", generation: 1, order: 0 }
  test("landed Session order keeps 22; advertisements and lending each have their own later gate", () => {
    assert.equal(SESSION_ORDER_VERSION, 22)
    assert.equal(ADVERTISE_LINK_VERSION, 23)
    assert.equal(LEND_LINK_VERSION, 24)
    assert.equal(QUIET_PROJECT_LINK_VERSION, 25)
    assert.equal(QUIET_OTHERS_LINK_VERSION, 26)
    assert.equal(LINK_VERSION, 26)
    assert.equal(PROTOCOL_VERSION, 1)
    assert.equal(SUPPORTED_VERSIONS.min, 1)
    for (const maximum of [20, 21, 22, 23, 24, 25, 26]) assert.equal(negotiate(SUPPORTED_VERSIONS, { min: 1, max: maximum }), maximum)
  })
  test("order survives strict row, report and wire parsing from 22, and is stripped before 22 without mutating the owner", () => {
    for (const version of [20, 21, 22, 23, 24]) {
      const rows = rowsForLink([row], version)
      assert.equal(Object.hasOwn(rows[0], "order"), version >= 22)
      assert.deepEqual(decodeRuntimeFrame(encodeRuntimeFrame({ type: "sessions", report: { listed: rows, gone: [] } })).report.listed, rows)
    }
    assert.equal(row.order, 0)
    assert.equal(ReportedSessionSchema.parse(row).order, 0)
  })
  test("wire schemas keep refusing unknown fields, invalid order and unknown frames", () => {
    for (const order of [-1, 1.5, 100001, "0", null]) assert.equal(ReportedSessionSchema.safeParse({ ...row, order }).success, false)
    for (const extra of [{ unknown: true }, { token: "not-a-credential" }]) assert.equal(ReportedSessionSchema.safeParse({ ...row, ...extra }).success, false)
    assert.throws(() => decodeRuntimeFrame(JSON.stringify({ type: "sessions", report: { listed: [{ ...row, unknown: true }], gone: [] } })), WireError)
    assert.throws(() => decodeRuntimeFrame(JSON.stringify({ type: "future-unknown-frame" })), WireError)
  })
  test("a changed owner order is a changed listed row", () => {
    const listed = { ...row, runsOn: { kind: "device", deviceId: "00000000-0000-4000-8000-000000000003" }, listedAt: row.createdAt }
    assert.equal(sameListed(listed, { ...listed }), true)
    assert.equal(sameListed(listed, { ...listed, order: 1 }), false)
    assert.equal(sameListed({ ...listed, order: undefined }, listed), false)
  })
  test("older row filtering preserves the existing Fin, capture and report gates", () => {
    const rich = { ...row, fins: [{ thread: "00000000-0000-4000-8000-000000000004", name: "fin", harness: "codex", state: { kind: "queued", reason: "place-full", ahead: 2 }, startedAt: row.createdAt }], waitingFor: "approval", waitingOn: "Approve: test" }
    assert.deepEqual(rowsForLink([rich], 21)[0].fins, rich.fins)
    assert.deepEqual(rowsForLink([rich], 20)[0].fins, rich.fins)
    assert.equal(rowsForLink([rich], 18)[0].fins, undefined)
    assert.equal(rowsForLink([rich], 9)[0].waitingFor, undefined)
    assert.equal(rowsForLink([{ ...row, capture: "terminal" }], 5).length, 0)
  })
  test("current main window roster exports survive, while network live forms still stop at 2", () => {
    assert.equal(migrationForms.ROSTER_LIVE_FORM, 3)
    assert.equal(migrationForms.WINDOW_LIVE_FORM, 3)
    assert.equal(migrationForms.saidWindowForm("3"), 3)
    assert.equal(migrationForms.saidLiveForm("3"), 2)
    assert.equal(migrationForms.LIVE_FORM, 2)
    assert.equal(migrationForms.declaredLiveForm(new URL("https://example.invalid?live=3")), 2)
    assert.equal(migrationForms.readsLiveForm(3, 2), true)
  })
  test("listed readers still strip future fields while keeping the known owner order", () => {
    const listed = { ...row, runsOn: { kind: "device", deviceId: "00000000-0000-4000-8000-000000000003" }, listedAt: row.createdAt }
    const read = ListedSessionSchema.parse({ ...listed, futureField: true })
    assert.equal(Object.hasOwn(read, "futureField"), false)
    assert.equal(read.order, 0)
  })
  test("actual runtime senders and the gateway lending path honor 21/22/23/24 separately", async () => {
    const gateway = createFakeGateway()
    try {
      for (const version of [21, 22, 23, 24]) {
        const heard = []
        const runtime = await serveRuntime(await gateway.connectRuntime(), { runtimeId: `v${version}`, build: "wire-migration", versions: { min: 1, max: version }, lending: { asked: () => heard.push("asked"), lent: () => heard.push("lent"), ended: () => heard.push("ended") }, handle: async () => assert.fail("no operation expected") })
        try {
          assert.equal(runtime.version, version)
          assert.equal(runtime.advertise({ capabilities: [], slots: { used: 0, of: 1 }, at: 1 }), version >= 23)
          assert.equal(runtime.beat("lease"), version >= 24)
          assert.equal(gateway.lend(`v${version}`, { type: "lent-ended", lease: "lease", why: "revoked" }), version >= 24)
          await new Promise(resolve => setImmediate(resolve))
          assert.equal(gateway.advertisements(`v${version}`).length, version >= 23 ? 1 : 0)
          assert.equal(gateway.beats(`v${version}`).length, version >= 24 ? 1 : 0)
          assert.deepEqual(heard, version >= 24 ? ["ended"] : [])
        } finally { runtime.close(); await runtime.done }
      }
    } finally { await gateway.close() }
  })
})

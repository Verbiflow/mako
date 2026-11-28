import assert from "node:assert/strict"
import { describe, test } from "node:test"
import * as migrationForms from "../dist/live-form.js"
import { SESSION_ORDER_VERSION, ADVERTISE_LINK_VERSION, LEND_LINK_VERSION, QUIET_PROJECT_LINK_VERSION, QUIET_OTHERS_LINK_VERSION, EPHEMERAL_LIVE_VERSION, PASSING_THREAD_VERSION, THREAD_MARKS_VERSION, TREE_NOTICES_LINK_VERSION, APEX_LISTED_VERSION, LINK_VERSION, PROTOCOL_VERSION, SUPPORTED_VERSIONS, negotiate, decodeRuntimeFrame, encodeRuntimeFrame, WireError, serveRuntime } from "../dist/index.js"
import { ReportedSessionSchema, ListedSessionSchema, LISTED_PLAN_CHARS, newerApex, rowsForLink, sameListed } from "../dist/thread-listing.js"
import { createFakeGateway } from "../dist/fake-gateway.js"
describe("Session order and borrowing version migration", () => {
  const row = { session: "00000000-0000-4000-8000-000000000001", thread: "00000000-0000-4000-8000-000000000002", conversation: "wire-migration", harness: "codex", state: "idle", createdAt: "2026-11-09T00:00:00.000Z", activityAt: "2026-11-09T00:00:00.000Z", generation: 1, order: 0 }
  test("landed Session order keeps 22; advertisements and lending each have their own later gate", () => {
    assert.equal(SESSION_ORDER_VERSION, 22)
    assert.equal(ADVERTISE_LINK_VERSION, 23)
    assert.equal(LEND_LINK_VERSION, 24)
    assert.equal(QUIET_PROJECT_LINK_VERSION, 25)
    assert.equal(QUIET_OTHERS_LINK_VERSION, 26)
    assert.equal(EPHEMERAL_LIVE_VERSION, 27)
    assert.equal(PASSING_THREAD_VERSION, 28)
    assert.equal(THREAD_MARKS_VERSION, 29)
    assert.equal(TREE_NOTICES_LINK_VERSION, 30)
    assert.equal(APEX_LISTED_VERSION, 31)
    assert.equal(LINK_VERSION, 31)
    assert.equal(PROTOCOL_VERSION, 1)
    assert.equal(SUPPORTED_VERSIONS.min, 1)
    for (const maximum of [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]) assert.equal(negotiate(SUPPORTED_VERSIONS, { min: 1, max: maximum }), maximum)
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
  test("Thread marks survive strict parsing from 29, and are stripped before 29 without mutating the owner", () => {
    const marked = { ...row, workStatus: "in-review", workStatusAt: 1_700_000_000_000, markedUnread: true }
    assert.deepEqual(ReportedSessionSchema.parse(marked), marked)
    for (const version of [22, 28, 29]) {
      const [sent] = rowsForLink([marked], version)
      for (const field of ["workStatus", "workStatusAt", "markedUnread"]) assert.equal(Object.hasOwn(sent, field), version >= 29, `${field} at ${version}`)
      assert.equal(Object.hasOwn(sent, "order"), true)
      assert.deepEqual(decodeRuntimeFrame(encodeRuntimeFrame({ type: "sessions", report: { listed: [sent], gone: [] } })).report.listed, [sent])
    }
    assert.equal(marked.workStatus, "in-review")
    for (const workStatus of ["blocked", "", 3]) assert.equal(ReportedSessionSchema.safeParse({ ...row, workStatus }).success, false)
    assert.equal(ReportedSessionSchema.safeParse({ ...row, markedUnread: false }).success, false)
    const listed = { ...row, runsOn: { kind: "device", deviceId: "00000000-0000-4000-8000-000000000003" }, listedAt: row.createdAt }
    assert.equal(sameListed(listed, { ...listed, workStatus: "done" }), false)
    assert.equal(sameListed(listed, { ...listed, markedUnread: true }), false)
  })
  test("a deliberate Apex survives strict parsing from 31, is stripped before 31 without mutating the owner, and the newer of two is kept", () => {
    const apex = { name: "Release", purpose: "Ships 6.2", seenAt: 1_700_000_000_000, plan: "## Now\n- [ ] Cut the branch\n## Waiting on you\n- [ ] Approve the notes\n", at: 1_700_000_100_000 }
    const listedApex = { ...row, workStatus: "in-progress", apex }
    assert.deepEqual(ReportedSessionSchema.parse(listedApex), listedApex)
    for (const version of [29, 30, 31]) {
      const [sent] = rowsForLink([listedApex], version)
      assert.equal(Object.hasOwn(sent, "apex"), version >= 31, `apex at ${version}`)
      assert.equal(sent.workStatus, "in-progress", `what 29 knows stays at ${version}`)
      assert.deepEqual(decodeRuntimeFrame(encodeRuntimeFrame({ type: "sessions", report: { listed: [sent], gone: [] } })).report.listed, [sent])
    }
    assert.deepEqual(listedApex.apex, apex)
    assert.equal(ReportedSessionSchema.safeParse({ ...row, apex: { ...apex, plan: "x".repeat(LISTED_PLAN_CHARS + 1) } }).success, false, "a row carries at most LISTED_PLAN_CHARS of a plan")
    assert.equal(ReportedSessionSchema.safeParse({ ...row, apex: { ...apex, rules: "the Apex's own rules" } }).success, false, "its rules stay with its owner")
    assert.equal(ReportedSessionSchema.safeParse({ ...row, apex: { ...apex, at: undefined } }).success, false, "it says when it changed")
    const listed = { ...row, runsOn: { kind: "device", deviceId: "00000000-0000-4000-8000-000000000003" }, listedAt: row.createdAt, apex }
    assert.equal(sameListed(listed, { ...listed, apex: { ...apex } }), true)
    assert.equal(sameListed(listed, { ...listed, apex: { ...apex, plan: `${apex.plan}- [ ] One more\n`, at: apex.at + 1 } }), false, "a plan that moved is news")
    assert.equal(sameListed(listed, { ...listed, apex: undefined }), false, "and so is a Thread that's no longer an Apex")
    const newer = ListedSessionSchema.parse({ ...listed, apex: { ...apex, at: "later" } })
    assert.equal(newer.apex, undefined, "an Apex said in a way this build can't read is passed over")
    assert.equal(newer.session, row.session, "and the row is read all the same")
    const later = { ...apex, plan: "## Now\n- [x] Cut the branch\n", at: apex.at + 5 }
    assert.equal(newerApex(later, apex), later, "one that arrives late never replaces what came after it")
    assert.equal(newerApex(apex, later), later)
    assert.equal(newerApex(apex, undefined), undefined, "a report saying none takes it off")
    assert.equal(newerApex(undefined, apex), apex)
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
  test("this build's runtime keeps working with a link-28 gateway: it enrolls at 28 and its rows carry no Thread marks", async () => {
    // A gateway that speaks up to 28 (production's, until it takes 29) and reads rows as 28 knew them, strictly.
    const Row28 = ReportedSessionSchema.omit({ workStatus: true, workStatusAt: true, markedUnread: true }).strict()
    const marked = { ...row, workStatus: "done", workStatusAt: 1_700_000_000_000, markedUnread: true }
    for (const gatewayMax of [28, 29]) {
      const gateway = createFakeGateway({ versions: { min: 1, max: gatewayMax } })
      try {
        const runtime = await serveRuntime(await gateway.connectRuntime(), { runtimeId: `marks-${gatewayMax}`, build: "wire-migration", versions: SUPPORTED_VERSIONS, handle: async () => assert.fail("no operation expected") })
        try {
          assert.equal(runtime.version, gatewayMax, "this build settles on what the gateway speaks")
          assert.equal(runtime.sessions({ listed: rowsForLink([marked], runtime.version), gone: [] }), true)
          await new Promise((resolve) => setImmediate(resolve))
          const [sent] = gateway.reports(`marks-${gatewayMax}`).at(-1).listed
          if (gatewayMax === 28) {
            assert.equal(Row28.safeParse(sent).success, true, "a link-28 gateway takes the row")
            assert.equal(Object.hasOwn(sent, "workStatus") || Object.hasOwn(sent, "markedUnread"), false, "the marks stay on the Mac")
          } else assert.deepEqual([sent.workStatus, sent.markedUnread], ["done", true], "a link-29 gateway hears them")
        } finally { runtime.close(); await runtime.done }
      } finally { await gateway.close() }
    }
    // A row from a link-28 owner (no marks) is a whole row to every reader.
    assert.equal(ReportedSessionSchema.safeParse(row).success, true)
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

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createFakeGateway } from "../dist/fake-gateway.js"
import { Payload } from "../dist/payload.js"
import { decodeRuntimeFrame, encodeRuntimeFrame } from "../dist/wire.js"
import { LINK_VERSION, SUPPORTED_VERSIONS, TREE_NOTICES_LINK_VERSION, negotiate } from "../dist/version.js"
import { serveRuntime } from "../dist/runtime-client.js"
import {
  TREE_NOTICES_CAPABILITY, TREE_NOTICES_HELD, TREE_NOTICES_PATH, TREE_NOTICE_ADMITS_PER_MINUTE, TREE_NOTICE_BYTES, TREE_NOTICE_DEAD_LETTERS, TREE_NOTICE_OP,
  TreeNoticeAckSchema, TreeNoticeAnswerSchema, TreeNoticeDeliverySchema, TreeNoticeFromSchema, TreeNoticeRefusalSchema, TreeNoticeSchema,
  admitTreeNotice, noticeIdHolds, noticeIdOf, sameTreeNotice, takesTreeNotices, treeNoticeAck, treeNoticeAckWord, treeNoticeDisposal, treeNoticeFits, treeNoticeOperation, treeNoticeRateOpen, treeNoticeRefusalText,
} from "../dist/tree-notices.js"

const apex = { thread: "11111111-1111-4111-8111-111111111111", session: "22222222-2222-4222-8222-222222222222" }
const fin = "33333333-3333-4333-8333-333333333333"
const otherFin = "44444444-4444-4444-8444-444444444444"
const mac = "55555555-5555-4555-8555-555555555555"
const machine = { op: `start:${apex.session}:fix`, thread: "t-0123456789abcdef", machine: "m-0123456789abcdef", generation: 2, child: fin }

/** A notice of `child`'s report `key`, as its host posts it. */
const noticeOf = (key, child = fin, more = {}) => {
  const report = { id: `report:${child}:${key}`, child, status: "progress", summary: `Step ${key}.`, ownerGeneration: 1, at: 1_700_000_000_000 }
  return { id: noticeIdOf(child, report.id), parent: apex, child, report, ...more }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

/** Posts a notice as its host does: its JSON text, on the sender's credential. */
const post = (gateway, sender, notice) => gateway.postNotice(sender, JSON.stringify(notice))

/** A host's runtime on a raw link: enrolled, saying it owns the Apex's Session, and (unless told not to) that it takes notices. */
async function owner(gateway, runtimeId, { generation = 1, takes = true } = {}) {
  const link = await gateway.connectRuntime()
  link.send({ type: "enroll", runtimeId, versions: SUPPORTED_VERSIONS, build: "tree-notices", threads: [] })
  assert.equal((await link.next(1_000)).type, "enrolled")
  link.send({ type: "sessions", report: { owned: [{ session: apex.session, generation }], listed: [], gone: [] } })
  if (takes) link.send({ type: "advertise", capabilities: [TREE_NOTICES_CAPABILITY], slots: { used: 0, of: 1 }, at: 1 })
  await settle()
  return {
    link,
    /** The next notice delivered: the operation, and the notice it carries. */
    async delivered() {
      const frame = await link.next(1_000)
      assert.equal(frame.type, "operation")
      assert.equal(frame.operation.op, TREE_NOTICE_OP)
      const [argument] = frame.operation.input.decode().args
      return { operation: frame.operation, notice: TreeNoticeDeliverySchema.parse(argument.value) }
    },
    answer(operation, value) {
      link.send({ type: "reply", reply: { v: 1, id: operation.id, ok: true, value: Payload.of(value) } })
    },
    /** Whether nothing more was delivered. */
    async quiet() {
      await settle()
      return link.next(20).then(() => false, () => true)
    },
  }
}

describe("tree notices: the contract", () => {
  test("a notice is notice:{child}:{reportId}, carrying that report of that child, and nothing that names where it goes or who sent it", () => {
    assert.equal(TREE_NOTICES_PATH, "/v1/tree/notices")
    assert.equal(noticeIdOf(fin, "report:x:1"), `notice:${fin}:report:x:1`)
    const notice = noticeOf("1")
    assert.equal(noticeIdHolds(notice), true)
    assert.equal(TreeNoticeSchema.safeParse(notice).success, true)
    assert.equal(TreeNoticeSchema.safeParse({ ...notice, standing: { heard: 3, working: true, owner: 1, seq: 4 } }).success, true)
    assert.equal(noticeIdHolds({ ...notice, id: noticeIdOf(otherFin, notice.report.id) }), false, "another child's ID")
    assert.equal(TreeNoticeSchema.safeParse({ ...notice, id: `notice:${fin}:report:${fin}:2` }).success, false, "another report's ID")
    assert.equal(TreeNoticeSchema.safeParse({ ...notice, report: { ...notice.report, child: otherFin } }).success, false, "another child's report")
    for (const named of [{ op: machine.op }, { from: { place: { kind: "device", device: mac }, seq: 1, at: 1 } }, { device: mac }, { machine: machine.machine }, { runsOn: { kind: "device", deviceId: mac } }])
      assert.equal(TreeNoticeSchema.safeParse({ ...notice, ...named }).success, false, `a notice says no ${Object.keys(named)[0]}`)
    assert.equal(TreeNoticeSchema.safeParse({ ...notice, parent: { ...apex, device: mac } }).success, false, "its Apex is a Thread and a Session, never a device")
    assert.deepEqual(TreeNoticeSchema.parse({ ...notice, report: { ...notice.report, later: { field: [1] } } }).report.later, { field: [1] }, "what the account doesn't read crosses as it came")
  })

  test("the account's stamp names a cloud machine under its generation or a device, the notice's number and when", () => {
    const cloud = { op: machine.op, place: { kind: "cloud", thread: machine.thread, machine: machine.machine, generation: 2 }, seq: 1, at: 5 }
    assert.equal(TreeNoticeFromSchema.safeParse(cloud).success, true)
    assert.equal(TreeNoticeFromSchema.safeParse({ place: { kind: "device", device: mac }, seq: 2, at: 5 }).success, true, "a device's credential names no start")
    assert.equal(TreeNoticeFromSchema.safeParse({ ...cloud, seq: 0 }).success, false)
    assert.equal(TreeNoticeFromSchema.safeParse({ ...cloud, place: { ...cloud.place, device: mac } }).success, false)
    assert.equal(TreeNoticeDeliverySchema.safeParse({ ...noticeOf("1"), from: cloud }).success, true)
    assert.equal(TreeNoticeDeliverySchema.safeParse(noticeOf("1")).success, false, "a delivery always says who sent it")
    assert.equal(TreeNoticeDeliverySchema.safeParse({ ...noticeOf("1"), id: "notice:other", from: cloud }).success, false)
  })

  test("a post answers its number or one of a fixed list of refusals, each with its words", () => {
    assert.deepEqual(TreeNoticeAnswerSchema.parse({ admitted: true, seq: 4 }), { admitted: true, seq: 4 })
    assert.equal(TreeNoticeAnswerSchema.safeParse({ admitted: true }).success, false)
    assert.deepEqual(TreeNoticeRefusalSchema.options, ["conflict", "gone", "full", "rate", "invalid", "too-large", "forbidden"])
    for (const reason of TreeNoticeRefusalSchema.options) {
      assert.equal(TreeNoticeAnswerSchema.safeParse({ admitted: false, reason }).success, true)
      assert.match(treeNoticeRefusalText(reason), /\.$/)
    }
    assert.equal(TreeNoticeAnswerSchema.safeParse({ admitted: false, reason: "busy" }).success, false)
    assert.match(treeNoticeRefusalText("full"), /500/)
    assert.match(treeNoticeRefusalText("rate"), /20/)
    assert.match(treeNoticeRefusalText("too-large"), /64 KiB/)
  })

  test("the limits: 500 held for a Session, 64 KiB a notice, 20 admitted a minute for a Fin, 32 put aside", () => {
    assert.deepEqual([TREE_NOTICES_HELD, TREE_NOTICE_BYTES, TREE_NOTICE_ADMITS_PER_MINUTE, TREE_NOTICE_DEAD_LETTERS], [500, 65_536, 20, 32])
    assert.equal(treeNoticeFits("x".repeat(TREE_NOTICE_BYTES)), true)
    assert.equal(treeNoticeFits("x".repeat(TREE_NOTICE_BYTES + 1)), false)
    assert.equal(treeNoticeFits("é".repeat(TREE_NOTICE_BYTES / 2 + 1)), false, "bytes, not characters")
    const minute = Array.from({ length: 19 }, (_, index) => 1_000 + index)
    assert.equal(treeNoticeRateOpen(minute, 2_000), true)
    assert.equal(treeNoticeRateOpen([...minute, 1_500], 2_000), false, "the twenty-first within a minute")
    assert.equal(treeNoticeRateOpen([...minute, 1_500], 61_000), true, "the first of them is a minute old")
  })

  test("the same notice again answers the number it first got, the same ID saying anything else is a conflict, and numbers only rise", () => {
    const first = TreeNoticeSchema.parse(noticeOf("1"))
    const second = TreeNoticeSchema.parse(noticeOf("2"))
    assert.deepEqual(admitTreeNotice([], 0, first), { admitted: true, seq: 1 })
    const held = [{ seq: 1, notice: first }]
    assert.deepEqual(admitTreeNotice(held, 1, second), { admitted: true, seq: 2 })
    assert.deepEqual(admitTreeNotice(held, 1, TreeNoticeSchema.parse(Object.fromEntries(Object.entries(noticeOf("1")).reverse()))), { admitted: true, seq: 1 }, "whatever order its fields come in")
    assert.deepEqual(admitTreeNotice(held, 1, TreeNoticeSchema.parse(noticeOf("1", fin, { standing: { heard: 1, working: false, owner: 1, seq: 2 } }))), { admitted: false, reason: "conflict" })
    assert.equal(sameTreeNotice(first, { ...first, report: { ...first.report, summary: "Another." } }), false)
    assert.deepEqual(admitTreeNotice([{ seq: 7, notice: second }], 7, first), { admitted: true, seq: 8 }, "after the last number given, not the count held")
    const full = Array.from({ length: TREE_NOTICES_HELD }, (_, index) => ({ seq: index + 1, notice: TreeNoticeSchema.parse(noticeOf(`n${index}`)) }))
    assert.deepEqual(admitTreeNotice(full, TREE_NOTICES_HELD, first), { admitted: false, reason: "full" })
    assert.deepEqual(admitTreeNotice(full, TREE_NOTICES_HELD, full[3].notice), { admitted: true, seq: 4 }, "one it holds is still the same notice when it's full")
  })

  test("the owner answers in mako:agents-notice's own words, and each says what becomes of the notice", () => {
    const refused = (word) => ({ refused: word, why: "Why." })
    assert.equal(treeNoticeAckWord(TreeNoticeAckSchema.parse({ heard: true })), "heard")
    assert.equal(treeNoticeAckWord(TreeNoticeAckSchema.parse({ heard: true, deduped: true })), "deduped")
    for (const word of ["stale-owner", "unknown-child", "conflict"]) assert.equal(treeNoticeAckWord(TreeNoticeAckSchema.parse(refused(word))), word)
    assert.equal(TreeNoticeAckSchema.safeParse(refused("unavailable")).success, false, "any other refusal is no answer")
    assert.deepEqual([{ heard: true }, { heard: true, deduped: true }, refused("stale-owner"), refused("unknown-child"), refused("conflict"), undefined].map(treeNoticeDisposal), ["delete", "delete", "delete", "keep", "dead-letter", "keep"])
    const reply = (value) => ({ v: 1, id: crypto.randomUUID(), ok: true, ...(value !== undefined && { value }) })
    assert.deepEqual(treeNoticeAck(reply(Payload.of({ heard: true }))), { heard: true })
    assert.equal(treeNoticeAck(reply(Payload.of(refused("unavailable")))), undefined)
    assert.equal(treeNoticeAck(reply(Payload.encoded("not json"))), undefined)
    assert.equal(treeNoticeAck(reply()), undefined)
  })

  test("a delivery is the host call mako:agents-notice with the stamped notice its one argument, and a host says it takes them by name and version", () => {
    const delivery = TreeNoticeDeliverySchema.parse({ ...noticeOf("1"), from: { place: { kind: "device", device: mac }, seq: 1, at: 5 } })
    const operation = treeNoticeOperation(delivery, { id: crypto.randomUUID(), target: { kind: "runtime", runtimeId: "rt-apex" }, actor: { kind: "runtime", runtimeId: "gateway:tree" }, correlationId: "c-1" })
    const crossed = decodeRuntimeFrame(encodeRuntimeFrame({ type: "reply", reply: { v: 1, id: operation.id, ok: true, value: operation.input } })).reply.value.decode()
    assert.deepEqual([operation.op, operation.attempt, operation.repeatable], ["host.agents-notice", 1, true])
    assert.deepEqual(crossed, { args: [{ kind: "value", value: delivery }] })
    assert.deepEqual(TREE_NOTICES_CAPABILITY, { capability: "tree-notices", version: "1" })
    assert.equal(takesTreeNotices([{ capability: "macos", version: "26" }, TREE_NOTICES_CAPABILITY]), true)
    assert.equal(takesTreeNotices([{ capability: "tree-notices", version: "2" }]), false)
    assert.equal(takesTreeNotices([{ capability: "tree-notices" }]), false)
    assert.equal(decodeRuntimeFrame(encodeRuntimeFrame({ type: "advertise", capabilities: [TREE_NOTICES_CAPABILITY], slots: { used: 0, of: 1 }, at: 1 })).capabilities[0].capability, "tree-notices")
  })

  test("link version 30 says the gateway takes notices: this build settles on 29 with a gateway before it, and a build before it on 29 with this one", async () => {
    assert.deepEqual([TREE_NOTICES_LINK_VERSION, LINK_VERSION], [30, 30])
    assert.equal(negotiate(SUPPORTED_VERSIONS, { min: 1, max: 29 }), 29)
    for (const [gatewayMax, runtimeMax] of [[29, LINK_VERSION], [LINK_VERSION, 29], [LINK_VERSION, LINK_VERSION]]) {
      const gateway = createFakeGateway({ versions: { min: 1, max: gatewayMax } })
      try {
        const runtime = await serveRuntime(await gateway.connectRuntime(), { runtimeId: `notices-${gatewayMax}-${runtimeMax}`, build: "tree-notices", versions: { min: 1, max: runtimeMax }, handle: async () => assert.fail("no operation expected") })
        try {
          assert.equal(runtime.version, Math.min(gatewayMax, runtimeMax))
          assert.equal(runtime.version >= TREE_NOTICES_LINK_VERSION, gatewayMax === 30 && runtimeMax === 30, "only both at 30 agree a Fin's host may post")
        } finally { runtime.close(); await runtime.done }
      } finally { await gateway.close() }
    }
  })
})

describe("tree notices: the fake gateway's mailbox", () => {
  test("a notice is admitted once: posted again it answers the same number, and the same ID saying anything else is a conflict", async () => {
    const gateway = createFakeGateway()
    try {
      const sender = { kind: "device", device: mac }
      assert.deepEqual(await post(gateway, sender, noticeOf("1")), { admitted: true, seq: 1 })
      assert.deepEqual(await post(gateway, sender, noticeOf("2")), { admitted: true, seq: 2 })
      assert.deepEqual(await post(gateway, sender, noticeOf("1")), { admitted: true, seq: 1 }, "the first number it got")
      assert.deepEqual(await post(gateway, sender, noticeOf("1", fin, { standing: { heard: 2, working: true, owner: 1, seq: 9 } })), { admitted: false, reason: "conflict" })
      assert.deepEqual(gateway.heldNotices(apex.session).map((held) => [held.id, held.from.seq]), [[noticeOf("1").id, 1], [noticeOf("2").id, 2]], "held once each, in order")
      assert.deepEqual(gateway.heldNotices(apex.session)[0].from.place, { kind: "device", device: mac })
      assert.equal(gateway.heldNotices(apex.session)[0].from.op, undefined, "a device's credential names no start")
    } finally { await gateway.close() }
  })

  test("a notice that breaks the ID rule, says more than a notice does, or is over 64 KiB is refused and never held", async () => {
    const gateway = createFakeGateway()
    try {
      const sender = { kind: "device", device: mac }
      const notice = noticeOf("1")
      assert.deepEqual(await post(gateway, sender, { ...notice, id: `notice:${otherFin}:${notice.report.id}` }), { admitted: false, reason: "invalid" })
      assert.deepEqual(await post(gateway, sender, { ...notice, report: { ...notice.report, child: otherFin } }), { admitted: false, reason: "invalid" })
      assert.deepEqual(await post(gateway, sender, { ...notice, op: machine.op }), { admitted: false, reason: "invalid" })
      assert.deepEqual(await gateway.postNotice(sender, "not json"), { admitted: false, reason: "invalid" })
      const big = { ...notice, report: { ...notice.report, summary: "x".repeat(TREE_NOTICE_BYTES) } }
      assert.deepEqual(await post(gateway, sender, big), { admitted: false, reason: "too-large" })
      assert.deepEqual(await post(gateway, { kind: "device", device: "not-a-device" }, notice), { admitted: false, reason: "forbidden" })
      assert.deepEqual(gateway.heldNotices(apex.session), [])
    } finally { await gateway.close() }
  })

  test("a Session holds at most 500, and a Fin has at most 20 admitted a minute; a notice posted again counts as neither", async () => {
    let at = 1_700_000_000_000
    const gateway = createFakeGateway({ now: () => new Date(at) })
    try {
      const sender = { kind: "device", device: mac }
      for (let index = 0; index < TREE_NOTICE_ADMITS_PER_MINUTE; index += 1) assert.equal((await post(gateway, sender, noticeOf(`a${index}`))).admitted, true)
      assert.deepEqual(await post(gateway, sender, noticeOf("over")), { admitted: false, reason: "rate" })
      assert.deepEqual(await post(gateway, sender, noticeOf("a3")), { admitted: true, seq: 4 }, "one it holds is the same notice, not another")
      assert.deepEqual(await post(gateway, sender, noticeOf("b0", otherFin)), { admitted: true, seq: 21 }, "another Fin's own count")
      assert.equal(gateway.heldNotices(apex.session).length, 21, "the one refused isn't held")
      at += 60_001
      assert.deepEqual(await post(gateway, sender, noticeOf("over")), { admitted: true, seq: 22 }, "a minute on, it goes")
      // Fill the Session from many Fins, each under its own rate.
      let held = 22
      for (let each = 0; held < TREE_NOTICES_HELD; each += 1) {
        const child = `66666666-6666-4666-8666-${String(each).padStart(12, "0")}`
        for (let index = 0; index < TREE_NOTICE_ADMITS_PER_MINUTE && held < TREE_NOTICES_HELD; index += 1, held += 1) assert.deepEqual(await post(gateway, sender, noticeOf(`c${index}`, child)), { admitted: true, seq: held + 1 })
      }
      const late = "77777777-7777-4777-8777-777777777777"
      assert.deepEqual(await post(gateway, sender, noticeOf("late", late)), { admitted: false, reason: "full" })
      assert.deepEqual(await post(gateway, sender, noticeOf("a0")), { admitted: true, seq: 1 }, "full, and one it holds still answers its number")
      assert.equal(gateway.heldNotices(apex.session).length, TREE_NOTICES_HELD)
      // Its owner takes one: there is room for one more, numbered after the last.
      const apexHost = await owner(gateway, "rt-apex")
      const first = await apexHost.delivered()
      assert.equal(first.notice.from.seq, 1)
      apexHost.link.close()
      await settle()
      assert.equal(gateway.heldNotices(apex.session).length, TREE_NOTICES_HELD, "unanswered: still held")
      const back = await owner(gateway, "rt-apex")
      const again = await back.delivered()
      assert.equal(again.notice.from.seq, 1)
      back.link.close()
      await settle()
    } finally { await gateway.close() }
  })

  test("a Session's owner hears its notices one at a time, in the order they were admitted, and each it hears is deleted", async () => {
    const gateway = createFakeGateway()
    try {
      const apexHost = await owner(gateway, "rt-apex")
      const sender = { kind: "device", device: mac }
      for (const key of ["1", "2", "3"]) await post(gateway, sender, noticeOf(key))
      const first = await apexHost.delivered()
      assert.deepEqual([first.notice.id, first.notice.from.seq, first.operation.target], [noticeOf("1").id, 1, { kind: "runtime", runtimeId: "rt-apex" }])
      assert.deepEqual(first.notice.report, noticeOf("1").report, "the report as it was posted")
      assert.equal(await apexHost.quiet(), true, "the second waits for the first's answer")
      apexHost.answer(first.operation, { heard: true })
      const second = await apexHost.delivered()
      assert.equal(second.notice.from.seq, 2)
      assert.notEqual(second.operation.id, first.operation.id)
      apexHost.answer(second.operation, { heard: true, deduped: true })
      const third = await apexHost.delivered()
      assert.equal(third.notice.from.seq, 3)
      apexHost.answer(third.operation, { refused: "stale-owner", why: "A newer owner of the Fin reported since." })
      assert.equal(await apexHost.quiet(), true)
      assert.deepEqual(gateway.heldNotices(apex.session), [], "heard, had already, from a stale owner: each is done with")
      assert.deepEqual(gateway.deadNotices(apex.session), [])
    } finally { await gateway.close() }
  })

  test("while the owner is off, or on a link that never said it takes notices, they're held; they go, in order, when it's on and says so", async () => {
    const gateway = createFakeGateway()
    try {
      const sender = { kind: "device", device: mac }
      await post(gateway, sender, noticeOf("1"))
      const older = await owner(gateway, "rt-apex", { takes: false })
      await post(gateway, sender, noticeOf("2"))
      assert.equal(await older.quiet(), true, "a host that didn't advertise it is sent none")
      older.link.close()
      await settle()
      await post(gateway, sender, noticeOf("3"))
      assert.deepEqual(gateway.heldNotices(apex.session).map((held) => held.from.seq), [1, 2, 3])
      const back = await owner(gateway, "rt-apex")
      for (const seq of [1, 2, 3]) {
        const next = await back.delivered()
        assert.equal(next.notice.from.seq, seq)
        back.answer(next.operation, { heard: true })
      }
      assert.equal(await back.quiet(), true)
      assert.deepEqual(gateway.heldNotices(apex.session), [])
    } finally { await gateway.close() }
  })

  test("an owner that goes before answering leaves the notice held, and it's delivered again when it's back", async () => {
    const gateway = createFakeGateway()
    try {
      const apexHost = await owner(gateway, "rt-apex")
      await post(gateway, { kind: "device", device: mac }, noticeOf("1"))
      const first = await apexHost.delivered()
      apexHost.link.close()
      await settle()
      assert.equal(gateway.heldNotices(apex.session).length, 1)
      const back = await owner(gateway, "rt-apex")
      const again = await back.delivered()
      assert.equal(again.notice.id, first.notice.id)
      assert.notEqual(again.operation.id, first.operation.id, "another try is another operation")
      back.answer(again.operation, { heard: true, deduped: true })
      await settle()
      assert.deepEqual(gateway.heldNotices(apex.session), [])
    } finally { await gateway.close() }
  })

  test("a Session that changes owner while a notice is held: its new owner takes it, whatever the one before answers late", async () => {
    const gateway = createFakeGateway()
    try {
      const before = await owner(gateway, "rt-mac")
      await post(gateway, { kind: "device", device: mac }, noticeOf("1"))
      await post(gateway, { kind: "device", device: mac }, noticeOf("2"))
      const stale = await before.delivered()
      // The Session moves: another runtime reports it under a higher generation.
      const after = await owner(gateway, "rt-cloud", { generation: 2 })
      const first = await after.delivered()
      assert.deepEqual([first.notice.id, first.notice.from.seq, first.operation.target.runtimeId], [stale.notice.id, 1, "rt-cloud"])
      before.answer(stale.operation, { refused: "conflict", why: "Late, from the owner before." })
      await settle()
      assert.deepEqual(gateway.deadNotices(apex.session), [], "the owner before no longer decides")
      assert.equal(gateway.heldNotices(apex.session).length, 2)
      after.answer(first.operation, { heard: true })
      const second = await after.delivered()
      assert.equal(second.notice.from.seq, 2)
      after.answer(second.operation, { heard: true })
      await settle()
      assert.deepEqual(gateway.heldNotices(apex.session), [])
      assert.equal(await before.quiet(), true, "nothing more to the owner before")
      // The owner before, reporting again under its old generation, doesn't take the Session back.
      before.link.send({ type: "sessions", report: { owned: [{ session: apex.session, generation: 1 }], listed: [], gone: [] } })
      await post(gateway, { kind: "device", device: mac }, noticeOf("3"))
      assert.equal((await after.delivered()).notice.from.seq, 3)
    } finally { await gateway.close() }
  })

  test("a Fin the owner doesn't know yet: its notices are kept, another Fin's go past them, and they're delivered in order at the next admit", async () => {
    const gateway = createFakeGateway()
    try {
      const apexHost = await owner(gateway, "rt-apex")
      const sender = { kind: "device", device: mac }
      const unknown = { refused: "unknown-child", why: "Its start's answer may not have reached this device yet." }
      await post(gateway, sender, noticeOf("1"))
      const first = await apexHost.delivered()
      await post(gateway, sender, noticeOf("2"))
      await post(gateway, sender, noticeOf("1", otherFin))
      apexHost.answer(first.operation, unknown)
      const other = await apexHost.delivered()
      assert.deepEqual([other.notice.child, other.notice.from.seq], [otherFin, 3], "the Fin's second isn't sent ahead of its first")
      apexHost.answer(other.operation, { heard: true })
      // Admits came while that pass ran, so what was kept goes once more, in order.
      const again = await apexHost.delivered()
      assert.equal(again.notice.from.seq, 1)
      apexHost.answer(again.operation, unknown)
      assert.equal(await apexHost.quiet(), true, "kept, and on no clock")
      assert.deepEqual(gateway.heldNotices(apex.session).map((held) => held.from.seq), [1, 2])
      // The owner knows the Fin now; the next notice admitted sends what was kept first.
      await post(gateway, sender, noticeOf("3"))
      for (const seq of [1, 2, 4]) {
        const next = await apexHost.delivered()
        assert.equal(next.notice.from.seq, seq)
        apexHost.answer(next.operation, { heard: true })
      }
      await settle()
      assert.deepEqual(gateway.heldNotices(apex.session), [])
    } finally { await gateway.close() }
  })

  test("an answer that is none of the five keeps the notice, and a conflict puts it aside, the newest 32 of them", async () => {
    let at = 1_700_000_000_000
    const gateway = createFakeGateway({ now: () => new Date(at) })
    try {
      const apexHost = await owner(gateway, "rt-apex")
      const sender = { kind: "device", device: mac }
      await post(gateway, sender, noticeOf("0"))
      const unread = await apexHost.delivered()
      apexHost.answer(unread.operation, { refused: "unavailable", why: "The Thread store didn't open." })
      assert.equal(await apexHost.quiet(), true)
      assert.equal(gateway.heldNotices(apex.session).length, 1, "kept: that's no answer")
      const total = TREE_NOTICE_DEAD_LETTERS + 2
      for (let index = 1; index < total; index += 1) {
        at += 4_000
        await post(gateway, sender, noticeOf(String(index)))
        for (;;) {
          const next = await apexHost.delivered()
          apexHost.answer(next.operation, { refused: "conflict", why: "Not that report of that Fin." })
          if (next.notice.from.seq === index + 1) break
        }
      }
      await settle()
      assert.deepEqual(gateway.heldNotices(apex.session), [])
      const dead = gateway.deadNotices(apex.session)
      assert.equal(dead.length, TREE_NOTICE_DEAD_LETTERS)
      assert.deepEqual([dead[0].from.seq, dead.at(-1).from.seq], [total - TREE_NOTICE_DEAD_LETTERS + 1, total], "the oldest went for the newer")
    } finally { await gateway.close() }
  })

  test("a machine's notice is stamped as the machine was made, and it reports for its own Fin alone", async () => {
    const gateway = createFakeGateway({ now: () => new Date(1_700_000_000_000) })
    try {
      const sender = { kind: "machine", machine: machine.machine }
      assert.deepEqual(await post(gateway, sender, noticeOf("1")), { admitted: false, reason: "forbidden" }, "a machine the account never made")
      gateway.finMachine(machine)
      assert.deepEqual(await post(gateway, sender, noticeOf("1", otherFin)), { admitted: false, reason: "forbidden" }, "another Fin's child")
      for (const named of [{ op: "start:other" }, { from: { op: "start:other", place: { kind: "cloud", thread: "t-ffffffffffffffff", machine: "m-ffffffffffffffff", generation: 9 }, seq: 1, at: 1 } }, { to: { kind: "device", device: mac } }, { runtimeId: "rt-other" }])
        assert.deepEqual(await post(gateway, sender, { ...noticeOf("1"), ...named }), { admitted: false, reason: "invalid" }, `it can't say ${Object.keys(named)[0]}`)
      assert.deepEqual(gateway.heldNotices(apex.session), [])
      assert.deepEqual(await post(gateway, sender, noticeOf("1")), { admitted: true, seq: 1 })
      const apexHost = await owner(gateway, "rt-apex")
      const { notice, operation } = await apexHost.delivered()
      assert.deepEqual(notice.from, { op: machine.op, place: { kind: "cloud", thread: machine.thread, machine: machine.machine, generation: 2 }, seq: 1, at: 1_700_000_000_000 })
      assert.deepEqual(operation.target, { kind: "runtime", runtimeId: "rt-apex" }, "to the owner of the Apex's Session, which no notice names")
      apexHost.answer(operation, { heard: true })
      await settle()
      // Its place is over: nothing more is admitted from it, which its host takes as taken.
      gateway.finMachineOver(machine.machine)
      assert.deepEqual(await post(gateway, sender, noticeOf("2")), { admitted: false, reason: "gone" })
    } finally { await gateway.close() }
  })

  test("an archived Apex's Session holds nothing, and a notice for it is gone", async () => {
    const gateway = createFakeGateway()
    try {
      const sender = { kind: "device", device: mac }
      await post(gateway, sender, noticeOf("1"))
      gateway.archiveTree(apex.session)
      assert.deepEqual(gateway.heldNotices(apex.session), [])
      assert.deepEqual(await post(gateway, sender, noticeOf("1")), { admitted: false, reason: "gone" })
      assert.deepEqual(await post(gateway, sender, noticeOf("2")), { admitted: false, reason: "gone" })
      const apexHost = await owner(gateway, "rt-apex")
      assert.equal(await apexHost.quiet(), true)
    } finally { await gateway.close() }
  })
})

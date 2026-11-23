import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createFakeGateway } from "../dist/fake-gateway.js"
import { Payload } from "../dist/payload.js"
import { decodeRuntimeFrame, encodeRuntimeFrame } from "../dist/wire.js"
import { LINK_VERSION, SUPPORTED_VERSIONS, TREE_NOTICES_LINK_VERSION, negotiate } from "../dist/version.js"
import { serveRuntime } from "../dist/runtime-client.js"
import {
  TREE_NOTICES_CAPABILITY, TREE_NOTICES_HELD, TREE_NOTICES_HELD_BYTES, TREE_NOTICES_PATH, TREE_NOTICE_ADMITS_PER_MINUTE, TREE_NOTICE_BYTES, TREE_NOTICE_DEAD_LETTERS, TREE_NOTICE_FIN_SHARE, TREE_NOTICE_OP, TREE_NOTICE_UNKNOWN_CHILD_MS,
  TreeNoticeAckSchema, TreeNoticeAnswerSchema, TreeNoticeDeliverySchema, TreeNoticeFromSchema, TreeNoticeRefusalSchema, TreeNoticeSchema,
  admitTreeNotice, apexSessionOfStart, machineNoticesPath, newerTreeStanding, noticeIdHolds, noticeIdOf, sameTreeNotice, takesTreeNotices, treeNoticeBytes, treeNoticeAck, treeNoticeAckWord, treeNoticeDisposal, treeNoticeFits, treeNoticeOperation, treeNoticeRateOpen, treeNoticeRefusalText,
} from "../dist/tree-notices.js"

const apex = { thread: "11111111-1111-4111-8111-111111111111", session: "22222222-2222-4222-8222-222222222222" }
const fin = "33333333-3333-4333-8333-333333333333"
const otherFin = "44444444-4444-4444-8444-444444444444"
const mac = "55555555-5555-4555-8555-555555555555"
const machine = { op: `start:${apex.session}:fix`, thread: "t-0123456789abcdef", machine: "m-0123456789abcdef", generation: 2, child: fin, apex }
const standing = (owner, seq, working = true) => ({ heard: 1, working, owner, seq })

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
    assert.equal(machineNoticesPath(machine.machine), "/v1/machines/m-0123456789abcdef/notices", "a machine posts under its own name")
    assert.equal(machineNoticesPath("m/../x"), "/v1/machines/m%2F..%2Fx/notices", "a name is one segment of the path, whatever it holds")
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
    assert.match(treeNoticeRefusalText("rate"), /posted 20 times/, "posts, not reports: one posted again counts")
    assert.match(treeNoticeRefusalText("full"), /a quarter of either from one Fin/)
    assert.match(treeNoticeRefusalText("full"), /16 MiB/)
    assert.match(treeNoticeRefusalText("too-large"), /2 MiB/)
  })

  test("the limits: 500 notices and 16 MiB held for a Session, a quarter of either from one Fin, 2 MiB a notice, 20 posts a minute for a Fin, 32 put aside, an hour unknown", () => {
    assert.deepEqual([TREE_NOTICES_HELD, TREE_NOTICES_HELD_BYTES, TREE_NOTICE_FIN_SHARE, TREE_NOTICE_BYTES, TREE_NOTICE_ADMITS_PER_MINUTE, TREE_NOTICE_DEAD_LETTERS, TREE_NOTICE_UNKNOWN_CHILD_MS], [500, 16_777_216, 4, 2_097_152, 20, 32, 3_600_000])
    assert.equal(treeNoticeFits("x".repeat(TREE_NOTICE_BYTES)), true)
    assert.equal(treeNoticeFits("x".repeat(TREE_NOTICE_BYTES + 1)), false)
    assert.equal(treeNoticeBytes("é".repeat(10)), 20, "bytes, not characters")
    const minute = Array.from({ length: 19 }, (_, index) => 1_000 + index)
    assert.equal(treeNoticeRateOpen(minute, 2_000), true)
    assert.equal(treeNoticeRateOpen([...minute, 1_500], 2_000), false, "the twenty-first within a minute")
    assert.equal(treeNoticeRateOpen([...minute, 1_500], 61_000), true, "the first of them is a minute old")
  })

  test("the fullest report a host writes fits a notice: every text at its limit, each character written in JSON's six bytes", () => {
    const most = (chars) => "\u0001".repeat(chars)
    const report = {
      id: most(600), child: fin, status: "needs-input", summary: most(16_000),
      artifacts: Array.from({ length: 64 }, () => ({ kind: "pull-request", ref: most(4_096), label: most(200) })),
      question: most(4_000), retainsQuestion: true, supersedes: Array.from({ length: 8 }, () => most(600)), answers: Array.from({ length: 8 }, () => most(200)), decides: "person",
      waitingOn: Array.from({ length: 8 }, () => ({ kind: "pull-request", ref: most(400), repository: most(200), number: Number.MAX_SAFE_INTEGER, until: "checks" })),
      options: Array.from({ length: 12 }, () => ({ label: most(200), detail: most(600) })), recommended: Number.MAX_SAFE_INTEGER, action: most(400),
      followUp: { ref: most(600), version: most(200) }, for: "person", told: true, implicit: true, unfinished: true,
      handoff: { to: most(200), child: fin, text: most(16_000) }, awaits: true, ownerGeneration: Number.MAX_SAFE_INTEGER, at: -Number.MAX_VALUE,
    }
    const notice = { id: noticeIdOf(fin, report.id), parent: apex, child: fin, report, standing: { heard: -Number.MAX_VALUE, working: false, owner: -Number.MAX_VALUE, seq: -Number.MAX_VALUE } }
    assert.equal(TreeNoticeSchema.safeParse(notice).success, true)
    assert.equal(treeNoticeBytes(JSON.stringify(notice)), 2_010_818)
    assert.equal(treeNoticeFits(JSON.stringify(notice)), true)
  })

  test("a notice is its ID and its report: how its Fin stands is replaceable, the newest by its host's generation and then its count", () => {
    const first = TreeNoticeSchema.parse(noticeOf("1", fin, { standing: standing(2, 5) }))
    assert.equal(sameTreeNotice(first, TreeNoticeSchema.parse(noticeOf("1", fin, { standing: standing(9, 9, false) }))), true, "another standing, the same notice")
    assert.equal(sameTreeNotice(first, TreeNoticeSchema.parse(noticeOf("1"))), true, "or none")
    assert.equal(sameTreeNotice(first, TreeNoticeSchema.parse(Object.fromEntries(Object.entries(noticeOf("1")).reverse()))), true, "whatever order its fields come in")
    assert.equal(sameTreeNotice(first, { ...first, report: { ...first.report, summary: "Another." } }), false)
    assert.equal(sameTreeNotice(first, { ...first, parent: { ...apex, thread: otherFin } }), false)
    assert.equal(newerTreeStanding(undefined, { owner: 1, seq: 1 }), true)
    assert.equal(newerTreeStanding({ owner: 2, seq: 5 }, { owner: 2, seq: 6 }), true)
    assert.equal(newerTreeStanding({ owner: 2, seq: 5 }, { owner: 3, seq: 1 }), true, "a newer host's first word")
    assert.equal(newerTreeStanding({ owner: 2, seq: 5 }, { owner: 2, seq: 5 }), false, "the same word again")
    assert.equal(newerTreeStanding({ owner: 2, seq: 5 }, { owner: 2, seq: 4 }), false)
    assert.equal(newerTreeStanding({ owner: 2, seq: 5 }, { owner: 1, seq: 99 }), false, "an older host's, however many it said")
  })

  test("admitting: a held notice again answers its number and takes a newer standing, another report under its ID is a conflict, the Fin's last notice is remembered once taken, and a Session is full by count or by bytes", () => {
    const first = TreeNoticeSchema.parse(noticeOf("1", fin, { standing: standing(2, 5) }))
    const second = TreeNoticeSchema.parse(noticeOf("2"))
    const again = (more) => TreeNoticeSchema.parse(noticeOf("1", fin, more))
    /** A mailbox holding only the sender's own notices: the Session's totals are theirs. */
    const alone = (own, head, last) => ({ own, count: own.length, bytes: own.reduce((sum, each) => sum + each.bytes, 0), head, ...(last && { last }) })
    assert.deepEqual(admitTreeNotice(alone([], 0), first, 10), { admitted: true, seq: 1, does: "hold" })
    const held = [{ seq: 1, bytes: 10, notice: first }]
    assert.deepEqual(admitTreeNotice(alone(held, 1), second, 10), { admitted: true, seq: 2, does: "hold" })
    assert.deepEqual(admitTreeNotice(alone(held, 1), again({ standing: standing(2, 5) }), 10), { admitted: true, seq: 1, does: "nothing" })
    assert.deepEqual(admitTreeNotice(alone(held, 1), again({ standing: standing(2, 6, false) }), 10), { admitted: true, seq: 1, does: "restand" })
    assert.deepEqual(admitTreeNotice(alone(held, 1), again({ standing: standing(2, 4) }), 10), { admitted: true, seq: 1, does: "nothing" }, "an older standing changes nothing")
    assert.deepEqual(admitTreeNotice(alone(held, 1), again({}), 10), { admitted: true, seq: 1, does: "nothing" }, "nor does none")
    assert.deepEqual(admitTreeNotice(alone(held, 1), { ...first, report: { ...first.report, summary: "Another." } }, 10), { admitted: false, reason: "conflict" })
    // Taken by its owner, so no longer held: the Fin's last notice is still the same notice.
    const last = { id: first.id, seq: 1, said: { owner: 2, seq: 5 } }
    assert.deepEqual(admitTreeNotice(alone([], 1, last), first, 10), { admitted: true, seq: 1, does: "nothing" }, "not a new notice")
    assert.deepEqual(admitTreeNotice(alone([], 1, last), again({ standing: standing(3, 1) }), 10), { admitted: true, seq: 1, does: "forward" }, "its newer standing goes on, once")
    assert.deepEqual(admitTreeNotice(alone([], 1, { ...last, said: { owner: 3, seq: 1 } }), again({ standing: standing(3, 1) }), 10), { admitted: true, seq: 1, does: "nothing" })
    assert.deepEqual(admitTreeNotice(alone([], 1, last), second, 10), { admitted: true, seq: 2, does: "hold" }, "the Fin's next report is new")
    assert.deepEqual(admitTreeNotice(alone([{ seq: 7, bytes: 10, notice: second }], 7), first, 10), { admitted: true, seq: 8, does: "hold" }, "after the last number given, not the count held")
    // The Session's totals are every Fin's: full by them though the sender holds little, or nothing, itself.
    assert.deepEqual(admitTreeNotice({ own: [], count: TREE_NOTICES_HELD, bytes: 5_000, head: TREE_NOTICES_HELD }, first, 10), { admitted: false, reason: "full" })
    assert.deepEqual(admitTreeNotice({ own: [], count: TREE_NOTICES_HELD - 1, bytes: 5_000, head: 900 }, first, 10), { admitted: true, seq: 901, does: "hold" }, "room for one")
    assert.deepEqual(admitTreeNotice({ own: held, count: TREE_NOTICES_HELD, bytes: 5_000, head: TREE_NOTICES_HELD }, again({}), 10), { admitted: true, seq: 1, does: "nothing" }, "one it holds is still the same notice when it's full")
    assert.deepEqual(admitTreeNotice({ own: [], count: 1, bytes: TREE_NOTICES_HELD_BYTES - 100, head: 1 }, first, 100), { admitted: true, seq: 2, does: "hold" }, "to the byte")
    assert.deepEqual(admitTreeNotice({ own: [], count: 1, bytes: TREE_NOTICES_HELD_BYTES - 100, head: 1 }, first, 101), { admitted: false, reason: "full" }, "one byte over what a Session holds")
  })

  test("admitting: a notice is the sender's own by its start, so another Fin's under the same ID is neither a repeat nor a conflict", () => {
    const first = TreeNoticeSchema.parse(noticeOf("1"))
    const other = { ...first, report: { ...first.report, summary: "Another Fin's, under the same ID." } }
    // Another start holds a notice under this ID (the Session counts it); the sender holds none, and remembers none.
    assert.deepEqual(admitTreeNotice({ own: [], count: 1, bytes: 10, head: 1 }, other, 10), { admitted: true, seq: 2, does: "hold" }, "new to this sender, whatever another holds")
    assert.deepEqual(admitTreeNotice({ own: [], count: 1, bytes: 10, head: 1 }, first, 10), { admitted: true, seq: 2, does: "hold" }, "and never a repeat of another's")
    assert.deepEqual(admitTreeNotice({ own: [{ seq: 2, bytes: 10, notice: other }], count: 2, bytes: 20, head: 2 }, first, 10), { admitted: false, reason: "conflict" }, "a conflict only with its own")
  })

  test("admitting: one Fin holds at most a quarter of what its Apex's Session holds, by count and by bytes, and is full alone", () => {
    const share = TREE_NOTICES_HELD / TREE_NOTICE_FIN_SHARE
    const mine = (count, bytes = 10) => Array.from({ length: count }, (_, index) => ({ seq: index + 1, bytes, notice: TreeNoticeSchema.parse(noticeOf(`n${index}`)) }))
    const next = TreeNoticeSchema.parse(noticeOf("next"))
    assert.equal(share, 125)
    assert.deepEqual(admitTreeNotice({ own: mine(share - 1), count: share - 1, bytes: 1_240, head: 124 }, next, 10), { admitted: true, seq: 125, does: "hold" }, "its 125th")
    assert.deepEqual(admitTreeNotice({ own: mine(share), count: share, bytes: 1_250, head: 125 }, next, 10), { admitted: false, reason: "full" }, "its 126th, in a Session with room for 375 more")
    assert.deepEqual(admitTreeNotice({ own: [], count: share, bytes: 1_250, head: 125 }, next, 10), { admitted: true, seq: 126, does: "hold" }, "another Fin is admitted to the same Session")
    assert.deepEqual(admitTreeNotice({ own: mine(share), count: share, bytes: 1_250, head: 125 }, mine(share)[7].notice, 10), { admitted: true, seq: 8, does: "nothing" }, "one it holds still answers its number")
    const quarter = TREE_NOTICES_HELD_BYTES / TREE_NOTICE_FIN_SHARE
    assert.deepEqual(admitTreeNotice({ own: mine(1, quarter - 100), count: 1, bytes: quarter - 100, head: 1 }, next, 100), { admitted: true, seq: 2, does: "hold" }, "to the byte")
    assert.deepEqual(admitTreeNotice({ own: mine(1, quarter - 100), count: 1, bytes: quarter - 100, head: 1 }, next, 101), { admitted: false, reason: "full" }, "one byte over its share")
    assert.deepEqual(admitTreeNotice({ own: [], count: 1, bytes: quarter - 100, head: 1 }, next, 101), { admitted: true, seq: 2, does: "hold" }, "which is no other Fin's limit")
  })

  test("a start's op names its Apex's Session, and nothing else does", () => {
    assert.equal(apexSessionOfStart(`start:${apex.session}:fix`), apex.session)
    assert.equal(apexSessionOfStart(`start:${apex.session}:release:2026-11-23 notes\nline`), apex.session, "a client's key is any text")
    assert.equal(apexSessionOfStart(`start:${apex.session}:`), apex.session)
    for (const other of [`start:${apex.session}`, "start:a:b", "start::fix", `start:${apex.session.toUpperCase().replace("2", "G")}:fix`, `send:${apex.session}:fix`, `answer:${apex.session}:fix`, `move:${apex.session}:fix`, `report-action:${apex.thread}:fix`, `respond:${apex.session}`, "migrated:agent-1", ` start:${apex.session}:fix`, `restart:${apex.session}:fix`, ""])
      assert.equal(apexSessionOfStart(other), undefined, other)
  })

  test("the owner answers in mako:agents-notice's own words, and each says what becomes of the notice", () => {
    const refused = (word) => ({ refused: word, why: "Why." })
    assert.equal(treeNoticeAckWord(TreeNoticeAckSchema.parse({ heard: true })), "heard")
    assert.equal(treeNoticeAckWord(TreeNoticeAckSchema.parse({ heard: true, deduped: true })), "deduped")
    for (const word of ["stale-owner", "unknown-child", "conflict"]) assert.equal(treeNoticeAckWord(TreeNoticeAckSchema.parse(refused(word))), word)
    assert.equal(TreeNoticeAckSchema.safeParse(refused("unavailable")).success, false, "any other refusal is no answer")
    assert.deepEqual([{ heard: true }, { heard: true, deduped: true }, refused("stale-owner"), refused("unknown-child"), refused("conflict"), undefined].map((ack) => treeNoticeDisposal(ack, 0)), ["delete", "delete", "delete", "keep", "dead-letter", "keep"])
    assert.equal(treeNoticeDisposal(refused("unknown-child"), TREE_NOTICE_UNKNOWN_CHILD_MS - 1), "keep")
    assert.equal(treeNoticeDisposal(refused("unknown-child"), TREE_NOTICE_UNKNOWN_CHILD_MS), "dead-letter", "an hour unknown: put aside")
    assert.equal(treeNoticeDisposal(undefined, TREE_NOTICE_UNKNOWN_CHILD_MS * 24), "keep", "an owner that's off is waited for")
    assert.equal(treeNoticeDisposal({ heard: true }, TREE_NOTICE_UNKNOWN_CHILD_MS * 24), "delete")
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
  test("a notice is admitted once: posted again it answers the same number, and the same ID carrying another report is a conflict", async () => {
    const gateway = createFakeGateway()
    try {
      const sender = { kind: "device", device: mac }
      assert.deepEqual(await post(gateway, sender, noticeOf("1")), { admitted: true, seq: 1 })
      assert.deepEqual(await post(gateway, sender, noticeOf("2")), { admitted: true, seq: 2 })
      assert.deepEqual(await post(gateway, sender, noticeOf("1")), { admitted: true, seq: 1 }, "the first number it got")
      assert.deepEqual(await post(gateway, sender, { ...noticeOf("1"), report: { ...noticeOf("1").report, summary: "Another." } }), { admitted: false, reason: "conflict" })
      assert.deepEqual(await post(gateway, sender, { ...noticeOf("1"), parent: { ...apex, thread: otherFin } }), { admitted: false, reason: "conflict" }, "or naming another Apex's Thread")
      assert.deepEqual(gateway.heldNotices(apex.session).map((held) => [held.id, held.from.seq]), [[noticeOf("1").id, 1], [noticeOf("2").id, 2]], "held once each, in order")
      assert.deepEqual(gateway.heldNotices(apex.session)[0].from.place, { kind: "device", device: mac })
      assert.equal(gateway.heldNotices(apex.session)[0].from.op, undefined, "a device's credential names no start")
    } finally { await gateway.close() }
  })

  test("a notice that breaks the ID rule, says more than a notice does, or is over 2 MiB is refused and never held", async () => {
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

  test("a Fin posts at most 20 times a minute, every post counted: a new notice, one posted again, one said again as it stands, and one refused", async () => {
    let at = 1_700_000_000_000
    const gateway = createFakeGateway({ now: () => new Date(at) })
    try {
      const sender = { kind: "device", device: mac }
      for (let index = 0; index < TREE_NOTICE_ADMITS_PER_MINUTE; index += 1) assert.equal((await post(gateway, sender, noticeOf(`a${index}`))).admitted, true)
      assert.deepEqual(await post(gateway, sender, noticeOf("over")), { admitted: false, reason: "rate" })
      assert.deepEqual(await post(gateway, sender, noticeOf("a3")), { admitted: false, reason: "rate" }, "one it holds, posted again, is a post too")
      assert.deepEqual(await post(gateway, sender, noticeOf("b0", otherFin)), { admitted: true, seq: 21 }, "another Fin's own count")
      assert.equal(gateway.heldNotices(apex.session).length, 21, "the one refused isn't held")
      at += 60_001
      assert.deepEqual(await post(gateway, sender, noticeOf("over")), { admitted: true, seq: 22 }, "a minute on, it goes")
      // Nineteen more posts that add nothing (a repeat, a newer standing on one held) use the minute up as new ones do.
      for (let index = 0; index < 9; index += 1) assert.deepEqual(await post(gateway, sender, noticeOf("a3")), { admitted: true, seq: 4 })
      for (let index = 0; index < 10; index += 1) assert.deepEqual(await post(gateway, sender, noticeOf("a3", fin, { standing: standing(1, index + 1) })), { admitted: true, seq: 4 })
      assert.deepEqual(await post(gateway, sender, noticeOf("more")), { admitted: false, reason: "rate" })
      assert.equal(gateway.heldNotices(apex.session).length, 22)
      // Taken by its owner, its last notice said again as it stands (forwarded, never held) is a post like any.
      at += 60_001
      const apexHost = await owner(gateway, "rt-apex")
      for (let taken = 0; taken < 22; taken += 1) apexHost.answer((await apexHost.delivered()).operation, { heard: true })
      await settle()
      for (let index = 0; index < TREE_NOTICE_ADMITS_PER_MINUTE; index += 1) {
        assert.deepEqual(await post(gateway, sender, noticeOf("over", fin, { standing: standing(2, index + 1) })), { admitted: true, seq: 22 })
        apexHost.answer((await apexHost.delivered()).operation, { heard: true, deduped: true })
      }
      assert.deepEqual(await post(gateway, sender, noticeOf("over", fin, { standing: standing(2, 99) })), { admitted: false, reason: "rate" })
      assert.equal(await apexHost.quiet(), true, "and one refused goes nowhere")
    } finally { await gateway.close() }
  })

  test("a Session holds at most 500 notices from all its Fins, and 125 from one: a Fin at its share is full alone, and one held still answers its number", async () => {
    let at = 1_700_000_000_000
    const gateway = createFakeGateway({ now: () => new Date(at) })
    try {
      const sender = { kind: "device", device: mac }
      const childOf = (each) => `66666666-6666-4666-8666-${String(each).padStart(12, "0")}`
      const share = TREE_NOTICES_HELD / TREE_NOTICE_FIN_SHARE
      let held = 0
      // Four Fins, each to its share, a minute's posts at a time.
      for (let each = 0; each < TREE_NOTICE_FIN_SHARE; each += 1) {
        for (let index = 0; index < share; index += 1, held += 1) {
          if (index % TREE_NOTICE_ADMITS_PER_MINUTE === 0) at += 60_001
          assert.deepEqual(await post(gateway, sender, noticeOf(`c${index}`, childOf(each))), { admitted: true, seq: held + 1 })
        }
        if (each > 0) continue
        at += 60_001
        assert.deepEqual(await post(gateway, sender, noticeOf("one-more", childOf(0))), { admitted: false, reason: "full" }, "its 126th, with the Session a quarter full")
        assert.deepEqual(await post(gateway, sender, noticeOf("c7", childOf(0))), { admitted: true, seq: 8 }, "one it holds still answers its number")
      }
      assert.equal(held, TREE_NOTICES_HELD)
      assert.deepEqual(await post(gateway, sender, noticeOf("late", "77777777-7777-4777-8777-777777777777")), { admitted: false, reason: "full" }, "a Fin that holds nothing, in a Session that holds its most")
      at += 60_001
      assert.deepEqual(await post(gateway, sender, noticeOf("c0", childOf(3))), { admitted: true, seq: 3 * share + 1 }, "full, and one it holds still answers its number")
      assert.equal(gateway.heldNotices(apex.session).length, TREE_NOTICES_HELD)
      // Its owner is sent the first; unanswered, it stays held, and goes again when the owner is back.
      const apexHost = await owner(gateway, "rt-apex")
      const first = await apexHost.delivered()
      assert.equal(first.notice.from.seq, 1)
      apexHost.link.close()
      await settle()
      assert.equal(gateway.heldNotices(apex.session).length, TREE_NOTICES_HELD, "unanswered: still held")
      const back = await owner(gateway, "rt-apex")
      const again = await back.delivered()
      assert.equal(again.notice.from.seq, 1)
      // Taken, there is room for one more of that Fin's, numbered after the last.
      back.answer(again.operation, { heard: true })
      const second = await back.delivered()
      assert.deepEqual(await post(gateway, sender, noticeOf("one-more", childOf(0))), { admitted: true, seq: TREE_NOTICES_HELD + 1 })
      assert.equal(second.notice.from.seq, 2)
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
      assert.deepEqual(Object.keys(dead[0]).sort(), ["child", "from", "id", "why"], "a record of each, and nothing of its report")
      assert.deepEqual([dead[0].id, dead[0].child, dead[0].why], [noticeOf(String(total - TREE_NOTICE_DEAD_LETTERS)).id, fin, "conflict"])
      assert.equal(JSON.stringify(dead).includes("Step "), false, "no report's words are kept")
      assert.deepEqual([dead[0].from.seq, dead.at(-1).from.seq], [total - TREE_NOTICE_DEAD_LETTERS + 1, total], "the oldest went for the newer")
    } finally { await gateway.close() }
  })

  test("a held notice said again with a newer standing keeps its number and its place, and reaches the owner with the newest", async () => {
    const gateway = createFakeGateway()
    try {
      const sender = { kind: "device", device: mac }
      assert.deepEqual(await post(gateway, sender, noticeOf("1", fin, { standing: standing(1, 1) })), { admitted: true, seq: 1 })
      assert.deepEqual(await post(gateway, sender, noticeOf("2")), { admitted: true, seq: 2 })
      assert.deepEqual(await post(gateway, sender, noticeOf("1", fin, { standing: standing(1, 3, false) })), { admitted: true, seq: 1 }, "never a conflict")
      assert.deepEqual(await post(gateway, sender, noticeOf("1", fin, { standing: standing(1, 2) })), { admitted: true, seq: 1 })
      assert.deepEqual(gateway.heldNotices(apex.session).map((held) => [held.from.seq, held.standing?.seq]), [[1, 3], [2, undefined]], "the newest standing, and an older one after it changes nothing")
      const apexHost = await owner(gateway, "rt-apex")
      const first = await apexHost.delivered()
      assert.deepEqual([first.notice.from.seq, first.notice.standing], [1, standing(1, 3, false)])
      // It stands otherwise again while that delivery is on its way: the owner's answer to the older word doesn't end it.
      assert.deepEqual(await post(gateway, sender, noticeOf("1", fin, { standing: standing(1, 4) })), { admitted: true, seq: 1 })
      apexHost.answer(first.operation, { heard: true })
      const again = await apexHost.delivered()
      assert.deepEqual([again.notice.from.seq, again.notice.standing.seq], [1, 4])
      apexHost.answer(again.operation, { heard: true, deduped: true })
      const second = await apexHost.delivered()
      assert.equal(second.notice.from.seq, 2)
      apexHost.answer(second.operation, { heard: true })
      await settle()
      assert.deepEqual(gateway.heldNotices(apex.session), [])
    } finally { await gateway.close() }
  })

  test("a Fin's last notice, taken by its owner, is the same notice when it's posted again: its number, nothing held, and only a newer standing sent on, once", async () => {
    const gateway = createFakeGateway()
    try {
      const sender = { kind: "device", device: mac }
      const apexHost = await owner(gateway, "rt-apex")
      await post(gateway, sender, noticeOf("1"))
      const one = await apexHost.delivered()
      apexHost.answer(one.operation, { heard: true })
      assert.deepEqual(await post(gateway, sender, noticeOf("2", fin, { standing: standing(1, 1) })), { admitted: true, seq: 2 })
      const two = await apexHost.delivered()
      apexHost.answer(two.operation, { heard: true })
      await settle()
      assert.deepEqual(gateway.heldNotices(apex.session), [])
      assert.deepEqual(await post(gateway, sender, noticeOf("2", fin, { standing: standing(1, 1) })), { admitted: true, seq: 2 }, "the number it had")
      assert.deepEqual(gateway.heldNotices(apex.session), [], "not held again")
      assert.equal(await apexHost.quiet(), true, "nor delivered again")
      assert.deepEqual(await post(gateway, sender, noticeOf("2", fin, { standing: standing(1, 2, false) })), { admitted: true, seq: 2 })
      const restated = await apexHost.delivered()
      assert.deepEqual([restated.notice.id, restated.notice.from.seq, restated.notice.standing], [noticeOf("2").id, 2, standing(1, 2, false)])
      assert.deepEqual(gateway.heldNotices(apex.session), [], "sent on, and kept nowhere")
      apexHost.answer(restated.operation, { heard: true, deduped: true })
      assert.deepEqual(await post(gateway, sender, noticeOf("2", fin, { standing: standing(1, 2, false) })), { admitted: true, seq: 2 })
      assert.equal(await apexHost.quiet(), true, "once")
      // With its owner off, a newer standing isn't kept for it: the owner asks how its Fins stand when it's back.
      apexHost.link.close()
      await settle()
      assert.deepEqual(await post(gateway, sender, noticeOf("2", fin, { standing: standing(1, 3) })), { admitted: true, seq: 2 })
      assert.deepEqual(gateway.heldNotices(apex.session), [])
      // Only the last is remembered: an earlier one posted again can't be told from new, and its owner dedupes it.
      assert.deepEqual(await post(gateway, sender, noticeOf("3")), { admitted: true, seq: 3 })
    } finally { await gateway.close() }
  })

  test("a Session holds at most 16 MiB of notices and one Fin 4 MiB of them: one that would take either over is full, and a notice over 2 MiB is too large", async () => {
    const gateway = createFakeGateway()
    try {
      const sender = { kind: "device", device: mac }
      const childOf = (each) => `66666666-6666-4666-8666-${String(each).padStart(12, "0")}`
      const sized = (key, bytes, child = fin) => {
        const notice = noticeOf(key, child)
        notice.report.summary = ""
        notice.report.summary = "x".repeat(bytes - treeNoticeBytes(JSON.stringify(notice)))
        return notice
      }
      assert.deepEqual(await post(gateway, sender, sized("over", TREE_NOTICE_BYTES + 1)), { admitted: false, reason: "too-large" })
      // One Fin: two of the largest are its share, to the byte.
      assert.deepEqual(await post(gateway, sender, sized("big0", TREE_NOTICE_BYTES)), { admitted: true, seq: 1 })
      assert.deepEqual(await post(gateway, sender, sized("big1", TREE_NOTICE_BYTES)), { admitted: true, seq: 2 })
      assert.deepEqual(await post(gateway, sender, sized("more", 600)), { admitted: false, reason: "full" }, "a quarter of the Session's bytes are its own")
      assert.deepEqual(await post(gateway, sender, sized("big0", TREE_NOTICE_BYTES)), { admitted: true, seq: 1 }, "one it holds still answers its number")
      // Three more Fins fill the Session, the last a byte short.
      for (let each = 0; each < 3; each += 1) {
        assert.deepEqual(await post(gateway, sender, sized("big0", TREE_NOTICE_BYTES, childOf(each))), { admitted: true, seq: 3 + each * 2 })
        assert.deepEqual(await post(gateway, sender, sized("big1", TREE_NOTICE_BYTES - (each === 2 ? 1 : 0), childOf(each))), { admitted: true, seq: 4 + each * 2 })
      }
      assert.deepEqual(await post(gateway, sender, sized("more", 600, childOf(9))), { admitted: false, reason: "full" }, "one byte was left, and this Fin holds nothing")
      assert.equal(gateway.heldNotices(apex.session).length, 8)
      const apexHost = await owner(gateway, "rt-apex")
      const first = await apexHost.delivered()
      apexHost.link.close()
      await settle()
      assert.equal(first.notice.report.summary.length > 2_000_000, true, "the whole of it reaches its owner")
    } finally { await gateway.close() }
  })

  test("a notice its owner doesn't know the Fin of is kept for an hour from its admission, then put aside at the next pass", async () => {
    let at = 1_700_000_000_000
    const gateway = createFakeGateway({ now: () => new Date(at) })
    try {
      const sender = { kind: "device", device: mac }
      const unknown = { refused: "unknown-child", why: "Its start's answer may not have reached this device yet." }
      const apexHost = await owner(gateway, "rt-apex")
      await post(gateway, sender, noticeOf("1"))
      apexHost.answer((await apexHost.delivered()).operation, unknown)
      await settle()
      at += TREE_NOTICE_UNKNOWN_CHILD_MS - 1
      await post(gateway, sender, noticeOf("1", otherFin))
      apexHost.answer((await apexHost.delivered()).operation, unknown)
      apexHost.answer((await apexHost.delivered()).operation, { heard: true })
      assert.equal(await apexHost.quiet(), true, "no clock runs: nothing happens when the hour passes")
      assert.deepEqual(gateway.heldNotices(apex.session).map((held) => held.from.seq), [1], "a millisecond short of the hour: kept")
      at += 1
      await post(gateway, sender, noticeOf("2", otherFin))
      apexHost.answer((await apexHost.delivered()).operation, unknown)
      apexHost.answer((await apexHost.delivered()).operation, { heard: true })
      await settle()
      assert.deepEqual(gateway.heldNotices(apex.session), [])
      assert.deepEqual(gateway.deadNotices(apex.session).map((dead) => [dead.from.seq, dead.why, "report" in dead]), [[1, "unknown-child", false]], "an hour unknown: put aside, its body dropped")
    } finally { await gateway.close() }
  })

  test("a machine's notice is stamped as the machine was made, and it reports for its own Fin, to its own Apex, alone", async () => {
    const gateway = createFakeGateway({ now: () => new Date(1_700_000_000_000) })
    try {
      const sender = { kind: "machine", machine: machine.machine }
      assert.deepEqual(await post(gateway, sender, noticeOf("1")), { admitted: false, reason: "forbidden" }, "a machine the account never made")
      gateway.finMachine(machine)
      assert.deepEqual(await post(gateway, sender, noticeOf("1", otherFin)), { admitted: false, reason: "forbidden" }, "another Fin's child")
      const elsewhere = "88888888-8888-4888-8888-888888888888"
      assert.deepEqual(await post(gateway, sender, { ...noticeOf("1"), parent: { ...apex, session: elsewhere } }), { admitted: false, reason: "forbidden" }, "another Apex's Session")
      assert.deepEqual(await post(gateway, sender, { ...noticeOf("1"), parent: { ...apex, thread: elsewhere } }), { admitted: false, reason: "forbidden" }, "another Apex's Thread")
      assert.deepEqual(gateway.heldNotices(elsewhere), [], "nothing reaches a Session it wasn't started for")
      // A machine whose op names another Session than its Apex's, or none, reports to nobody.
      gateway.finMachine({ ...machine, machine: "m-1111111111111111", op: `start:${elsewhere}:fix` })
      assert.deepEqual(await post(gateway, { kind: "machine", machine: "m-1111111111111111" }, noticeOf("1")), { admitted: false, reason: "forbidden" })
      gateway.finMachine({ ...machine, machine: "m-2222222222222222", op: "migrated:agent-1" })
      assert.deepEqual(await post(gateway, { kind: "machine", machine: "m-2222222222222222" }, noticeOf("1")), { admitted: false, reason: "forbidden" })
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

  test("a machine names one child, its first, ever; nothing keeps another machine from naming the same one, and each one's notices are its own start's", async () => {
    const gateway = createFakeGateway({ now: () => new Date(1_700_000_000_000) })
    try {
      const { child: _named, ...unnamed } = machine
      const sibling = { ...unnamed, op: `start:${apex.session}:sibling`, thread: "t-fedcba9876543210", machine: "m-fedcba9876543210" }
      gateway.finMachine(unnamed)
      gateway.finMachine(sibling)
      const truly = { kind: "machine", machine: machine.machine }
      const impostor = { kind: "machine", machine: sibling.machine }
      assert.deepEqual(await post(gateway, truly, noticeOf("1")), { admitted: true, seq: 1 }, "the first child it names is its Fin")
      assert.deepEqual(await post(gateway, truly, noticeOf("1", otherFin)), { admitted: false, reason: "forbidden" }, "and no other, from then")
      // The sibling's machine names the same child, under the true Fin's own notice ID, with a report of its own.
      const forged = { ...noticeOf("1"), report: { ...noticeOf("1").report, summary: "Not the Fin's." } }
      assert.deepEqual(await post(gateway, impostor, forged), { admitted: true, seq: 2 }, "admitted under its own start: neither a repeat of the Fin's nor a conflict with it")
      assert.deepEqual(await post(gateway, impostor, noticeOf("2", otherFin)), { admitted: false, reason: "forbidden" }, "it too names one child ever")
      assert.deepEqual(await post(gateway, truly, noticeOf("1")), { admitted: true, seq: 1 }, "the Fin's own, again, is still its own")
      assert.deepEqual(await post(gateway, impostor, forged), { admitted: true, seq: 2 })
      const held = gateway.heldNotices(apex.session)
      assert.deepEqual(held.map((each) => [each.id, each.from.seq, each.from.op, each.from.place.machine, each.report.summary]), [
        [noticeOf("1").id, 1, machine.op, machine.machine, "Step 1."],
        [noticeOf("1").id, 2, sibling.op, sibling.machine, "Not the Fin's."],
      ], "both held, each stamped with the start and machine that posted it: which is the Fin's is its Apex's device's to tell")
      // Each start's rate and last notice are its own.
      for (let index = 0; index < TREE_NOTICE_ADMITS_PER_MINUTE - 2; index += 1) await post(gateway, impostor, forged)
      assert.deepEqual(await post(gateway, impostor, forged), { admitted: false, reason: "rate" })
      assert.deepEqual(await post(gateway, truly, noticeOf("2")), { admitted: true, seq: 3 }, "one machine's posts are no other's")
      // The owner's conflict with the impostor's puts that one aside and leaves the Fin's.
      const apexHost = await owner(gateway, "rt-apex")
      const one = await apexHost.delivered()
      assert.equal(one.notice.from.op, machine.op)
      apexHost.answer(one.operation, { heard: true })
      const two = await apexHost.delivered()
      assert.equal(two.notice.from.op, sibling.op)
      apexHost.answer(two.operation, { refused: "conflict", why: "That start made another Fin." })
      const three = await apexHost.delivered()
      assert.deepEqual([three.notice.from.op, three.notice.from.seq], [machine.op, 3])
      apexHost.answer(three.operation, { heard: true })
      await settle()
      assert.deepEqual(gateway.heldNotices(apex.session), [])
      assert.deepEqual(gateway.deadNotices(apex.session).map((dead) => [dead.from.op, dead.why]), [[sibling.op, "conflict"]])
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

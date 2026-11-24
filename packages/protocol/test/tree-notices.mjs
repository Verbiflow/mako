import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createFakeGateway } from "../dist/fake-gateway.js"
import { Payload } from "../dist/payload.js"
import { decodeRuntimeFrame, encodeRuntimeFrame } from "../dist/wire.js"
import { LINK_VERSION, SUPPORTED_VERSIONS, TREE_NOTICES_LINK_VERSION, negotiate } from "../dist/version.js"
import { serveRuntime } from "../dist/runtime-client.js"
import {
  TREE_NOTICES_CAPABILITY, TREE_NOTICES_HELD, TREE_NOTICES_HELD_BYTES, TREE_NOTICES_PATH, TREE_NOTICE_ADMITS_PER_MINUTE, TREE_NOTICE_BYTES, TREE_NOTICE_DEAD_LETTERS, TREE_NOTICE_FIN_FLOOR, TREE_NOTICE_OP, TREE_EDGE_LEASE_MS, TREE_FINS_OPEN, TREE_NOTICE_FLOOR_BYTES, TREE_NOTICES_SESSION_BYTES, TREE_NOTICE_UNKNOWN_CHILD_MS,
  TREE_EDGES_PATH, TreeEdgeAnswerSchema, TreeEdgeAskSchema, TreeEdgeRefusalSchema, TreeEdgeSchema, TreeNoticeAckSchema, TreeNoticeAnswerSchema, TreeNoticeDeliverySchema, TreeNoticeFromSchema, TreeNoticeRefusalSchema, TreeNoticeSchema,
  admitTreeNotice, apexSessionOfStart, decideTreeEdge, machineNoticesPath, newerTreeStanding, noticeIdHolds, noticeIdOf, sameTreeEdge, sameTreeNotice, takesTreeNotices, treeEdgeNoticeKey, treeEdgeOfNotice, treeEdgesStandUntil, treeNoticeEdgeKey, treeNoticeFinRoom, treeNoticeFinShare, treeNoticeSessionMost, treeEdgeRefusalText, treeNoticeBytes, treeNoticeAck, treeNoticeAckWord, treeNoticeDisposal, treeNoticeFits, treeNoticeOperation, treeNoticeRateOpen, treeNoticeRefusalText,
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

/** The record of `child`, a Fin on `mac`, as its Apex's device keeps it with the account. */
const edgeOf = (child = fin, more = {}) => ({ op: `start:${apex.session}:${child}`, apex, child, place: { kind: "device", device: mac }, ...more })

/** A gateway whose account has `mac`'s Fins on record: the two every case names, and any more one does. */
const recorded = (gateway, ...children) => {
  for (const child of [fin, otherFin, ...children]) gateway.treeEdge(edgeOf(child))
  return gateway
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
    assert.match(treeNoticeRefusalText("full"), /shared equally among the Fins holding some, and always one/)
    assert.match(treeNoticeRefusalText("full"), /16 MiB/)
    assert.match(treeNoticeRefusalText("too-large"), /2 MiB/)
  })

  test("the limits: 500 notices and 16 MiB shared among a Session's Fins, one always a Fin's, 2 MiB a notice, 20 posts a minute for a Fin, 32 put aside of a Fin, an hour unknown, 30 days a record outlives its owner", () => {
    assert.deepEqual([TREE_NOTICES_HELD, TREE_NOTICES_HELD_BYTES, TREE_NOTICE_FIN_FLOOR, TREE_NOTICE_BYTES, TREE_NOTICE_ADMITS_PER_MINUTE, TREE_NOTICE_DEAD_LETTERS, TREE_NOTICE_UNKNOWN_CHILD_MS, TREE_EDGE_LEASE_MS], [500, 16_777_216, 1, 2_097_152, 20, 32, 3_600_000, 2_592_000_000])
    assert.equal(TREE_NOTICES_HELD_BYTES, 8 * TREE_NOTICE_BYTES, "eight of the largest notice")
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

  test("admitting: a held notice again answers its number and takes a newer standing, another report under its ID is a conflict, and the Fin's last notice is remembered once taken", () => {
    const first = TreeNoticeSchema.parse(noticeOf("1", fin, { standing: standing(2, 5) }))
    const second = TreeNoticeSchema.parse(noticeOf("2"))
    const again = (more) => TreeNoticeSchema.parse(noticeOf("1", fin, more))
    /** A mailbox holding only the sender's own notices. */
    const alone = (own, head, last) => ({ own, others: 0, head, ...(last && { last }) })
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
    const full = Array.from({ length: TREE_NOTICES_HELD }, (_, index) => ({ seq: index + 1, bytes: 10, notice: index ? TreeNoticeSchema.parse(noticeOf(`n${index}`)) : first }))
    assert.deepEqual(admitTreeNotice(alone(full, TREE_NOTICES_HELD), again({}), 10), { admitted: true, seq: 1, does: "nothing" }, "one it holds is still the same notice when it holds its whole share")
  })

  test("admitting: a notice is the sender's own by its start, so another Fin's under the same ID is neither a repeat nor a conflict", () => {
    const first = TreeNoticeSchema.parse(noticeOf("1"))
    const other = { ...first, report: { ...first.report, summary: "Another Fin's, under the same ID." } }
    // Another start holds a notice under this ID; the sender holds none, and remembers none.
    assert.deepEqual(admitTreeNotice({ own: [], others: 1, head: 1 }, other, 10), { admitted: true, seq: 2, does: "hold" }, "new to this sender, whatever another holds")
    assert.deepEqual(admitTreeNotice({ own: [], others: 1, head: 1 }, first, 10), { admitted: true, seq: 2, does: "hold" }, "and never a repeat of another's")
    assert.deepEqual(admitTreeNotice({ own: [{ seq: 2, bytes: 10, notice: other }], others: 1, head: 2 }, first, 10), { admitted: false, reason: "conflict" }, "a conflict only with its own")
  })

  test("admitting: a Fin holds its fair share of the Session's room among the Fins holding notices there, by count and by bytes, and always one, so it's full alone", () => {
    const mine = (count, bytes = 10) => Array.from({ length: count }, (_, index) => ({ seq: index + 1, bytes, notice: TreeNoticeSchema.parse(noticeOf(`n${index}`)) }))
    const next = TreeNoticeSchema.parse(noticeOf("next"))
    // Alone, a Fin may hold the whole room.
    assert.deepEqual(treeNoticeFinShare(1), { count: 500, bytes: 16_777_216 })
    assert.deepEqual(admitTreeNotice({ own: mine(499), others: 0, head: 499 }, next, 10), { admitted: true, seq: 500, does: "hold" }, "its 500th, alone")
    assert.deepEqual(admitTreeNotice({ own: mine(500), others: 0, head: 500 }, next, 10), { admitted: false, reason: "full" }, "its 501st")
    // Four Fins holding: each an equal quarter.
    assert.deepEqual(treeNoticeFinShare(4), { count: 125, bytes: 4_194_304 })
    assert.deepEqual(admitTreeNotice({ own: mine(124), others: 3, head: 900 }, next, 10), { admitted: true, seq: 901, does: "hold" }, "its 125th beside three others")
    assert.deepEqual(admitTreeNotice({ own: mine(125), others: 3, head: 900 }, next, 10), { admitted: false, reason: "full" }, "its 126th")
    assert.deepEqual(admitTreeNotice({ own: mine(125), others: 3, head: 900 }, mine(125)[7].notice, 10), { admitted: true, seq: 8, does: "nothing" }, "one it holds still answers its number")
    const quarter = TREE_NOTICES_HELD_BYTES / 4
    assert.deepEqual(admitTreeNotice({ own: mine(2, quarter / 2 - 50), others: 3, head: 2 }, next, 100), { admitted: true, seq: 3, does: "hold" }, "to the byte of its share")
    assert.deepEqual(admitTreeNotice({ own: mine(2, quarter / 2 - 50), others: 3, head: 2 }, next, 101), { admitted: false, reason: "full" }, "one byte over it")
    // A Fin holding nothing always has room, however many hold and whatever they hold: its one, of up to 256 KiB.
    for (const others of [3, 39, 499, TREE_FINS_OPEN - 1]) {
      assert.deepEqual(admitTreeNotice({ own: [], others, head: 9_000 }, next, TREE_NOTICE_FLOOR_BYTES), { admitted: true, seq: 9_001, does: "hold" }, `the first beside ${others} others`)
      assert.deepEqual(admitTreeNotice({ own: mine(1), others, head: 9_000 }, next, 10).admitted, others + 1 <= TREE_NOTICES_HELD / 2, `a second beside ${others} others only within a share`)
      assert.equal(admitTreeNotice({ own: [], others, head: 9_000 }, next, TREE_NOTICE_BYTES).admitted, others + 1 <= 8, `the largest notice, beside ${others} others, only within a share`)
    }
    assert.deepEqual(admitTreeNotice({ own: [], others: TREE_FINS_OPEN, head: 9_000 }, next, 10), { admitted: false, reason: "full" }, "never one more holder than a tree has Fins open")
    assert.deepEqual(admitTreeNotice({ own: mine(1), others: TREE_FINS_OPEN, head: 9_000 }, mine(1)[0].notice, 10), { admitted: true, seq: 1, does: "nothing" }, "a holder's own still answers")
    assert.deepEqual(treeNoticeFinShare(41), { count: 12, bytes: 409_200 }, "forty flooding Fins and one more: twelve each")
    assert.deepEqual(treeNoticeFinShare(TREE_FINS_OPEN), { count: 1, bytes: 19_239 }, "never less than one, by count")
  })

  test("bounded: a tree has at most 872 Fins open, so a Session holds at most 3,562 notices and 291,401,614 bytes (278 MiB), the first 64 shares and 808 floors", () => {
    assert.equal(TREE_FINS_OPEN, 872)
    assert.equal(TREE_NOTICE_FLOOR_BYTES, 262_144)
    assert.deepEqual(treeNoticeSessionMost(TREE_FINS_OPEN), { count: 3_562, bytes: 291_401_614 })
    assert.equal(TREE_NOTICES_SESSION_BYTES, 291_401_614)
    assert.ok(TREE_NOTICES_SESSION_BYTES < 10e9 / 30, "under a thirtieth of a Durable Object's 10 GB")
    // The k-th Fin to take more holds its floor or its share among k, and never more of either.
    for (let rank = 1; rank <= TREE_FINS_OPEN; rank += 1) {
      const share = treeNoticeFinShare(rank)
      assert.equal(treeNoticeFinRoom({ count: 1, bytes: TREE_NOTICE_FLOOR_BYTES }, rank - 1), true)
      assert.equal(treeNoticeFinRoom(share, rank - 1), true)
      assert.equal(treeNoticeFinRoom({ count: share.count + 1, bytes: 1 }, rank - 1), false)
      assert.equal(treeNoticeFinRoom({ count: 2, bytes: Math.max(TREE_NOTICE_FLOOR_BYTES, share.bytes) + 1 }, rank - 1), false)
    }
  })

  test("the fair share never needs the pool: Fins each within the share of h holders hold no more than the room, and a Fin's refusal reads nothing of what its siblings hold", () => {
    for (const holders of [1, 2, 3, 4, 7, 40, 41, 499, 500, 501]) {
      const share = treeNoticeFinShare(holders)
      if (share.count > TREE_NOTICE_FIN_FLOOR) assert.ok(holders * share.count <= TREE_NOTICES_HELD, `${holders} holders at their share by count`)
      assert.ok(holders * share.bytes <= TREE_NOTICES_HELD_BYTES, `${holders} holders at their share by bytes`)
    }
    // What decides is the Fin's own holding and how many hold: nothing else is an argument.
    assert.equal(treeNoticeFinRoom({ count: 1, bytes: TREE_NOTICE_FLOOR_BYTES }, TREE_FINS_OPEN), true, "one of 256 KiB is always room")
    assert.equal(treeNoticeFinRoom({ count: 1, bytes: TREE_NOTICE_FLOOR_BYTES + 1 }, 64), false, "a larger one goes within the share")
    assert.equal(treeNoticeFinRoom({ count: 1, bytes: TREE_NOTICE_FLOOR_BYTES * 4 }, 15), true)
    assert.equal(treeNoticeFinRoom({ count: 2, bytes: 20 }, 0), true)
    assert.equal(treeNoticeFinRoom({ count: 126, bytes: 20 }, 3), false)
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
    const gateway = recorded(createFakeGateway())
    try {
      const sender = { kind: "device", device: mac }
      assert.deepEqual(await post(gateway, sender, noticeOf("1")), { admitted: true, seq: 1 })
      assert.deepEqual(await post(gateway, sender, noticeOf("2")), { admitted: true, seq: 2 })
      assert.deepEqual(await post(gateway, sender, noticeOf("1")), { admitted: true, seq: 1 }, "the first number it got")
      assert.deepEqual(await post(gateway, sender, { ...noticeOf("1"), report: { ...noticeOf("1").report, summary: "Another." } }), { admitted: false, reason: "conflict" })
      assert.deepEqual(await post(gateway, sender, { ...noticeOf("1"), parent: { ...apex, thread: otherFin } }), { admitted: false, reason: "forbidden" }, "and naming another Apex's Thread it's no record's notice")
      assert.deepEqual(gateway.heldNotices(apex.session).map((held) => [held.id, held.from.seq]), [[noticeOf("1").id, 1], [noticeOf("2").id, 2]], "held once each, in order")
      assert.deepEqual(gateway.heldNotices(apex.session)[0].from.place, { kind: "device", device: mac })
      assert.equal(gateway.heldNotices(apex.session)[0].from.op, edgeOf().op, "stamped with its record's start, which a device's credential doesn't name")
    } finally { await gateway.close() }
  })

  test("a notice that breaks the ID rule, says more than a notice does, or is over 2 MiB is refused and never held", async () => {
    const gateway = recorded(createFakeGateway())
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
    const gateway = recorded(createFakeGateway({ now: () => new Date(at) }))
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

  test("one Fin flooding alone may hold the Session's whole room, yet four or forty flooding Fins never keep a sibling's notice out: each holds its share and a Fin holding none is always admitted", async () => {
    let at = 1_700_000_000_000
    const gateway = recorded(createFakeGateway({ now: () => new Date(at) }))
    try {
      const sender = { kind: "device", device: mac }
      const childOf = (each) => `66666666-6666-4666-8666-${String(each).padStart(12, "0")}`
      const sibling = "77777777-7777-4777-8777-777777777777"
      recorded(gateway, ...Array.from({ length: 42 }, (_, each) => childOf(each)), sibling)
      let seq = 0
      /** Posts a Fin's notices until the account says it's full: how many it took. */
      const flood = async (child) => {
        for (let index = 0; ; index += 1) {
          if (index % TREE_NOTICE_ADMITS_PER_MINUTE === 0) at += 60_001
          const answer = await post(gateway, sender, noticeOf(`c${index}`, child))
          if (!answer.admitted) {
            assert.equal(answer.reason, "full")
            return index
          }
          assert.equal(answer.seq, (seq += 1))
        }
      }
      assert.equal(await flood(childOf(0)), TREE_NOTICES_HELD, "alone, its share is the whole room")
      at += 60_001
      assert.deepEqual(await post(gateway, sender, noticeOf("c7", childOf(0))), { admitted: true, seq: 8 }, "one it holds still answers its number")
      // Three more flood: each takes the share of the Fins holding then, never what another needs.
      for (const each of [1, 2, 3]) assert.equal(await flood(childOf(each)), Math.floor(TREE_NOTICES_HELD / (each + 1)), `the ${each + 1}th flooder's share`)
      at += 60_001
      assert.deepEqual(await post(gateway, sender, noticeOf("first", sibling)), { admitted: true, seq: seq + 1 }, "four flooding Fins: a sibling holding none is admitted")
      seq += 1
      // Thirty-seven more, forty in all, and the sibling still has room for its next once it holds nothing.
      for (let each = 4; each < 41; each += 1) assert.ok((await flood(childOf(each))) >= 1, `the ${each + 1}th flooder is admitted its first`)
      at += 60_001
      // Forty-two hold now, the sibling among them: its share is eleven, whatever the first flooders still hold beyond theirs.
      for (let index = 2; index <= 11; index += 1) assert.deepEqual(await post(gateway, sender, noticeOf(`more${index}`, sibling)), { admitted: true, seq: (seq += 1) }, `the sibling's ${index}th`)
      assert.deepEqual(await post(gateway, sender, noticeOf("past", sibling)), { admitted: false, reason: "full" }, "its twelfth is past its share, and full for it alone")
      assert.ok(gateway.heldNotices(apex.session).length > TREE_NOTICES_HELD, "the shares the first flooders took while they were fewer stay theirs")
    } finally { await gateway.close() }
  })

  test("a Session's owner hears its notices one at a time, in the order they were admitted, and each it hears is deleted", async () => {
    const gateway = recorded(createFakeGateway())
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
    const gateway = recorded(createFakeGateway())
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
    const gateway = recorded(createFakeGateway())
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
    const gateway = recorded(createFakeGateway())
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
    const gateway = recorded(createFakeGateway())
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
    const gateway = recorded(createFakeGateway({ now: () => new Date(at) }))
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
    const gateway = recorded(createFakeGateway())
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
    const gateway = recorded(createFakeGateway())
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

  test("by bytes too: 16 MiB is one Fin's alone and half each of two, a Fin holding none takes the largest notice there is beside them, and a notice over 2 MiB is too large", async () => {
    const gateway = recorded(createFakeGateway())
    try {
      const sender = { kind: "device", device: mac }
      const childOf = (each) => `66666666-6666-4666-8666-${String(each).padStart(12, "0")}`
      recorded(gateway, ...[0, 1, 2, 3, 9].map(childOf), "77777777-7777-4777-8777-777777777777")
      const sized = (key, bytes, child = fin) => {
        const notice = noticeOf(key, child)
        notice.report.summary = ""
        notice.report.summary = "x".repeat(bytes - treeNoticeBytes(JSON.stringify(notice)))
        return notice
      }
      assert.deepEqual(await post(gateway, sender, sized("over", TREE_NOTICE_BYTES + 1)), { admitted: false, reason: "too-large" })
      // One Fin alone: eight of the largest are the whole room, to the byte.
      for (let index = 0; index < 8; index += 1) assert.deepEqual(await post(gateway, sender, sized(`big${index}`, TREE_NOTICE_BYTES)), { admitted: true, seq: index + 1 })
      assert.deepEqual(await post(gateway, sender, sized("more", 600)), { admitted: false, reason: "full" }, "alone, its share is all 16 MiB")
      assert.deepEqual(await post(gateway, sender, sized("big0", TREE_NOTICE_BYTES)), { admitted: true, seq: 1 }, "one it holds still answers its number")
      // Another Fin holds nothing: its largest goes in beside a Fin holding all 16 MiB, and half of the room is its share.
      for (let index = 0; index < 4; index += 1) assert.deepEqual(await post(gateway, sender, sized(`big${index}`, TREE_NOTICE_BYTES, childOf(0))), { admitted: true, seq: 9 + index })
      assert.deepEqual(await post(gateway, sender, sized("more", 600, childOf(0))), { admitted: false, reason: "full" }, "8 MiB is its half")
      assert.deepEqual(await post(gateway, sender, sized("big0", TREE_NOTICE_BYTES, childOf(1))), { admitted: true, seq: 13 }, "and a third's largest goes in too")
      assert.equal(gateway.heldNotices(apex.session).length, 13)
      const apexHost = await owner(gateway, "rt-apex")
      const first = await apexHost.delivered()
      apexHost.link.close()
      await settle()
      assert.equal(first.notice.report.summary.length > 2_000_000, true, "the whole of it reaches its owner")
    } finally { await gateway.close() }
  })

  test("a notice its owner doesn't know the Fin of is kept for an hour from its admission, then put aside at the next pass", async () => {
    let at = 1_700_000_000_000
    const gateway = recorded(createFakeGateway({ now: () => new Date(at) }))
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
    const gateway = recorded(createFakeGateway())
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

describe("tree notices: the records of Fins off their Apexes' hosts", () => {
  const apexMac = "88888888-8888-4888-8888-888888888888"
  const edge = edgeOf()
  const ask = (gateway, device, body) => gateway.askTreeEdge(device, JSON.stringify(body))
  const keep = (record = edge) => ({ ask: "keep", edge: record })
  const end = (op = edge.op) => ({ ask: "end", op })

  test("a record is a start of its own Apex's Session, the Apex, the child and where it runs, and nothing else", () => {
    assert.equal(TREE_EDGES_PATH, "/v1/tree/edges")
    assert.deepEqual(TreeEdgeSchema.parse(edge), edge)
    assert.equal(TreeEdgeSchema.safeParse({ ...edge, place: { kind: "cloud", thread: machine.thread } }).success, true, "a cloud Thread is a place too")
    assert.equal(TreeEdgeSchema.safeParse({ ...edge, op: "start:99999999-9999-4999-8999-999999999999:fix" }).success, false, "a start of another Session")
    assert.equal(TreeEdgeSchema.safeParse({ ...edge, op: "migrated:1" }).success, false, "an op that names no Session")
    assert.equal(TreeEdgeSchema.safeParse({ ...edge, place: { kind: "device", device: "studio" } }).success, false, "a device by its ID, never its name")
    assert.equal(TreeEdgeSchema.safeParse({ ...edge, place: { kind: "cloud", thread: machine.thread, machine: machine.machine } }).success, false, "a cloud Thread, not the machine it has now")
    for (const more of [{ name: "parser" }, { brief: "Fix it." }, { state: "working" }, { apex: { ...apex, device: apexMac } }])
      assert.equal(TreeEdgeSchema.safeParse({ ...edge, ...more }).success, false, `it isn't the roster: ${Object.keys(more)[0]}`)
    for (const left of ["op", "apex", "child", "place"]) assert.equal(TreeEdgeSchema.safeParse({ ...edge, [left]: undefined }).success, false, `${left} is required`)
  })

  test("an ask keeps a record or ends one by its start, and answers done or one of three refusals, each with its words", () => {
    assert.deepEqual(TreeEdgeAskSchema.parse(keep()), keep())
    assert.deepEqual(TreeEdgeAskSchema.parse(end()), end())
    assert.equal(TreeEdgeAskSchema.safeParse({ ask: "keep", edge, op: edge.op }).success, false)
    assert.equal(TreeEdgeAskSchema.safeParse({ ask: "end", edge }).success, false, "an end names the start alone")
    assert.equal(TreeEdgeAskSchema.safeParse({ ask: "list" }).success, false)
    assert.deepEqual(TreeEdgeRefusalSchema.options, ["conflict", "forbidden", "invalid"])
    assert.equal(TreeEdgeAnswerSchema.safeParse({ ok: true }).success, true)
    assert.equal(TreeEdgeAnswerSchema.safeParse({ ok: false, reason: "conflict" }).success, true)
    assert.equal(TreeEdgeAnswerSchema.safeParse({ ok: false, reason: "gone" }).success, false)
    assert.equal(TreeEdgeAnswerSchema.safeParse({ ok: false }).success, false)
    const words = TreeEdgeRefusalSchema.options.map(treeEdgeRefusalText)
    assert.equal(new Set(words).size, 3)
    for (const text of words) assert.match(text, /\.$/)
  })

  test("deciding: only the device that owns the Apex's Session keeps or ends a record, a repeat changes nothing, and another record under the start is a conflict", () => {
    const owns = (session) => session === apex.session
    const nobody = () => false
    const kept = { edge, ending: false }
    assert.deepEqual(decideTreeEdge(keep(), undefined, owns), { ok: true, does: "keep" })
    assert.deepEqual(decideTreeEdge(keep(), kept, owns), { ok: true, does: "nothing" }, "the same record again")
    assert.deepEqual(decideTreeEdge(keep({ place: edge.place, child: edge.child, apex: { session: apex.session, thread: apex.thread }, op: edge.op }), kept, owns), { ok: true, does: "nothing" }, "whatever order its fields come in")
    assert.equal(sameTreeEdge(edge, { ...edge, child: otherFin }), false)
    for (const [what, other] of [["another child", { child: otherFin }], ["another place", { place: { kind: "device", device: apexMac } }], ["a cloud Thread", { place: { kind: "cloud", thread: machine.thread } }], ["another Thread of the Apex's", { apex: { ...apex, thread: otherFin } }]])
      assert.deepEqual(decideTreeEdge(keep({ ...edge, ...other }), kept, owns), { ok: false, reason: "conflict" }, what)
    assert.deepEqual(decideTreeEdge(keep(), undefined, nobody), { ok: false, reason: "forbidden" })
    assert.deepEqual(decideTreeEdge(keep({ ...edge, child: otherFin }), kept, nobody), { ok: false, reason: "forbidden" }, "asked before anything is said of what's on record")
    assert.deepEqual(decideTreeEdge(end(), kept, owns), { ok: true, does: "end" })
    assert.deepEqual(decideTreeEdge(end(), undefined, owns), { ok: true, does: "nothing" }, "ended already, or never kept")
    assert.deepEqual(decideTreeEdge(end(), kept, nobody), { ok: false, reason: "forbidden" })
    assert.deepEqual(decideTreeEdge(end(), undefined, nobody), { ok: false, reason: "forbidden" }, "the same with no record, so nothing is learned of one")
    assert.deepEqual(decideTreeEdge(end("migrated:1"), undefined, () => true), { ok: false, reason: "forbidden" }, "a start that names no Session is nobody's to end")
    // Ended with notices still held under it: it stands until they're taken, ended again changes nothing, kept again it stands.
    const ending = { edge, ending: true }
    assert.deepEqual(decideTreeEdge(end(), ending, owns), { ok: true, does: "nothing" })
    assert.deepEqual(decideTreeEdge(keep(), ending, owns), { ok: true, does: "keep" })
    assert.deepEqual(decideTreeEdge(keep({ ...edge, child: otherFin }), ending, owns), { ok: false, reason: "conflict" })
  })

  test("a device's notice is admitted under the oldest record that names the device, the child and the Apex, Thread and Session both", () => {
    const notice = noticeOf("1")
    const later = { ...edge, op: `start:${apex.session}:again` }
    const cloud = { ...edge, op: `start:${apex.session}:cloud`, place: { kind: "cloud", thread: machine.thread } }
    assert.equal(treeEdgeOfNotice([cloud, edge, later], mac, notice), edge, "the oldest, and never a cloud Thread's")
    assert.equal(treeEdgeOfNotice([edge], apexMac, notice), undefined, "another device")
    assert.equal(treeEdgeOfNotice([edge], mac, noticeOf("1", otherFin)), undefined, "another child")
    assert.equal(treeEdgeOfNotice([edge], mac, { ...notice, parent: { ...apex, thread: otherFin } }), undefined, "another Thread of the Apex's")
    assert.equal(treeEdgeOfNotice([edge], mac, { ...notice, parent: { ...apex, session: otherFin } }), undefined, "another Session")
    assert.equal(treeEdgeOfNotice([], mac, notice), undefined)
  })

  test("a notice finds its record by one key, the device, the Apex's Session and Thread and the child, which the record is kept under; a cloud Fin's record has none", () => {
    const notice = noticeOf("1")
    assert.equal(treeEdgeNoticeKey(edge), treeNoticeEdgeKey(mac, notice))
    assert.equal(treeEdgeNoticeKey({ ...edge, place: { kind: "cloud", thread: machine.thread } }), undefined)
    for (const other of [treeNoticeEdgeKey(apexMac, notice), treeNoticeEdgeKey(mac, noticeOf("1", otherFin)), treeNoticeEdgeKey(mac, { ...notice, parent: { ...apex, thread: otherFin } }), treeNoticeEdgeKey(mac, { ...notice, parent: { ...apex, session: otherFin } })])
      assert.notEqual(other, treeEdgeNoticeKey(edge))
  })

  test("a Session's records stand 30 days past the last the account knew its owner was there: now while its link is up, when it went down, or its last ask", () => {
    const day = 24 * 60 * 60_000
    const now = 100 * day
    assert.equal(treeEdgesStandUntil(0, { up: true, at: 1 }, now), now + TREE_EDGE_LEASE_MS, "an owner on its link renews them by being there")
    assert.equal(treeEdgesStandUntil(0, { up: false, at: 90 * day }, now), 120 * day, "down ten days ago: twenty more")
    assert.equal(treeEdgesStandUntil(95 * day, { up: false, at: 90 * day }, now), 125 * day, "an ask since it went down counts from the ask")
    assert.ok(treeEdgesStandUntil(0, { up: false, at: 60 * day }, now) <= now, "down 40 days: lapsed")
    assert.equal(treeEdgesStandUntil(50 * day, undefined, now), 80 * day, "no device owns it (the cloud, or off the list): from its owner's last ask")
  })

  test("the fake keeps a record for the device whose runtime owns its Apex's Session, once, and refuses any other device, another record under the start, and what isn't an ask", async () => {
    const gateway = createFakeGateway()
    try {
      assert.deepEqual(await ask(gateway, apexMac, keep()), { ok: false, reason: "forbidden" }, "before the account lists who owns the Session")
      await owner(gateway, `d-${apexMac}`, { takes: false })
      assert.deepEqual(await ask(gateway, mac, keep()), { ok: false, reason: "forbidden" }, "the Fin's own device")
      assert.deepEqual(gateway.treeEdges(), [])
      assert.deepEqual(await ask(gateway, apexMac, keep()), { ok: true })
      assert.deepEqual(await ask(gateway, apexMac, keep()), { ok: true }, "again")
      assert.deepEqual(gateway.treeEdges(), [{ edge, ending: false }], "kept once")
      assert.deepEqual(await ask(gateway, apexMac, keep({ ...edge, child: otherFin })), { ok: false, reason: "conflict" })
      assert.deepEqual(await ask(gateway, apexMac, keep({ ...edge, place: { kind: "device", device: apexMac } })), { ok: false, reason: "conflict" })
      assert.deepEqual(gateway.treeEdges(), [{ edge, ending: false }], "and the first stands")
      for (const body of [{ ask: "keep", edge: { ...edge, op: "migrated:1" } }, { ask: "keep", edge: { ...edge, name: "parser" } }, { ask: "end" }, { ask: "list" }, edge])
        assert.deepEqual(await ask(gateway, apexMac, body), { ok: false, reason: "invalid" })
      assert.deepEqual(await gateway.askTreeEdge(apexMac, "not json"), { ok: false, reason: "invalid" })
      assert.deepEqual(await ask(gateway, mac, end()), { ok: false, reason: "forbidden" }, "nor does another device end it")
      assert.deepEqual(gateway.treeEdges().length, 1)
    } finally { await gateway.close() }
  })

  test("a device posts only for a child on record as its own: admitted under the record's start and held for the record's Apex's Session, and refused for any other with nothing held", async () => {
    const gateway = createFakeGateway()
    try {
      const sender = { kind: "device", device: mac }
      assert.deepEqual(await post(gateway, sender, noticeOf("1")), { admitted: false, reason: "forbidden" }, "no record yet")
      const apexHost = await owner(gateway, `d-${apexMac}`, { takes: false })
      assert.deepEqual(await ask(gateway, apexMac, keep()), { ok: true })
      assert.deepEqual(await post(gateway, sender, noticeOf("1", otherFin)), { admitted: false, reason: "forbidden" }, "a child with no record")
      assert.deepEqual(await post(gateway, { kind: "device", device: apexMac }, noticeOf("1")), { admitted: false, reason: "forbidden" }, "a child on record as another device's")
      assert.deepEqual(await post(gateway, sender, { ...noticeOf("1"), parent: { ...apex, session: otherFin } }), { admitted: false, reason: "forbidden" }, "for another Session than the record's Apex's")
      assert.deepEqual(await post(gateway, sender, { ...noticeOf("1"), parent: { ...apex, thread: otherFin } }), { admitted: false, reason: "forbidden" }, "or another Thread")
      assert.deepEqual(gateway.heldNotices(apex.session), [], "nothing of any was held")
      assert.deepEqual(gateway.heldNotices(otherFin), [])
      assert.equal(await apexHost.quiet(), true, "or delivered")
      assert.deepEqual(await post(gateway, sender, noticeOf("1")), { admitted: true, seq: 1 })
      assert.deepEqual(gateway.heldNotices(apex.session).map((held) => held.from), [{ op: edge.op, place: { kind: "device", device: mac }, seq: 1, at: gateway.heldNotices(apex.session)[0].from.at }], "stamped with the record's start and the device its credential names")
      // A record for a cloud Thread admits no device, and a machine is admitted as it was, by the start it was made for.
      assert.deepEqual(await ask(gateway, apexMac, keep({ ...edge, op: `start:${apex.session}:cloud`, child: otherFin, place: { kind: "cloud", thread: machine.thread } })), { ok: true })
      assert.deepEqual(await post(gateway, sender, noticeOf("1", otherFin)), { admitted: false, reason: "forbidden" })
      gateway.finMachine({ ...machine, op: `start:${apex.session}:cloud`, child: otherFin })
      assert.deepEqual(await post(gateway, { kind: "machine", machine: machine.machine }, noticeOf("1", otherFin)), { admitted: true, seq: 2 })
    } finally { await gateway.close() }
  })

  test("a device's notice reaches the Session's owner saying its record's start, and two records of one device are two Fins: the same ID under each is neither a repeat nor a conflict", async () => {
    const gateway = createFakeGateway()
    try {
      const apexHost = await owner(gateway, `d-${apexMac}`)
      const second = { ...edge, op: `start:${apex.session}:docs`, child: otherFin }
      assert.deepEqual(await ask(gateway, apexMac, keep()), { ok: true })
      assert.deepEqual(await ask(gateway, apexMac, keep(second)), { ok: true })
      const sender = { kind: "device", device: mac }
      assert.deepEqual(await post(gateway, sender, noticeOf("1")), { admitted: true, seq: 1 })
      const first = await apexHost.delivered()
      assert.deepEqual([first.notice.from.op, first.notice.from.place, first.notice.child], [edge.op, { kind: "device", device: mac }, fin])
      assert.deepEqual(first.operation.actor, { kind: "runtime", runtimeId: `gateway:${apex.thread}` }, "as the account itself, acting on the Apex's Thread")
      apexHost.answer(first.operation, { heard: true })
      assert.deepEqual(await post(gateway, sender, noticeOf("1", otherFin)), { admitted: true, seq: 2 })
      const next = await apexHost.delivered()
      assert.deepEqual([next.notice.from.op, next.notice.child], [second.op, otherFin])
      apexHost.answer(next.operation, { heard: true })
      await settle()
      assert.deepEqual(await post(gateway, sender, noticeOf("1")), { admitted: true, seq: 1 }, "each Fin's last notice is its own")
      assert.deepEqual(gateway.heldNotices(apex.session), [])
    } finally { await gateway.close() }
  })

  test("a Session's records lapsed stand while a notice under them is held and go once it's taken; kept again, they admit again", async () => {
    const gateway = createFakeGateway()
    try {
      const sender = { kind: "device", device: mac }
      let apexHost = await owner(gateway, `d-${apexMac}`, { takes: false })
      assert.deepEqual(await ask(gateway, apexMac, keep()), { ok: true })
      assert.deepEqual(await post(gateway, sender, noticeOf("1")), { admitted: true, seq: 1 })
      gateway.lapseTreeEdges(apex.session)
      assert.deepEqual(gateway.treeEdges(), [{ edge, ending: true }], "a notice the Fin posted under it waits: it stands")
      assert.deepEqual(await post(gateway, sender, noticeOf("2")), { admitted: true, seq: 2 }, "and admits as before")
      apexHost.link.close()
      await settle()
      apexHost = await owner(gateway, `d-${apexMac}`)
      for (const seq of [1, 2]) apexHost.answer((await apexHost.delivered()).operation, { heard: true }, seq)
      await settle()
      assert.deepEqual(gateway.treeEdges(), [], "taken: gone")
      // The Fin's next post brings it back, with its Apex's device off: it names this device, this child and this Apex.
      apexHost.link.close()
      await settle()
      assert.deepEqual(await post(gateway, sender, noticeOf("3")), { admitted: true, seq: 3 }, "brought back by its own Fin's post")
      assert.deepEqual(gateway.treeEdges(), [{ edge, ending: false }])
      assert.deepEqual(await post(gateway, { kind: "device", device: apexMac }, noticeOf("4")), { admitted: false, reason: "forbidden" }, "never by another device")
      assert.deepEqual(await ask(gateway, apexMac, keep()), { ok: true }, "and its owner keeps it as it is")
      apexHost = await owner(gateway, `d-${apexMac}`)
      apexHost.link.close()
      await settle()
    } finally { await gateway.close() }
  })

  test("a record ended with nothing held goes at once, and its own Fin's next post brings it back; with notices held it stands until they're taken", async () => {
    const gateway = createFakeGateway()
    try {
      const sender = { kind: "device", device: mac }
      let apexHost = await owner(gateway, `d-${apexMac}`, { takes: false })
      assert.deepEqual(await ask(gateway, apexMac, keep()), { ok: true })
      assert.deepEqual(await ask(gateway, apexMac, end()), { ok: true })
      assert.deepEqual(gateway.treeEdges(), [], "nothing held: gone")
      assert.deepEqual(await ask(gateway, apexMac, end()), { ok: true }, "ended again is done already")
      assert.deepEqual(await post(gateway, { kind: "device", device: apexMac }, noticeOf("1")), { admitted: false, reason: "forbidden" }, "no device it doesn't name brings it back")
      // Its own Fin's post brings it back and is admitted; kept again, it admits; ended while its notice is held, it admits still.
      assert.deepEqual(await post(gateway, sender, noticeOf("1")), { admitted: true, seq: 1 })
      assert.deepEqual(await ask(gateway, apexMac, keep()), { ok: true })
      assert.deepEqual(await ask(gateway, apexMac, end()), { ok: true })
      assert.deepEqual(gateway.treeEdges(), [{ edge, ending: true }])
      assert.deepEqual(await post(gateway, sender, noticeOf("2")), { admitted: true, seq: 2 }, "behind the one held, in its order")
      // Kept again while it was ending, it stands; ended once more, it goes when its owner has taken what's held.
      assert.deepEqual(await ask(gateway, apexMac, keep()), { ok: true })
      assert.deepEqual(gateway.treeEdges(), [{ edge, ending: false }])
      assert.deepEqual(await ask(gateway, apexMac, end()), { ok: true })
      apexHost.link.close()
      await settle()
      apexHost = await owner(gateway, `d-${apexMac}`)
      for (const seq of [1, 2]) {
        const delivered = await apexHost.delivered()
        assert.equal(delivered.notice.from.seq, seq)
        assert.equal(gateway.treeEdges().length, 1, "still on record while this one is held")
        apexHost.answer(delivered.operation, { heard: true })
      }
      await settle()
      assert.deepEqual(gateway.treeEdges(), [], "taken: gone")
      // Its Fin's next post brings it back: its Apex's device, hearing it, ends it again if its Fin is still stopped.
      assert.deepEqual(await post(gateway, sender, noticeOf("3")), { admitted: true, seq: 3 })
      assert.deepEqual(gateway.treeEdges(), [{ edge, ending: false }])
      // An archived Apex's records go with what was held for it, and a notice under one that stands is gone.
      assert.deepEqual(await ask(gateway, apexMac, keep()), { ok: true })
      apexHost.link.close()
      await settle()
      assert.deepEqual(await post(gateway, sender, noticeOf("4")), { admitted: true, seq: 4 })
      assert.deepEqual(await ask(gateway, apexMac, end()), { ok: true })
      gateway.archiveTree(apex.session)
      assert.deepEqual(gateway.treeEdges(), [], "ending, and what held it was dropped")
      assert.deepEqual(await ask(gateway, apexMac, keep()), { ok: true })
      assert.deepEqual(await post(gateway, sender, noticeOf("5")), { admitted: false, reason: "gone" })
    } finally { await gateway.close() }
  })
})

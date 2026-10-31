import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { runGatewayConformance, runMediaConformance } from "../dist/conformance.js"
import { CORRELATION_HEADER, GatewayHttpError, RETRY_AFTER_MOST_MS, gatewayCalls, retryAfterMs } from "../dist/gateway-http.js"
import { recordsOverHttp } from "../dist/records-http.js"
import { MOVE_CHECKPOINT_MAX_BYTES, MoveAnswerSchema, MoveCheckpointSchema, MoveClaimRequestSchema, ReturnStateSchema, ReturnBeginRequestSchema } from "../dist/moves.js"
import { RECIPE_WIRE_BYTES, recipeFits } from "../dist/recipes.js"
import { recipesOverHttp } from "../dist/recipes-http.js"
import { createFakeGateway } from "../dist/fake-gateway.js"
import { sessionStream, streamConversation } from "../dist/socket.js"
import { AccountEventSchema } from "../dist/account-events.js"
import { AccessChoicesAnswerSchema, AccessChoosingSchema, applyAccessChoosing, sameAccessChoices } from "../dist/access-choices.js"
import { WaitingInputSchema, WaitingMessageSchema, sameWaiting } from "../dist/waiting.js"
import { ATTENTION_SUMMARY_FROM, ATTENTION_WORDS, AttentionKindSchema, asks, attentionFact, attentionHeadline, attentionKey, attentionLine, attentionSummary, foldedBody, needsYouWaiting, questionWaiting, requestWaiting, rowWaitingFor, factStands, noticeTag, readNotice } from "../dist/attention.js"
import { ArchivedThreadSchema, ListedSessionSchema, ReportedSessionSchema, SessionListingsSchema, SessionsReportSchema, mayReplace, rowsForLink, sameListed } from "../dist/thread-listing.js"
import { CHUNK_HEADER_BYTES, RecordBundleSchema, RecordConflictError, decodeChunkPack, encodeChunkPack, planRecordImport, recordChunks } from "../dist/records.js"
import {
  CLOSE_CODES,
  PING,
  PONG,
  answerUnreadable,
  clientSessionOverSockets,
  decodeClientFrame,
  decodeGatewayClientFrame,
  encodeClientFrame,
  encodeGatewayClientFrame,
  encodeMediaMessage,
  gatewayOverSockets,
  LINK_VERSION,
  MEDIA_MESSAGE_LIMIT,
  PORT_BODY_LIMIT,
  PORTS_VERSION,
  QUIET_VERSION,
  decodePortHead,
  encodePortHead,
  MediaTooLargeError,
  decodeMediaMessage,
  mediaStreamOf,
  GatewayFrameEnvelopeSchema,
  OperationEnvelopeSchema,
  PROBLEM_DETAIL_LIMIT,
  PROTOCOL_VERSION,
  SUPPORTED_VERSIONS,
  Payload,
  ReplyEnvelopeSchema,
  RuntimeFrameEnvelopeSchema,
  RuntimeRefusedError,
  WireError,
  decodeEventFrame,
  decodeGatewayFrame,
  decodeOperation,
  decodeReply,
  decodeRuntimeFrame,
  encodeEventFrame,
  encodeGatewayFrame,
  encodeOperation,
  encodeReply,
  encodeRuntimeFrame,
  mayRetry,
  negotiate,
  nextStep,
  offeredCredential,
  problem,
  problemType,
  renewal,
  runtimeLinkOverSocket,
  serveRuntime,
  subprotocols,
  Inbox,
  RuntimeThreads,
  threadStream,
  LiveTail,
  LINGER_MS,
  NUMBERED_LIVE_VERSION,
  WAITING_FOR_VERSION,
  MOVES_VERSION,
  RAIL_VERSION,
  StreamCursor,
  followAgainInMs,
  readStreamNotice,
  streamNoticeText,
} from "../dist/index.js"

const operation = {
  v: PROTOCOL_VERSION,
  id: "6f1c2a8e-4b1d-4c3a-9f0e-2d7b5a9c1e34",
  op: "thread.send",
  target: { kind: "thread", threadId: "th-1" },
  correlationId: "c-1",
  actor: { kind: "client", client: "web", deviceId: "browser-1" },
  attempt: 1,
}

describe("versions", () => {
  test("both sides settle on the newest version they share", () => {
    assert.equal(negotiate({ min: 1, max: 3 }, { min: 2, max: 5 }), 3)
    assert.equal(negotiate({ min: 1, max: 1 }, { min: 1, max: 1 }), 1)
  })
  test("envelopes stay at version 1 on every link version, so a runtime from before link version 2 reads every operation", () => {
    assert.equal(PROTOCOL_VERSION, 1)
    assert.equal(SUPPORTED_VERSIONS.max, 12)
    const operation = { v: 1, id: crypto.randomUUID(), op: "thread.send", target: { kind: "thread", threadId: "th-1" }, input: Payload.of({}), correlationId: crypto.randomUUID(), actor: { kind: "client", client: "desktop", deviceId: "d-1" }, attempt: 1 }
    assert.equal(decodeOperation(encodeOperation(operation)).v, 1)
  })
  test("an activity frame crosses as its envelope alone", () => {
    const frame = { type: "activity", threadId: "th-1", generation: 3, busy: true, work: ["Codex: a turn"] }
    assert.deepEqual(decodeRuntimeFrame(encodeRuntimeFrame(frame)), frame)
    assert.throws(() => decodeRuntimeFrame(encodeRuntimeFrame({ ...frame, work: Array.from({ length: 21 }, () => "x") })), WireError)
  })
  test("ranges that don't overlap have no version", () => {
    assert.equal(negotiate({ min: 1, max: 2 }, { min: 3, max: 4 }), null)
  })
})

describe("cursor", () => {
  test("the next number applies, a repeat is dropped, and a jump asks to resume", () => {
    assert.deepEqual(nextStep(4, { seq: 5 }), { kind: "apply" })
    assert.deepEqual(nextStep(4, { seq: 4 }), { kind: "duplicate" })
    assert.deepEqual(nextStep(4, { seq: 2 }), { kind: "duplicate" })
    assert.deepEqual(nextStep(4, { seq: 7 }), { kind: "gap", after: 4 })
  })
})

describe("retries", () => {
  const unavailable = (outcome) =>
    problem("owner-unavailable", "gone", "c-1", outcome)
  test("anything but a passing outage is final", () => {
    for (const replay of ["read", "replay", "never"])
      assert.equal(
        mayRetry(replay, problem("conflict", "no", "c-1", "not-applied")),
        false
      )
  })
  test("reads and settled operations retry through an outage, whatever happened", () => {
    for (const replay of ["read", "replay"])
      assert.equal(mayRetry(replay, unavailable("unknown")), true)
  })
  test("an operation only the person can judge retries only if it never ran", () => {
    assert.equal(mayRetry("never", unavailable("not-applied")), true)
    assert.equal(mayRetry("never", unavailable("unknown")), false)
  })
})

describe("schemas", () => {
  test("an operation takes no fields it doesn't define", () => {
    assert.equal(OperationEnvelopeSchema.safeParse(operation).success, true)
    assert.equal(
      OperationEnvelopeSchema.safeParse({ ...operation, extra: 1 }).success,
      false
    )
  })
  test("an operation names one target: a Thread or a runtime", () => {
    assert.equal(
      OperationEnvelopeSchema.safeParse({
        ...operation,
        target: { kind: "runtime", runtimeId: "laptop" },
      }).success,
      true
    )
    for (const target of [
      undefined,
      { kind: "thread" },
      { kind: "thread", threadId: "th-1", runtimeId: "laptop" },
      { kind: "account" },
    ])
      assert.equal(
        OperationEnvelopeSchema.safeParse({ ...operation, target }).success,
        false,
        JSON.stringify(target)
      )
  })
  test("a long message is cut, never refused", () => {
    const made = problem("failed", "It failed", "c-1", "unknown", {
      detail: "x".repeat(PROBLEM_DETAIL_LIMIT + 10),
    })
    assert.equal(made.detail.length, PROBLEM_DETAIL_LIMIT)
    assert.ok(made.detail.endsWith("…"))
    assert.equal(
      ReplyEnvelopeSchema.safeParse({
        v: PROTOCOL_VERSION,
        id: operation.id,
        ok: false,
        problem: made,
      }).success,
      true
    )
  })
  test("operation names are lowercase words joined by dots", () => {
    for (const op of ["Thread.send", "thread..send", "thread_send", ".send"])
      assert.equal(
        OperationEnvelopeSchema.safeParse({ ...operation, op }).success,
        false,
        op
      )
  })
  test("a problem names a known type and whether it ran", () => {
    const reply = {
      v: PROTOCOL_VERSION,
      id: operation.id,
      ok: false,
      problem: problem("fenced", "moved", "c-1", "not-applied", {
        generation: 3,
      }),
    }
    assert.equal(ReplyEnvelopeSchema.safeParse(reply).success, true)
    assert.equal(
      ReplyEnvelopeSchema.safeParse({
        ...reply,
        problem: { ...reply.problem, type: "urn:mako:problem:nope" },
      }).success,
      false
    )
    assert.equal(
      ReplyEnvelopeSchema.safeParse({
        ...reply,
        problem: { ...reply.problem, outcome: undefined },
      }).success,
      false
    )
  })
  test("frames reject unknown types and wrong directions", () => {
    assert.equal(
      RuntimeFrameEnvelopeSchema.safeParse({ type: "ping" }).success,
      true
    )
    assert.equal(
      RuntimeFrameEnvelopeSchema.safeParse({
        type: "ack",
        threadId: "th-1",
        generation: 1,
        localSeq: 1,
        seq: 1,
      }).success,
      false
    )
    assert.equal(
      GatewayFrameEnvelopeSchema.safeParse({ type: "ping" }).success,
      false
    )
  })
})

describe("wire", () => {
  const pretty = Payload.encoded('{\n  "files": ["a\\nb"],\n  "size": 1.50\n}')
  const withInput = { ...operation, input: pretty }

  test("every frame comes back as it went, its payload byte for byte", () => {
    const ok = { v: PROTOCOL_VERSION, id: operation.id, ok: true, value: pretty }
    const empty = { v: PROTOCOL_VERSION, id: operation.id, ok: true, seq: 4 }
    const failed = {
      v: PROTOCOL_VERSION,
      id: operation.id,
      ok: false,
      problem: problem("failed", "It failed", "c-1", "unknown"),
    }
    assert.deepEqual(decodeOperation(encodeOperation(withInput)), withInput)
    for (const reply of [ok, empty, failed])
      assert.deepEqual(decodeReply(encodeReply(reply)), reply)
    for (const frame of [
      { type: "ping" },
      { type: "event", threadId: "th-1", generation: 1, localSeq: 1, event: pretty },
      { type: "reply", reply: ok },
      { type: "reply", reply: failed },
    ])
      assert.deepEqual(decodeRuntimeFrame(encodeRuntimeFrame(frame)), frame)
    for (const frame of [
      { type: "operation", generation: 2, operation: withInput },
      { type: "fence", threadId: "th-1", generation: 2 },
    ])
      assert.deepEqual(decodeGatewayFrame(encodeGatewayFrame(frame)), frame)
    const event = {
      v: PROTOCOL_VERSION,
      stream: "thread:th-1",
      seq: 1,
      at: new Date(0).toISOString(),
      event: pretty,
    }
    assert.deepEqual(decodeEventFrame(encodeEventFrame(event)), event)
  })

  test("the envelope is one line and the payload follows it as its producer wrote it", () => {
    const text = encodeOperation(withInput)
    const end = text.indexOf("\n")
    const { input, ...envelope } = withInput
    assert.equal(text.slice(0, end), JSON.stringify(envelope))
    assert.equal(text.slice(end + 1), input.text)
  })

  test("a payload where there is none, none where there is one, and an envelope that isn't JSON are refused", () => {
    const ping = `${JSON.stringify({ type: "ping" })}\n{}`
    const bare = JSON.stringify({ type: "event", threadId: "th-1", generation: 1, localSeq: 1 })
    const failure = `${encodeReply({
      v: PROTOCOL_VERSION,
      id: operation.id,
      ok: false,
      problem: problem("failed", "It failed", "c-1", "unknown"),
    })}\n"value"`
    const { input: _, ...envelope } = withInput
    for (const [decode, text] of [
      [decodeRuntimeFrame, ping],
      [decodeRuntimeFrame, bare],
      [decodeReply, failure],
      [decodeOperation, JSON.stringify(envelope)],
      [decodeOperation, `{"v":1,\n"id":"x"}\n{}`],
      [decodeReply, "not json"],
      [decodeGatewayFrame, `${JSON.stringify({ type: "nope" })}`],
    ])
      assert.throws(() => decode(text), WireError, text)
  })

  test("a payload is decoded by its consumer, which learns then whether its producer sent JSON", () => {
    assert.deepEqual(Payload.encoded('{ "a" : [1.50] }').decode(), { a: [1.5] })
    assert.throws(() => Payload.encoded("{").decode(), SyntaxError)
  })
})

describe("the fake gateway passes the conformance suite", () => {
  runGatewayConformance(async () => createFakeGateway(), test)
})

const client = { kind: "client", client: "desktop", deviceId: "desk-1" }
const call = (target, input, extra = {}) => ({
  v: PROTOCOL_VERSION,
  id: crypto.randomUUID(),
  op: "files.read",
  target,
  input: Payload.of(input),
  correlationId: crypto.randomUUID(),
  actor: client,
  attempt: 1,
  ...extra,
})
const laptop = { kind: "runtime", runtimeId: "laptop" }
const answer = (operation, value) => ({
  v: PROTOCOL_VERSION,
  id: operation.id,
  ok: true,
  value: Payload.of(value),
})

describe("a Thread whose runtime is asleep", () => {
  test("takes an operation marked defer without waking it, answers deferred, and delivers it in order when its runtime is back", async () => {
    const gateway = createFakeGateway()
    const session = await gateway.connectClient(client)
    const thread = { kind: "thread", threadId: "th-sleep" }
    const close = call(thread, { name: "close" }, { op: "host.live-close", whenAsleep: "defer" })
    const first = await session.call(close)
    assert.deepEqual({ ok: first.ok, deferred: first.deferred }, { ok: true, deferred: true })
    assert.deepEqual((await session.call({ ...close, attempt: 2 })).deferred, true, "a repeat of its id is answered the same")
    const plain = await session.call(call(thread, { name: "read" }))
    assert.equal(plain.ok, false, "one not marked defer is still refused while nobody runs the Thread")
    assert.deepEqual(gateway.deferred("th-sleep"), [close.id])
    const seen = []
    const runtime = await serveRuntime(await gateway.connectRuntime(), { runtimeId: "machine", build: "test", handle: async (operation) => (seen.push(operation.input.decode().name), answer(operation, null)) })
    await gateway.assign("th-sleep", "machine")
    while (!seen.length) await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(seen, ["close"])
    assert.deepEqual(gateway.deferred("th-sleep"), [])
    runtime.close()
    await runtime.done
    await gateway.close()
  })

  test("an operation's envelope may ask to be deferred, and a reply may say it was", () => {
    const { input: _input, ...envelope } = call(laptop, null)
    assert.equal(OperationEnvelopeSchema.safeParse({ ...envelope, whenAsleep: "defer" }).success, true)
    assert.equal(OperationEnvelopeSchema.safeParse({ ...envelope, whenAsleep: "later" }).success, false)
    assert.equal(OperationEnvelopeSchema.safeParse({ ...envelope, ahead: true }).success, true)
    assert.equal(OperationEnvelopeSchema.safeParse({ ...envelope, ahead: false }).success, false)
    assert.equal(OperationEnvelopeSchema.safeParse({ ...envelope, repeatable: true }).success, true)
    assert.equal(OperationEnvelopeSchema.safeParse({ ...envelope, repeatable: false }).success, false)
    assert.equal(ReplyEnvelopeSchema.safeParse({ v: PROTOCOL_VERSION, id: crypto.randomUUID(), ok: true, deferred: true }).success, true)
  })
})

describe("an operation its caller calls repeatable", () => {
  test("reaches the runtime without the gateway's own word, which a runtime on an older protocol would refuse", async () => {
    const gateway = createFakeGateway()
    const session = await gateway.connectClient(client)
    const seen = []
    const runtime = await serveRuntime(await gateway.connectRuntime(), { runtimeId: "machine", build: "test", handle: async (operation) => (seen.push(operation), answer(operation, null)) })
    const thread = { kind: "thread", threadId: "th-repeatable" }
    await gateway.assign("th-repeatable", "machine")
    const reply = await session.call(call(thread, { name: "start" }, { op: "host.live-start", repeatable: true }))
    assert.equal(reply.ok, true)
    assert.equal(seen.length, 1)
    assert.equal("repeatable" in seen[0], false)
    runtime.close()
    await runtime.done
    await gateway.close()
  })
})

describe("a window's passive look", () => {
  test("reaches a runtime that runs without the gateway's own word, and is answered at once, unapplied, while none does", async () => {
    const gateway = createFakeGateway()
    const session = await gateway.connectClient(client)
    const seen = []
    const runtime = await serveRuntime(await gateway.connectRuntime(), { runtimeId: "machine", build: "test", handle: async (operation) => (seen.push(operation), answer(operation, null)) })
    const thread = { kind: "thread", threadId: "th-passive" }
    await gateway.assign("th-passive", "machine")
    assert.equal((await session.call(call(thread, { name: "status" }, { op: "host.thread-app", passive: true }))).ok, true)
    assert.equal("passive" in seen[0], false)
    runtime.close()
    await runtime.done
    const asleep = await session.call(call(thread, { name: "status" }, { op: "host.thread-app", passive: true }))
    assert.equal(asleep.ok, false)
    assert.equal(asleep.problem.outcome, "not-applied")
    await gateway.close()
  })
})

describe("a runtime served through serveRuntime", () => {
  test("answers operations as they finish, not in the order they came", async () => {
    const gateway = createFakeGateway()
    const release = new Map()
    const runtime = await serveRuntime(await gateway.connectRuntime(), {
      runtimeId: "laptop",
      build: "test",
      handle: (operation) =>
        new Promise((resolve) =>
          release.set(operation.input.decode().name, () =>
            resolve(answer(operation, operation.input.decode().name))
          )
        ),
    })
    const session = await gateway.connectClient(client)
    const slow = session.call(call(laptop, { name: "slow" }))
    const fast = session.call(call(laptop, { name: "fast" }))
    while (release.size < 2)
      await new Promise((resolve) => setImmediate(resolve))
    release.get("fast")()
    assert.equal((await fast).value.decode(), "fast")
    release.get("slow")()
    assert.equal((await slow).value.decode(), "slow")
    runtime.close()
    await runtime.done
    await gateway.close()
  })

  test("says whether it's working, for the Threads it runs, on a gateway that speaks version 2; an older one never hears it", async () => {
    const gateway = createFakeGateway()
    const link = await gateway.connectRuntime()
    const runtime = await serveRuntime(link, { runtimeId: "machine", build: "test", handle: async (operation) => answer(operation, null) })
    await gateway.assign("th-1", "machine")
    while (!runtime.claims().length) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(runtime.version, LINK_VERSION)
    assert.equal(runtime.activity(true, ["Claude Code: a turn"]), true)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual({ busy: gateway.activity("th-1").busy, work: gateway.activity("th-1").work }, { busy: true, work: ["Claude Code: a turn"] })
    runtime.activity(false, [])
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(gateway.activity("th-1").busy, false)
    // Taken by another runtime: what this one says of the Thread no longer counts.
    await gateway.assign("th-1", "elsewhere")
    runtime.activity(true, ["late"])
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(gateway.activity("th-1").busy, false)
    runtime.close()
    // A runtime that negotiated version 1 sends nothing.
    const older = await serveRuntime(await gateway.connectRuntime(), { runtimeId: "old", build: "test", versions: { min: 1, max: 1 }, handle: async (operation) => answer(operation, null) })
    await gateway.assign("th-2", "old")
    while (!older.claims().length) await new Promise((resolve) => setImmediate(resolve))
    assert.equal(older.version, 1)
    assert.equal(older.activity(true, ["x"]), false)
    assert.equal(gateway.activity("th-2"), undefined)
    older.close()
    await gateway.close()
  })

  test("reports its Sessions on a gateway that speaks version 5; an older one never hears it, and version 4's listing is taken and dropped", async () => {
    const gateway = createFakeGateway()
    const runtime = await serveRuntime(await gateway.connectRuntime(), { runtimeId: "d-mac", build: "test", handle: async (operation) => answer(operation, null) })
    const report = { owned: [{ session: "0b8f3e1a-7c2d-4f6a-9e5b-1d3c8a7f2e60", generation: 1 }], listed: [], gone: [] }
    assert.equal(runtime.sessions(report), true)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(gateway.reports("d-mac"), [report])
    runtime.close()
    const oldLink = await gateway.connectRuntime()
    const older = await serveRuntime(oldLink, { runtimeId: "old", build: "test", versions: { min: 1, max: 4 }, handle: async (operation) => answer(operation, null) })
    assert.equal(older.version, 4)
    assert.equal(older.sessions(report), false)
    await gateway.assign("th-2", "old")
    while (!older.claims().length) await new Promise((resolve) => setImmediate(resolve))
    // A runtime from 2026-10-24 on version 4 sends the listing keyed by cloud Thread: its link holds.
    oldLink.send({ type: "listing", threadId: "th-2", generation: 1, listing: { conversations: [{ id: "c-1", harness: "codex" }] } })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(gateway.reports("old"), [])
    assert.equal(older.claims().length, 1, "its link held")
    older.close()
    await gateway.close()
  })

  test("a conversation's live updates go to whoever watches it: the runtime is told on the first watcher, again on a new link, and once the last has been gone a while", async () => {
    let clock = Date.parse("2026-10-29T12:00:00.000Z")
    const gateway = createFakeGateway({ now: () => new Date(clock) })
    const watching = []
    const serve = async () => serveRuntime(await gateway.connectRuntime(), { runtimeId: "d-mac", build: "test", handle: async (operation) => answer(operation, null), watch: (conversations) => watching.push([...conversations]) })
    let runtime = await serve()
    const watcher = await gateway.connectClient(client)
    const stream = sessionStream("d-mac", "c-1")
    assert.deepEqual(streamConversation(stream), { runtimeId: "d-mac", conversation: "c-1" })
    const first = watcher.subscribe({ stream, after: 0 })
    const second = watcher.subscribe({ stream, after: 0 })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(watching, [["c-1"]], "a new link watches nothing until the first watcher")
    for (const reader of [first, second]) assert.equal(readStreamNotice((await reader.next(1_000)).event.text)?.streamNotice, "head", "each watcher hears the stream's head first")
    assert.equal(runtime.live("c-1", Payload.of({ n: 1 }), { n: 1 }), true)
    assert.deepEqual([(await first.next(1_000)).event.decode(), (await second.next(1_000)).event.decode()], [{ n: 1 }, { n: 1 }])
    runtime.close()
    runtime = await serve()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(watching.at(-1), ["c-1"], "a new link hears what's watched")
    first.close()
    second.close()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(watching.at(-1), ["c-1"], "a stream the last watcher left lingers, so one back from a dropped link misses nothing")
    clock += LINGER_MS
    runtime.live("c-1", Payload.of({ n: 2 }), { n: 2 })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(watching.at(-1), [], "and goes once nobody has watched it for a while")
    runtime.close()
    await gateway.close()
  })

  test("a live stream's tail serves a watcher back from a dropped link, and says to read again past what it keeps; a cursor tells each frame apart", () => {
    const tail = new LiveTail(1_000, { frames: 3 })
    const at = new Date()
    for (const n of [1, 2, 3, 4]) tail.take(`u${n}`, at, { n })
    assert.equal(tail.take("u4 again", at, { n: 4 }), undefined, "a runtime's resend is relayed once")
    assert.equal(tail.head, 1_004)
    assert.deepEqual(tail.since(1_002)?.map((frame) => frame.text), ["u3", "u4"])
    assert.deepEqual(tail.since(1_004), [])
    assert.equal(tail.since(1_000), undefined, "past what it keeps")
    assert.equal(tail.since(999), undefined, "from before the stream began")
    assert.equal(readStreamNotice(tail.opening(1)[0].text)?.streamNotice, "reread")
    const cursor = new StreamCursor("live")
    assert.equal(cursor.resumeAfter(), 0)
    assert.deepEqual(cursor.heard({ seq: 1, text: "an update from a gateway that numbers by the clock" }), { kind: "apply" })
    assert.deepEqual(cursor.heard({ seq: 1_004, text: streamNoticeText({ streamNotice: "head", head: 1_004 }) }), { kind: "notice" })
    assert.equal(cursor.resumeAfter(), 1_004)
    assert.deepEqual(cursor.heard({ seq: 1_005, text: "u5" }), { kind: "apply" })
    assert.deepEqual(cursor.heard({ seq: 1_005, text: "u5" }), { kind: "duplicate" })
    assert.deepEqual(cursor.heard({ seq: 1_007, text: "u7" }), { kind: "gap", after: 1_005 })
    assert.deepEqual(cursor.heard({ seq: 1_008, text: "u8, still on its way" }), { kind: "duplicate" }, "dropped until what was asked for begins")
    assert.deepEqual(cursor.heard({ seq: 1_008, text: streamNoticeText({ streamNotice: "head", head: 1_008 }) }), { kind: "notice" })
    assert.deepEqual(cursor.heard({ seq: 1_006, text: "u6" }), { kind: "apply" })
    assert.deepEqual(cursor.heard({ seq: 1_009, text: streamNoticeText({ streamNotice: "reread", head: 1_009 }) }), { kind: "reread" })
    assert.equal(cursor.last, 1_009)
    const log = new StreamCursor("log", 10)
    assert.deepEqual(log.heard({ seq: 12, text: "{}" }), { kind: "gap", after: 10 })
    assert.deepEqual(log.heard({ seq: 11, text: "{}" }), { kind: "apply" })
    assert.equal(followAgainInMs(0, () => 0.5), 50)
    assert.equal(followAgainInMs(1), 250)
  })

  test("a live update goes with its runtime's number and trace, and a report with when it went, only on a link that knows them; older links get them without", async () => {
    const gateway = createFakeGateway()
    const sent = []
    const tap = (link) => ({ ...link, send: (frame) => { sent.push(frame); link.send(frame) } })
    const newer = await serveRuntime(tap(await gateway.connectRuntime()), { runtimeId: "d-new", build: "test", handle: async (operation) => answer(operation, null) })
    const older = await serveRuntime(tap(await gateway.connectRuntime()), { runtimeId: "d-old", build: "test", versions: { min: 1, max: NUMBERED_LIVE_VERSION - 1 }, handle: async (operation) => answer(operation, null) })
    const report = { listed: [], gone: [], reportedAt: "2026-10-29T12:00:00.000Z" }
    for (const runtime of [newer, older]) {
      runtime.live("c-1", Payload.of({}), { n: 3, correlationId: "st-1" })
      runtime.sessions(report)
    }
    const of = (type) => sent.filter((frame) => frame.type === type)
    assert.deepEqual(of("live").map(({ n, correlationId }) => [n, correlationId]), [[3, "st-1"], [undefined, undefined]])
    assert.deepEqual(of("sessions").map((frame) => frame.report.reportedAt), ["2026-10-29T12:00:00.000Z", undefined])
    const row = { session: crypto.randomUUID(), thread: crypto.randomUUID(), conversation: "c-1", harness: "codex", state: "idle", createdAt: report.reportedAt, activityAt: report.reportedAt, generation: 1, changedAt: report.reportedAt }
    assert.equal(rowsForLink([row], NUMBERED_LIVE_VERSION)[0].changedAt, report.reportedAt)
    assert.equal(rowsForLink([row], NUMBERED_LIVE_VERSION - 1)[0].changedAt, undefined)
    newer.close()
    older.close()
    await gateway.close()
  })

  test("a runtime going quiet on purpose says so on a link that knows the frame, and its link is let go at once; an older link never hears it", async () => {
    const lines = []
    const gateway = createFakeGateway({ log: (line) => lines.push(line) })
    const runtime = await serveRuntime(await gateway.connectRuntime(), { runtimeId: "d-mac", build: "test", handle: async (operation) => answer(operation, null) })
    assert.equal(runtime.version, LINK_VERSION)
    assert.equal(runtime.goingQuiet("sleep"), true)
    await runtime.done
    assert.deepEqual(lines.filter((line) => line.event === "going-quiet" || line.event === "disconnected").map((line) => line.event), ["going-quiet", "disconnected"])
    assert.equal(runtime.goingQuiet("quit"), false, "a closed link says nothing")
    const older = await serveRuntime(await gateway.connectRuntime(), { runtimeId: "d-old", build: "test", versions: { min: 1, max: QUIET_VERSION - 1 }, handle: async (operation) => answer(operation, null) })
    assert.equal(older.goingQuiet("sleep"), false, "a gateway on version 7 never sees the frame; it finds out from the heartbeats")
    assert.equal(lines.filter((line) => line.event === "going-quiet").length, 1)
    assert.deepEqual(decodeRuntimeFrame(encodeRuntimeFrame({ type: "going-quiet", reason: "sign-out" })), { type: "going-quiet", reason: "sign-out" })
    assert.throws(() => decodeRuntimeFrame(JSON.stringify({ type: "going-quiet", reason: "bored" })), WireError)
    older.close()
    await gateway.close()
  })

  test("a handler that throws is answered as internal, with an unknown outcome", async () => {
    const gateway = createFakeGateway()
    const runtime = await serveRuntime(await gateway.connectRuntime(), {
      runtimeId: "laptop",
      build: "test",
      handle: async () => {
        throw new Error("disk on fire")
      },
    })
    const reply = await (
      await gateway.connectClient(client)
    ).call(call(laptop, {}))
    assert.equal(reply.ok, false)
    assert.equal(reply.problem.type, "urn:mako:problem:internal")
    assert.equal(reply.problem.outcome, "unknown")
    assert.equal(reply.problem.detail, "disk on fire")
    runtime.close()
    await gateway.close()
  })

  test("follows assign and fence, and refuses work for a Thread it no longer runs", async () => {
    const gateway = createFakeGateway()
    const frames = []
    const runtime = await serveRuntime(await gateway.connectRuntime(), {
      runtimeId: "laptop",
      build: "test",
      handle: async (operation, generation) => answer(operation, generation),
      onFrame: (frame) => frames.push(frame.type),
    })
    const generation = await gateway.assign("th-1", "laptop")
    const session = await gateway.connectClient(client)
    const thread = { kind: "thread", threadId: "th-1" }
    assert.equal(
      (await session.call(call(thread, {}))).value.decode(),
      generation
    )
    assert.equal(runtime.generation("th-1"), generation)

    await gateway.assign("th-1", "elsewhere")
    while (runtime.generation("th-1") !== undefined)
      await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(frames, ["assign", "operation", "fence"])
    runtime.close()
    await gateway.close()
  })

  test("a refused enrolment throws with the gateway's reason", async () => {
    const gateway = createFakeGateway()
    await assert.rejects(
      serveRuntime(await gateway.connectRuntime(), {
        runtimeId: "laptop",
        build: "test",
        versions: { min: SUPPORTED_VERSIONS.max + 1, max: SUPPORTED_VERSIONS.max + 1 },
        handle: async () => assert.fail("never called"),
      }),
      (error) =>
        error instanceof RuntimeRefusedError &&
        error.problem.type === "urn:mako:problem:unsupported-version"
    )
    await gateway.close()
  })

  test("renews its link's token when it's due; a refused renewal ends the link", async () => {
    const seen = []
    const gateway = createFakeGateway({ renew: (token) => (token === "good" ? 1_800_000_000 : undefined) })
    const link = await gateway.connectRuntime()
    const tokens = ["good", "bad"]
    const runtime = await serveRuntime(link, {
      runtimeId: "laptop",
      build: "test",
      handle: async (operation) => answer(operation, null),
      credential: { token: async () => tokens.shift(), renewInMs: () => 0 },
      onFrame: (frame) => seen.push(frame.type),
    })
    await runtime.done
    assert.deepEqual(seen, ["renewed", "refused"])
  })
  test("a credential rides as the second subprotocol, read back only beside mako.v1", () => {
    assert.deepEqual(subprotocols("t-1"), ["mako.v1", "mako.token.t-1"])
    assert.equal(offeredCredential(subprotocols("t-1").join(", ")), "t-1")
    assert.equal(offeredCredential("mako.token.t-1"), undefined, "without mako.v1")
    assert.equal(offeredCredential("mako.v1, mako.token."), undefined, "an empty credential")
    assert.equal(offeredCredential(null), undefined)
  })
  test("a token supply that fails is tried again, and a renewal left unanswered is sent again", async () => {
    const sent = []
    let calls = 0
    const renewing = renewal(
      { token: async () => (++calls === 1 ? Promise.reject(new Error("offline")) : `t-${calls}`), renewInMs: () => 0 },
      (token) => sent.push(token)
    )
    await new Promise((resolve) => setTimeout(resolve, 2_300))
    assert.deepEqual(sent, ["t-2"], "after the failed supply, one more try a second later")
    renewing.renewed()
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    assert.deepEqual(sent, ["t-2", "t-3"], "once renewed, the next one is on schedule")
    renewing.stop()
  })
  test("a runtime knows the Threads it runs, to claim them on its next link, and why its link ended", async () => {
    const gateway = createFakeGateway()
    const runtime = await serveRuntime(await gateway.connectRuntime(), { runtimeId: "laptop", build: "test", handle: async (operation) => answer(operation, null) })
    const generation = await gateway.assign("th-1", "laptop")
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(runtime.claims(), [{ threadId: "th-1", generation }])
    await gateway.close()
    assert.equal(await runtime.ended, undefined, "closed, not refused")
    const next = await serveRuntime(await createFakeGateway({ renew: () => undefined }).connectRuntime(), {
      runtimeId: "laptop",
      build: "test",
      threads: runtime.claims(),
      handle: async (operation) => answer(operation, null),
      credential: { token: async () => "t", renewInMs: () => 0 },
    })
    assert.equal((await next.ended)?.type, "urn:mako:problem:unauthorized")
  })
  test("sends heartbeats at the pace the gateway asked for, and stops once closed", async () => {
    const gateway = createFakeGateway({ heartbeatMs: 5 })
    const link = await gateway.connectRuntime()
    let beats = 0
    const counted = {
      ...link,
      send: (frame) => {
        if (frame.type === "ping") beats++
        link.send(frame)
      },
      next: link.next,
      frames: link.frames,
      close: link.close,
      get closed() {
        return link.closed
      },
    }
    const runtime = await serveRuntime(counted, {
      runtimeId: "laptop",
      build: "test",
      handle: async (operation) => answer(operation, null),
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.ok(beats >= 3, `${beats} heartbeats in 40 ms`)
    runtime.close()
    await runtime.done
    const after = beats
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(beats, after)
    await gateway.close()
  })
})

/** A link the test plays the gateway's side of: what the runtime sent, and frames pushed to it. */
function scriptedLink() {
  const inbox = new Inbox()
  const sent = []
  let closed = false
  return {
    sent,
    push: (frame) => inbox.push(frame),
    events: () => sent.filter((frame) => frame.type === "event").map((frame) => frame.localSeq),
    send: (frame) => {
      if (!closed) sent.push(frame)
    },
    sendUnchecked: () => {},
    next: (timeoutMs) => inbox.next(timeoutMs),
    frames: () => inbox,
    close: () => {
      closed = true
      inbox.close()
    },
    get closed() {
      return closed
    },
  }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))
const enrolled = { type: "enrolled", version: PROTOCOL_VERSION, heartbeatMs: 60_000 }

describe("a runtime's outbox", () => {
  test("a Thread's events reach its stream in order and are dropped once acknowledged", async () => {
    const gateway = createFakeGateway()
    const runtime = await serveRuntime(await gateway.connectRuntime(), { runtimeId: "laptop", build: "test", handle: async (operation) => answer(operation, null) })
    await gateway.assign("th-1", "laptop")
    while (runtime.generation("th-1") === undefined) await settle()
    assert.deepEqual([1, 2, 3].map((n) => runtime.emit("th-1", Payload.of({ n }))), [1, 2, 3])
    assert.equal(runtime.emit("th-other", Payload.of({})), undefined, "not a Thread it runs")
    const stream = (await gateway.connectClient(client)).subscribe({ stream: threadStream("th-1"), after: 0 })
    const seen = []
    while (seen.length < 3) seen.push((await stream.next()).event.decode().n)
    assert.deepEqual(seen, [1, 2, 3])
    runtime.close()
    await gateway.close()
  })

  test("what was emitted with no link up goes on the next link, after its enrolment, and is recorded once", async () => {
    const gateway = createFakeGateway()
    const generation = await gateway.assign("th-1", "laptop")
    const threads = new RuntimeThreads({ claims: [{ threadId: "th-1", generation }] })
    threads.emit("th-1", Payload.of("offline-1"))
    const first = await serveRuntime(await gateway.connectRuntime(), { runtimeId: "laptop", build: "test", threads, handle: async (operation) => answer(operation, null) })
    threads.emit("th-1", Payload.of("online"))
    while (threads.stats()[0].waiting) await settle()
    first.close()
    await first.done
    threads.emit("th-1", Payload.of("offline-2"))
    assert.equal(threads.stats()[0].waiting, 1)
    const second = await serveRuntime(await gateway.connectRuntime(), { runtimeId: "laptop", build: "test", threads, handle: async (operation) => answer(operation, null) })
    while (threads.stats()[0].waiting) await settle()
    const stream = (await gateway.connectClient(client)).subscribe({ stream: threadStream("th-1"), after: 0 })
    const seen = []
    for (let i = 0; i < 3; i++) seen.push((await stream.next()).event.decode())
    assert.deepEqual(seen, ["offline-1", "online", "offline-2"])
    const [stats] = threads.stats()
    assert.deepEqual(stats, { ...stats, localSeq: 3, acked: 3, lost: 0 })
    second.close()
    await gateway.close()
  })

  test("what a link took but never acknowledged goes on the next link, and counts as resent", async () => {
    const threads = new RuntimeThreads({ claims: [{ threadId: "th-1", generation: 1 }] })
    const first = scriptedLink()
    first.push(enrolled)
    const runtime = await serveRuntime(first, { runtimeId: "laptop", build: "test", threads, handle: async (operation) => answer(operation, null) })
    for (let i = 0; i < 3; i++) runtime.emit("th-1", Payload.of(i))
    first.push({ type: "ack", threadId: "th-1", generation: 1, localSeq: 1, seq: 1 })
    await settle()
    runtime.close()
    const second = scriptedLink()
    second.push(enrolled)
    const again = await serveRuntime(second, { runtimeId: "laptop", build: "test", threads, handle: async (operation) => answer(operation, null) })
    assert.deepEqual(second.events(), [2, 3])
    const [stats] = threads.stats()
    assert.deepEqual(stats, { ...stats, sent: 5, acked: 1, resent: 2, waiting: 2 })
    again.close()
  })

  test("a rejection it may recover from sends that event and everything after it again, once", async () => {
    const link = scriptedLink()
    link.push(enrolled)
    const threads = new RuntimeThreads({ claims: [{ threadId: "th-1", generation: 2 }] })
    const runtime = await serveRuntime(link, { runtimeId: "laptop", build: "test", threads, handle: async (operation) => answer(operation, null) })
    for (let i = 0; i < 4; i++) runtime.emit("th-1", Payload.of(i))
    assert.deepEqual(link.events(), [1, 2, 3, 4])
    const unavailable = (localSeq) => ({ type: "rejected", threadId: "th-1", generation: 2, localSeq, problem: problem("unavailable", "not taken", "c", "not-applied") })
    link.push({ type: "ack", threadId: "th-1", generation: 2, localSeq: 1, seq: 10 })
    // The batch holding 2 failed; 3 and 4 were already on their way, and the gateway refused them too.
    link.push(unavailable(2))
    link.push(unavailable(3))
    link.push(unavailable(4))
    await settle()
    assert.deepEqual(link.events(), [1, 2, 3, 4, 2, 3, 4], "sent again from 2, once")
    // The resend failed as well: from 2 again.
    link.push(unavailable(2))
    await settle()
    assert.deepEqual(link.events().slice(7), [2, 3, 4])
    for (const localSeq of [2, 3, 4]) link.push({ type: "ack", threadId: "th-1", generation: 2, localSeq, seq: 9 + localSeq })
    link.push(unavailable(3))
    await settle()
    assert.equal(threads.stats()[0].waiting, 0)
    assert.equal(threads.stats()[0].seq, 13)
    assert.equal(link.events().length, 10, "a late rejection of an acknowledged event sends nothing")
    link.push({ type: "rejected", threadId: "th-1", generation: 1, localSeq: 1, problem: problem("unavailable", "old", "c", "not-applied") })
    await settle()
    assert.equal(link.events().length, 10, "a rejection under another generation isn't this one's")
    runtime.close()
  })

  test("a fence, or a rejection as fenced, drops the Thread and what it was owed", async () => {
    const link = scriptedLink()
    link.push(enrolled)
    const threads = new RuntimeThreads({ claims: [{ threadId: "th-1", generation: 1 }, { threadId: "th-2", generation: 1 }] })
    const runtime = await serveRuntime(link, { runtimeId: "laptop", build: "test", threads, handle: async (operation) => answer(operation, null) })
    runtime.emit("th-1", Payload.of("a"))
    runtime.emit("th-2", Payload.of("b"))
    link.push({ type: "fence", threadId: "th-1", generation: 2 })
    link.push({ type: "rejected", threadId: "th-2", generation: 1, localSeq: 1, problem: problem("fenced", "moved", "c", "not-applied", { generation: 2 }) })
    await settle()
    assert.deepEqual(threads.claims(), [])
    assert.equal(runtime.emit("th-1", Payload.of("late")), undefined)
    link.push({ type: "assign", threadId: "th-1", generation: 3 })
    await settle()
    assert.equal(runtime.emit("th-1", Payload.of("again")), 1, "a new generation numbers from 1")
    runtime.close()
  })

  test("numbers reserved on disk carry over a restart, and nothing past the reservation is sent before it's written", async () => {
    const disk = new Map()
    const writes = []
    const numbers = {
      reserved: (threadId, generation) => disk.get(`${threadId}:${generation}`) ?? 0,
      reserve: (threadId, generation, upTo) =>
        new Promise((resolve) => writes.push(() => {
          disk.set(`${threadId}:${generation}`, upTo)
          resolve()
        })),
    }
    const link = scriptedLink()
    link.push(enrolled)
    const threads = new RuntimeThreads({ claims: [{ threadId: "th-1", generation: 4 }], numbers })
    const runtime = await serveRuntime(link, { runtimeId: "m-1", build: "test", threads, handle: async (operation) => answer(operation, null) })
    runtime.emit("th-1", Payload.of(1))
    runtime.emit("th-1", Payload.of(2))
    assert.deepEqual(link.events(), [], "waiting for the reservation")
    assert.equal(writes.length, 1, "one write for the block")
    writes.shift()()
    await settle()
    assert.deepEqual(link.events(), [1, 2])
    runtime.close()
    const restarted = new RuntimeThreads({ claims: [{ threadId: "th-1", generation: 4 }], numbers })
    assert.equal(restarted.emit("th-1", Payload.of(3)), 1_001, "after what the last process reserved")
    assert.equal(writes.length, 1)
  })

  test("past its bound the oldest events are given up and counted, and an event too large for the gateway is refused", () => {
    const lost = []
    const threads = new RuntimeThreads({ claims: [{ threadId: "th-1", generation: 1 }], maxBytes: 10, maxEventBytes: 8, onLost: (threadId, count) => lost.push([threadId, count]) })
    for (let i = 0; i < 4; i++) threads.emit("th-1", Payload.of("abc"))
    assert.deepEqual(lost, [["th-1", 1], ["th-1", 1]])
    assert.deepEqual([threads.stats()[0].waiting, threads.stats()[0].lost, threads.stats()[0].bytes], [2, 2, 10])
    assert.throws(() => threads.emit("th-1", Payload.of("é".repeat(4))), RangeError, "measured in UTF-8 bytes")
  })
})

describe("the fake gateway's log", () => {
  test("has one line per operation, with its correlation ID, target and where the answer came from", async () => {
    const lines = []
    const gateway = createFakeGateway({ log: (line) => lines.push(line) })
    const runtime = await serveRuntime(await gateway.connectRuntime(), {
      runtimeId: "laptop",
      build: "test",
      handle: async (operation) => answer(operation, "ok"),
    })
    const session = await gateway.connectClient(client)
    const sent = call(laptop, {})
    await session.call(sent)
    await session.call({ ...sent, attempt: 2 })
    await session.call(call({ kind: "runtime", runtimeId: "gone" }, {}))
    const operations = lines.filter((line) => line.event === "operation")
    assert.deepEqual(
      operations.map(
        ({ correlationId, target, attempt, outcome, answeredBy }) => ({
          correlationId:
            correlationId === sent.correlationId ? "sent" : "other",
          target,
          attempt,
          outcome,
          answeredBy,
        })
      ),
      [
        {
          correlationId: "sent",
          target: "runtime:laptop",
          attempt: 1,
          outcome: "ok",
          answeredBy: "runtime",
        },
        {
          correlationId: "sent",
          target: "runtime:laptop",
          attempt: 2,
          outcome: "ok",
          answeredBy: "earlier-attempt",
        },
        {
          correlationId: "other",
          target: "runtime:gone",
          attempt: 1,
          outcome: "owner-unavailable",
          answeredBy: "gateway",
        },
      ]
    )
    for (const line of operations)
      assert.ok(Number.isInteger(line.ms) && line.ms >= 0)
    runtime.close()
    await gateway.close()
  })
})

// The socket transport, proved by running the whole conformance suite through it: the fake gateway
// served over in-memory sockets that behave as WebSockets do (text frames, asynchronous delivery,
// close on both ends), so every case crosses the client and runtime adapters and the client frames.
class MemorySocket {
  readyState = 0
  peer = undefined
  listeners = { open: [], message: [], close: [], error: [] }
  addEventListener(type, listener) {
    this.listeners[type].push(listener)
  }
  emit(type, event = {}) {
    for (const listener of this.listeners[type]) listener(event)
  }
  send(data) {
    if (this.readyState !== 1) throw new Error("not open")
    const peer = this.peer
    queueMicrotask(() => peer.readyState === 1 && peer.emit("message", { data }))
  }
  close() {
    for (const end of [this, this.peer]) {
      if (end.readyState === 3) continue
      end.readyState = 3
      queueMicrotask(() => end.emit("close"))
    }
  }
}

function socketPair() {
  const near = new MemorySocket()
  const far = new MemorySocket()
  near.peer = far
  far.peer = near
  queueMicrotask(() => {
    near.readyState = 1
    far.readyState = 1
    near.emit("open")
    far.emit("open")
  })
  return [near, far]
}

/** Serves a gateway's runtime links and client sessions over the far ends of socket pairs. */
function servedOverSockets(gateway) {
  return gatewayOverSockets({
    async runtime() {
      const [near, far] = socketPair()
      const link = await gateway.connectRuntime()
      far.addEventListener("message", (event) =>
        event.data instanceof Uint8Array ? link.sendMedia(event.data) : link.sendUnchecked(event.data)
      )
      far.addEventListener("close", () => link.close())
      void (async () => {
        for await (const frame of link.frames()) if (far.readyState === 1) far.send(encodeGatewayFrame(frame))
        if (far.readyState === 1) far.close()
      })()
      return near
    },
    async client(actor, endpoint) {
      const [near, far] = socketPair()
      const session = await gateway.connectClient(actor)
      const subscriptions = new Map()
      const watches = new Map()
      far.addEventListener("message", async (event) => {
        let frame
        try {
          frame = decodeClientFrame(event.data)
        } catch (error) {
          return far.send(encodeGatewayClientFrame(answerUnreadable(event.data, error.message)))
        }
        if (frame.type === "call") {
          const reply = await session.call(frame.operation)
          if (far.readyState === 1) far.send(encodeGatewayClientFrame({ type: "reply", reply }))
        } else if (frame.type === "subscribe") {
          const subscription = session.subscribe({ stream: frame.stream, after: frame.after })
          subscriptions.set(frame.stream, subscription)
          void (async () => {
            for (;;) {
              const next = await subscription.next().catch(() => undefined)
              if (!next || far.readyState !== 1) return
              far.send(encodeGatewayClientFrame({ type: "event", event: next }))
            }
          })()
        } else if (frame.type === "unsubscribe") subscriptions.get(frame.stream)?.close()
        else if (frame.type === "media-watch") {
          const watching = watches.get(frame.stream)
          if (watching) return watching.update(frame.request)
          const watch = session.watch({ threadId: endpoint.threadId, stream: frame.stream, request: frame.request })
          watches.set(frame.stream, watch)
          void (async () => {
            for (;;) {
              const delivery = await watch.next().catch(() => undefined)
              if (!delivery || far.readyState !== 1) return
              if (delivery.kind === "data") far.send(encodeMediaMessage(frame.stream, delivery.data))
              else {
                watches.delete(frame.stream)
                return far.send(encodeGatewayClientFrame({ type: "media-ended", stream: frame.stream, problem: delivery.problem }))
              }
            }
          })()
        } else if (frame.type === "media-ack") watches.get(frame.stream)?.ack(frame.received)
        else if (frame.type === "media-unwatch") {
          watches.get(frame.stream)?.close()
          watches.delete(frame.stream)
        }
      })
      return near
    },
    assign: (threadId, runtimeId) => gateway.assign(threadId, runtimeId),
    close: () => gateway.close(),
  })
}

describe("conformance over sockets", () => {
  runGatewayConformance(async () => servedOverSockets(createFakeGateway()), test)
})

/** The media suite's view of any gateway the conformance suite drives: a Thread is a runtime that enrolled and was assigned it. */
function mediaGateway(gateway) {
  return {
    async thread(versions = SUPPORTED_VERSIONS) {
      const runtimeId = `rt-${crypto.randomUUID()}`
      const threadId = `th-${crypto.randomUUID()}`
      const runtime = await gateway.connectRuntime()
      runtime.send({ type: "enroll", runtimeId, versions, build: "media-conformance", threads: [] })
      assert.equal((await runtime.next()).type, "enrolled")
      await gateway.assign(threadId, runtimeId)
      assert.equal((await runtime.next()).type, "assign")
      return { threadId, runtime }
    },
    client: () => gateway.connectClient({ kind: "client", client: "desktop", deviceId: "media-conformance" }),
    close: () => gateway.close(),
  }
}

describe("media conformance", () => {
  runMediaConformance(async () => mediaGateway(createFakeGateway()), test)
})

describe("media conformance over sockets", () => {
  runMediaConformance(async () => mediaGateway(servedOverSockets(createFakeGateway())), test)
})

describe("media messages", () => {
  test("carry the stream's name and its bytes, and a hop reads the name from the header alone", () => {
    const data = Uint8Array.of(0, 1, 2, 255)
    const message = encodeMediaMessage("stream-1", data)
    assert.deepEqual([...message.subarray(0, 3)], [0x6d, 1, 8])
    assert.equal(mediaStreamOf(message), "stream-1")
    const decoded = decodeMediaMessage(message)
    assert.equal(decoded.stream, "stream-1")
    assert.deepEqual(decoded.data, data)
    assert.equal(decoded.data.buffer, message.buffer, "a view, not a copy")
  })

  test("hold at most the limit, header included", () => {
    const header = 3 + "stream-1".length
    assert.equal(encodeMediaMessage("stream-1", new Uint8Array(MEDIA_MESSAGE_LIMIT - header)).byteLength, MEDIA_MESSAGE_LIMIT)
    assert.throws(() => encodeMediaMessage("stream-1", new Uint8Array(MEDIA_MESSAGE_LIMIT - header + 1)), MediaTooLargeError)
    assert.throws(() => mediaStreamOf(new Uint8Array(MEDIA_MESSAGE_LIMIT + 1).fill(0x6d)), WireError)
  })

  test("that aren't one, or name no valid stream, are refused as unreadable", () => {
    const valid = encodeMediaMessage("stream-1", Uint8Array.of(9))
    const broken = [
      new Uint8Array(),
      Uint8Array.of(0x6d, 1),
      Uint8Array.of(0x7b, 1, 8, ...valid.subarray(3)),
      Uint8Array.of(0x6d, 2, 8, ...valid.subarray(3)),
      Uint8Array.of(0x6d, 1, 20, ...valid.subarray(3)),
      Uint8Array.of(0x6d, 1, 3, 0x61, 0x62, 0x63),
      Uint8Array.of(0x6d, 1, 8, ...new TextEncoder().encode("stream/1")),
    ]
    for (const message of broken) assert.throws(() => mediaStreamOf(message), WireError)
    assert.throws(() => encodeMediaMessage("short", Uint8Array.of(1)))
  })

  test("a watch's request crosses the client frames unread", () => {
    const request = Payload.encoded('{"box": {"width": 640,  "height": 400}}')
    const frame = decodeClientFrame(encodeClientFrame({ type: "media-watch", stream: "stream-1", request }))
    assert.equal(frame.type, "media-watch")
    assert.equal(frame.request.text, request.text)
    const gateway = decodeGatewayFrame(encodeGatewayFrame({ type: "media-watch", threadId: "th-1", stream: "stream-1", request }))
    assert.equal(gateway.request.text, request.text)
  })
})

describe("a runtime's media", () => {
  /** A runtime serving media on the fake gateway, running th-1, and a client of it. */
  async function served(options = {}) {
    const gateway = createFakeGateway()
    const calls = []
    const senders = new Map()
    const media = {
      watch: (stream, threadId, request, sender) => {
        calls.push(["watch", stream, threadId, request.decode()])
        senders.set(stream, sender)
      },
      acked: (stream, received) => calls.push(["acked", stream, received]),
      unwatched: (stream) => calls.push(["unwatched", stream]),
    }
    const runtime = await serveRuntime(await gateway.connectRuntime(), {
      runtimeId: "machine",
      build: "test",
      handle: async (operation) => answer(operation, null),
      media: options.noMedia ? undefined : media,
      versions: options.versions,
    })
    await gateway.assign("th-1", "machine")
    while (runtime.generation("th-1") === undefined) await settle()
    return { gateway, runtime, calls, senders, session: await gateway.connectClient(client) }
  }
  const until = async (check) => {
    while (!check()) await settle()
  }

  test("a viewer's watch reaches the handler with its request and a sender whose messages reach the viewer", async () => {
    const { gateway, runtime, calls, senders, session } = await served()
    const watch = session.watch({ threadId: "th-1", stream: "stream-1", request: Payload.of({ width: 640 }) })
    await until(() => calls.length)
    assert.deepEqual(calls, [["watch", "stream-1", "th-1", { width: 640 }]])
    const sender = senders.get("stream-1")
    assert.equal(sender.send(Uint8Array.of(1, 2, 3)), true)
    assert.deepEqual(await watch.next(), { kind: "data", data: Uint8Array.of(1, 2, 3) })
    watch.ack(3)
    watch.update(Payload.of({ width: 1280 }))
    await until(() => calls.length === 3)
    assert.deepEqual(calls.slice(1), [["acked", "stream-1", 3], ["watch", "stream-1", "th-1", { width: 1280 }]])
    assert.equal(senders.get("stream-1"), sender, "the same stream, asked again")
    watch.close()
    await until(() => calls.length === 4)
    assert.deepEqual(calls[3], ["unwatched", "stream-1"])
    assert.equal(sender.send(Uint8Array.of(4)), false, "nothing is sent for a stream nobody watches")
    runtime.close()
    await runtime.done
    await gateway.close()
  })

  test("a runtime ends its stream for the viewer, with its reason, and hears nothing more of it", async () => {
    const { gateway, runtime, calls, senders, session } = await served()
    const watch = session.watch({ threadId: "th-1", stream: "stream-1", request: Payload.of({}) })
    await until(() => senders.has("stream-1"))
    const reason = problem("failed", "The tab closed", "c-1", "not-applied")
    senders.get("stream-1").end(reason)
    assert.deepEqual(await watch.next(), { kind: "ended", problem: reason })
    assert.equal(senders.get("stream-1").send(Uint8Array.of(1)), false)
    runtime.close()
    await runtime.done
    assert.deepEqual(calls.map(([kind]) => kind), ["watch"], "a stream the runtime ended isn't unwatched")
    await gateway.close()
  })

  test("a Thread taken from the runtime, or its link closing, ends its streams for both sides", async () => {
    const { gateway, runtime, calls, senders, session } = await served()
    const taken = session.watch({ threadId: "th-1", stream: "stream-1", request: Payload.of({}) })
    await until(() => senders.has("stream-1"))
    await gateway.assign("th-1", "elsewhere")
    assert.equal((await taken.next()).kind, "ended")
    await until(() => calls.some(([kind]) => kind === "unwatched"))
    assert.equal(senders.get("stream-1").send(Uint8Array.of(1)), false)
    await gateway.assign("th-1", "machine")
    while (runtime.generation("th-1") === undefined) await settle()
    const left = session.watch({ threadId: "th-1", stream: "stream-2", request: Payload.of({}) })
    await until(() => senders.has("stream-2"))
    runtime.close()
    await runtime.done
    assert.deepEqual(calls.at(-1), ["unwatched", "stream-2"])
    assert.equal(problemType((await left.next()).problem), "unavailable")
    await gateway.close()
  })

  test("a runtime without a handler, or that agreed a version before media, never serves a watch", async () => {
    for (const options of [{ noMedia: true }, { versions: { min: 1, max: 2 } }]) {
      const { gateway, runtime, calls, session } = await served(options)
      const watch = session.watch({ threadId: "th-1", stream: "stream-1", request: Payload.of({}) })
      const end = await watch.next()
      assert.equal(end.kind, "ended")
      assert.equal(problemType(end.problem), "unsupported-version")
      assert.deepEqual(calls, [])
      runtime.close()
      await runtime.done
      await gateway.close()
    }
  })
})

describe("a runtime's port requests", () => {
  /** A runtime on a link the test plays the gateway's side of, agreed at `version`, with a port handler that records. */
  async function served(version, options = {}) {
    const link = { ...scriptedLink(), media: [] }
    link.sendMedia = (message) => link.media.push(decodeMediaMessage(message))
    const calls = []
    const senders = new Map()
    const ports = {
      open: (stream, request, sender) => {
        calls.push(["open", stream, request])
        senders.set(stream, sender)
      },
      acked: (stream, received) => calls.push(["acked", stream, received]),
      closed: (stream) => calls.push(["closed", stream]),
    }
    link.push({ ...enrolled, version })
    const runtime = await serveRuntime(link, { runtimeId: "d-laptop", build: "test", handle: async (operation) => answer(operation, null), ports: options.noPorts ? undefined : ports })
    return { link, runtime, calls, senders }
  }
  const request = { to: { kind: "port", port: 3000 }, method: "GET", path: "/assets/app.js?v=2", headers: [["accept", "*/*"]] }

  test("a request reaches the handler, its answer goes back on its stream, paced by the gateway and stopped by it", async () => {
    const { link, runtime, calls, senders } = await served(PORTS_VERSION)
    link.push(decodeGatewayFrame(encodeGatewayFrame({ type: "port-open", stream: "port-req-1", ...request })))
    while (!calls.length) await settle()
    assert.deepEqual(calls, [["open", "port-req-1", request]])
    const sender = senders.get("port-req-1")
    assert.equal(sender.send(encodePortHead({ status: 200, headers: [["content-type", "text/javascript"]] })), true)
    assert.equal(sender.send(Uint8Array.of(1, 2, 3)), true)
    assert.deepEqual(decodePortHead(link.media[0].data), { status: 200, headers: [["content-type", "text/javascript"]] })
    assert.deepEqual([link.media[1].stream, [...link.media[1].data]], ["port-req-1", [1, 2, 3]])
    link.push({ type: "media-ack", stream: "port-req-1", received: 3 })
    link.push({ type: "media-unwatch", stream: "port-req-1" })
    while (calls.length < 3) await settle()
    assert.deepEqual(calls.slice(1), [["acked", "port-req-1", 3], ["closed", "port-req-1"]])
    assert.equal(sender.send(Uint8Array.of(4)), false, "nothing more once the gateway stopped it")
    runtime.close()
    await runtime.done
  })

  test("a runtime with no handler, or on a link before ports, ends the request at once; a body crosses in its frame", async () => {
    for (const [version, options] of [[PORTS_VERSION, { noPorts: true }], [PORTS_VERSION - 1, {}]]) {
      const { link, runtime, calls } = await served(version, options)
      link.push({ type: "port-open", stream: "port-req-1", ...request })
      while (!link.sent.some((frame) => frame.type === "media-end")) await settle()
      assert.equal(problemType(link.sent.find((frame) => frame.type === "media-end").problem), "unsupported-version")
      assert.deepEqual(calls, [])
      runtime.close()
      await runtime.done
    }
    const posted = { ...request, method: "POST", body: Buffer.from("{}").toString("base64") }
    assert.deepEqual(decodeGatewayFrame(encodeGatewayFrame({ type: "port-open", stream: "port-req-2", ...posted })), { type: "port-open", stream: "port-req-2", ...posted })
    assert.throws(() => GatewayFrameEnvelopeSchema.parse({ type: "port-open", stream: "port-req-3", ...request, body: "x".repeat(PORT_BODY_LIMIT * 2) }))
    const files = { to: { kind: "files" }, method: "GET", path: "/file/asset/abc/def/shot.png", headers: [["range", "bytes=0-"]] }
    assert.deepEqual(decodeGatewayFrame(encodeGatewayFrame({ type: "port-open", stream: "port-req-4", ...files })), { type: "port-open", stream: "port-req-4", ...files })
  })
})

describe("client frames", () => {
  test("a call carries its input after the envelope, unread, and decodes to the same operation", () => {
    const input = Payload.encoded('{"text": "hi",\n "n": 1.50}')
    const text = encodeClientFrame({ type: "call", operation: { ...operation, input } })
    const decoded = decodeClientFrame(text)
    assert.equal(decoded.type, "call")
    assert.equal(decoded.operation.input.text, input.text)
    assert.deepEqual({ ...decoded.operation, input: undefined }, { ...operation, input: undefined })
  })
  test("a reply and an event cross with their payloads as their producers wrote them", () => {
    const value = Payload.encoded("not even JSON to the gateway")
    const reply = decodeGatewayClientFrame(encodeGatewayClientFrame({ type: "reply", reply: { v: PROTOCOL_VERSION, id: operation.id, ok: true, value } }))
    assert.equal(reply.reply.value.text, value.text)
    const event = Payload.encoded('{"type":"delta","text":"caf\\u00e9"}')
    const framed = decodeGatewayClientFrame(
      encodeGatewayClientFrame({ type: "event", event: { v: PROTOCOL_VERSION, stream: "thread:th-1", seq: 3, at: new Date(0).toISOString(), event } })
    )
    assert.equal(framed.event.event.text, event.text)
    assert.equal(framed.event.seq, 3)
  })
  test("the heartbeat is fixed text, the same for runtimes and clients, so a gateway can answer it without reading it", () => {
    assert.deepEqual(decodeClientFrame(PING), { type: "ping" })
    assert.deepEqual(decodeGatewayClientFrame(PONG), { type: "pong" })
    assert.equal(encodeRuntimeFrame({ type: "ping" }), PING)
    assert.deepEqual(decodeGatewayFrame(PONG), { type: "pong" })
  })
  test("a runtime's link passes no pong on, and ends at a refusal", async () => {
    const [near, far] = socketPair()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const link = runtimeLinkOverSocket(near)
    far.send(PONG)
    far.send(encodeGatewayFrame({ type: "refused", problem: problem("unauthorized", "No", "c-1", "not-applied") }))
    assert.equal((await link.next()).type, "refused")
    assert.equal(link.closed, true)
  })
  test("a frame that isn't one, or a payload where none goes, is refused", () => {
    assert.throws(() => decodeClientFrame('{"type":"call"}'), WireError)
    assert.throws(() => decodeClientFrame('{"type":"ping"}\nextra'), WireError)
    assert.throws(() => decodeClientFrame(encodeClientFrame({ type: "call", operation: { ...operation, input: Payload.of(1) } }).split("\n")[0]), WireError)
  })
  test("a renewal crosses as frames: a token in, its expiry back, and a closing that says why", () => {
    assert.deepEqual(decodeClientFrame(encodeClientFrame({ type: "renew", token: "t-2" })), { type: "renew", token: "t-2" })
    assert.deepEqual(decodeGatewayClientFrame(encodeGatewayClientFrame({ type: "renewed", expiresAt: 1_800_000_000 })), { type: "renewed", expiresAt: 1_800_000_000 })
    const closing = { type: "closing", problem: problem("unauthorized", "The credential expired", "c-1", "not-applied", { status: 401 }) }
    assert.deepEqual(decodeGatewayClientFrame(encodeGatewayClientFrame(closing)), closing)
    assert.deepEqual(decodeRuntimeFrame(encodeRuntimeFrame({ type: "renew", token: "t-2" })), { type: "renew", token: "t-2" })
    assert.deepEqual(decodeGatewayFrame(encodeGatewayFrame({ type: "renewed", expiresAt: 1_800_000_000 })), { type: "renewed", expiresAt: 1_800_000_000 })
    assert.equal(CLOSE_CODES.credentialExpired, 4001)
    assert.equal(CLOSE_CODES.credentialRevoked, 4003)
  })
  test("a session renews each connection's token in the socket when it's due, and again after each renewal", async () => {
    let far
    const tokens = ["t-2", "t-3"]
    const session = clientSessionOverSockets(
      () => {
        const [near, other] = socketPair()
        far = other
        return near
      },
      { credential: { token: async () => tokens.shift(), renewInMs: () => 0 } }
    )
    const renews = []
    void session.call({ ...operation, input: Payload.of({}) })
    await new Promise((resolve) => setTimeout(resolve, 10))
    far.addEventListener("message", (event) => {
      const frame = decodeClientFrame(event.data)
      if (frame.type !== "renew") return
      renews.push(frame.token)
      far.send(encodeGatewayClientFrame({ type: "renewed", expiresAt: 1_800_000_000 }))
    })
    await new Promise((resolve) => setTimeout(resolve, 2_150))
    assert.deepEqual(renews, ["t-2", "t-3"])
    session.close()
  })
  test("a closing ends the connection at once: what was pending is unknown, and the session hears why", async () => {
    let far
    const heard = []
    const session = clientSessionOverSockets(
      () => {
        const [near, other] = socketPair()
        far = other
        return near
      },
      { onClosing: (endpoint, reason) => heard.push([endpoint.kind, reason.type]) }
    )
    const replied = session.call({ ...operation, input: Payload.of({}) })
    await new Promise((resolve) => setTimeout(resolve, 10))
    far.send(encodeGatewayClientFrame({ type: "closing", problem: problem("forbidden", "This device was removed", "c-1", "not-applied", { status: 403 }) }))
    const reply = await replied
    assert.equal(reply.problem.outcome, "unknown")
    assert.deepEqual(heard, [["thread", "urn:mako:problem:forbidden"]])
  })
  test("a connection that goes silent, as after a sleep on a network the wake didn't keep, ends at the next heartbeat", async () => {
    let far
    const session = clientSessionOverSockets(
      () => {
        const [near, other] = socketPair()
        far = other
        return near
      },
      { heartbeatMs: 40, silentMs: 100 }
    )
    let answering = true
    const pinged = []
    const replied = session.call({ ...operation, input: Payload.of({}) })
    const subscription = session.subscribe({ stream: "thread:th-1", after: 0 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    far.addEventListener("message", (event) => {
      if (event.data !== PING) return
      pinged.push(Date.now())
      if (answering) far.send(PONG)
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(far.readyState, 1, "answered pongs keep it open")
    // The far end stops answering and never closes: a socket the client would otherwise wait on for minutes.
    answering = false
    const silent = Date.now()
    const reply = await replied
    assert.equal(reply.problem.outcome, "unknown", "the call in flight is answered unknown, to be repeated under its id")
    await assert.rejects(subscription.next(), "the subscription ends, for its reader to follow again")
    assert.ok(Date.now() - silent < 250, `ended within a heartbeat of the silence (${Date.now() - silent} ms)`)
    assert.ok(pinged.length >= 4)
  })
  test("waking ends a connection not heard from within a heartbeat at once, and one that doesn't answer a ping soon", async () => {
    let answering = true
    const session = clientSessionOverSockets(
      () => {
        const [near, far] = socketPair()
        far.addEventListener("message", (event) => event.data === PING && answering && far.send(PONG))
        return near
      },
      { heartbeatMs: 25_000, wakeProbeMs: 60 }
    )
    const quiet = session.subscribe({ stream: "thread:th-1", after: 0 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    session.wake()
    const live = await Promise.race([quiet.next(), new Promise((resolve) => setTimeout(() => resolve("open"), 150))])
    assert.equal(live, "open", "it answered the wake's ping: kept")
    // A short sleep on a network the wake didn't keep: heard moments ago, and nothing comes back now.
    answering = false
    session.wake()
    await assert.rejects(quiet.next(), "unanswered, it ends within the probe")
    const again = session.subscribe({ stream: "thread:th-1", after: 0 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const realNow = Date.now
    // The wall clock moves on while the machine sleeps; nothing was heard in that time.
    Date.now = () => realNow() + 10 * 60_000
    try {
      session.wake()
    } finally {
      Date.now = realNow
    }
    await assert.rejects(again.next(), "quiet for the length of the sleep: ended without waiting for a ping")
    session.close()
  })
  test("a call whose connection closes before its reply is answered unavailable, with an unknown outcome", async () => {
    let far
    const session = clientSessionOverSockets(() => {
      const [near, other] = socketPair()
      far = other
      return near
    })
    const replied = session.call({ ...operation, input: Payload.of({}) })
    await new Promise((resolve) => setTimeout(resolve, 0))
    far.close()
    const reply = await replied
    assert.equal(reply.ok, false)
    assert.equal(reply.problem.type, "urn:mako:problem:unavailable")
    assert.equal(reply.problem.outcome, "unknown")
    assert.equal(reply.problem.correlationId, operation.correlationId)
  })
})

describe("records crossing between stores", () => {
  const hash = (byte) => byte.toString(16).padStart(2, "0").repeat(32)
  const version = (seq, chunks, kind = "append") => ({ seq, kind, at: 1, size: 4, digest: null, tail: null, chunks: chunks.join(""), detail: null, writer: null, writerSource: null })
  const bundle = (versions) => RecordBundleSchema.parse({ harness: "codex", nativeId: "s1", layout: { home: "/h", roots: {}, paths: {} }, marks: {}, units: [{ key: "k", role: "file", path: "codex:s1.jsonl", places: null, versions }] })
  const holding = (versions) => () => ({ head: versions.length - 1, version: (seq) => versions[seq] && { kind: versions[seq].kind, chunks: versions[seq].chunks } })

  test("a pack carries each chunk's header and body, and a pack that isn't whole is refused", () => {
    const chunks = [{ hash: hash(1), codec: 1, size: 9, body: new Uint8Array([1, 2, 3]) }, { hash: hash(2), codec: 0, size: 2, body: new Uint8Array([4, 5]) }]
    const pack = encodeChunkPack(chunks)
    assert.equal(pack.length, 2 * CHUNK_HEADER_BYTES + 5)
    assert.deepEqual(decodeChunkPack(pack).map(({ hash, codec, size, body, offset }) => ({ hash, codec, size, body: [...body], offset })), [
      { hash: hash(1), codec: 1, size: 9, body: [1, 2, 3], offset: CHUNK_HEADER_BYTES },
      { hash: hash(2), codec: 0, size: 2, body: [4, 5], offset: 2 * CHUNK_HEADER_BYTES + 3 },
    ])
    assert.throws(() => decodeChunkPack(pack.subarray(0, pack.length - 1)), /runs past its pack/)
    assert.throws(() => decodeChunkPack(new Uint8Array(CHUNK_HEADER_BYTES)), /Not a chunk pack/)
  })

  test("one rule takes a bundle: what's held must match, what's new must follow, and each chunk is named once", () => {
    const held = [version(0, [hash(1)]), version(1, [hash(2)])]
    const arriving = bundle([...held, version(2, [hash(3), hash(1)])])
    const planned = planRecordImport(arriving, holding(held))
    assert.equal(planned.held, 2)
    assert.deepEqual(planned.taking.map(({ version }) => version.seq), [2])
    assert.deepEqual(recordChunks(arriving.units[0].versions), [hash(1), hash(2), hash(3)])
    assert.deepEqual(planRecordImport(arriving, () => undefined).taking.length, 3, "a store that holds nothing takes it all")
    const diverged = bundle([version(0, [hash(1)]), version(1, [hash(9)])])
    assert.throws(() => planRecordImport(diverged, holding(held)), (error) => error instanceof RecordConflictError && error.conflict === "diverged" && error.seq === 1)
    assert.throws(() => planRecordImport(bundle([version(3, [hash(4)])]), holding(held)), (error) => error instanceof RecordConflictError && error.conflict === "gap" && error.head === 1)
    assert.throws(() => planRecordImport(bundle([version(0, [hash(1)], "replace")]), holding(held)), /went on in two places/, "a version held with another kind")
    assert.equal(RecordBundleSchema.safeParse({ ...arriving, units: [{ ...arriving.units[0], versions: [{ ...arriving.units[0].versions[0], chunks: "abc" }] }] }).success, false, "chunks are whole hashes")
  })

  test("a database's schema two stores each captured is kept as each store's own; a session's own records still refuse", () => {
    const held = [version(0, [hash(1)], "replace"), version(1, [hash(2)], "replace")]
    const schema = (versions, rows = []) => RecordBundleSchema.parse({ harness: "opencode", nativeId: "s2", layout: { home: "/h", roots: {}, paths: {} }, marks: {}, units: [
      { key: "opencode.db\tschema", role: "schema", path: null, places: null, versions },
      ...rows,
    ] })
    const row = { key: "opencode.db\trow", role: "row", path: null, places: null, versions: [version(0, [hash(5)], "replace")] }
    // The machine's OpenCode made its database before any session of this one's arrived: its own history of the schema.
    const elsewhere = planRecordImport(schema([version(0, [hash(7)], "replace")], [row]), (key) => (key.endsWith("schema") ? holding(held)() : undefined))
    assert.deepEqual(elsewhere.kept, ["opencode.db\tschema"], "the store keeps its own description of the database")
    assert.deepEqual(elsewhere.taking.map(({ unit }) => unit.key), ["opencode.db\trow"], "the session's rows still come")
    // One that follows on from what's held is taken, as any unit's is.
    const following = planRecordImport(schema([...held, version(2, [hash(3)], "replace")]), holding(held))
    assert.deepEqual([following.kept, following.taking.map(({ version }) => version.seq)], [[], [2]])
    // A store that holds none takes it whole.
    assert.equal(planRecordImport(schema([version(0, [hash(7)], "replace")]), () => undefined).taking.length, 1)
    // A harness says which rows describe its store (its migration list): those are kept the same way; without it, refused.
    const migration = { key: "opencode.db\trow\tmigration\t{}", role: "row", path: null, places: null, versions: [version(0, [hash(8)], "replace")] }
    const heldMigration = (key) => (key.endsWith("{}") ? holding([version(0, [hash(9)], "replace")])() : undefined)
    const describes = (unit) => unit.role === "schema" || unit.key.includes("\trow\tmigration\t")
    assert.deepEqual(planRecordImport(schema([], [migration]), heldMigration, describes).kept, [migration.key])
    assert.throws(() => planRecordImport(schema([], [migration]), heldMigration), /went on in two places/, "by default only a schema is the store's")
    // A session's own rows that went on in two places are refused, as ever.
    assert.throws(() => planRecordImport(schema([], [row]), (key) => (key.endsWith("row") ? holding([version(0, [hash(6)], "replace")])() : undefined)), /went on in two places/)
  })
})

describe("a call to a gateway over HTTP", () => {
  test("every try carries the call's one correlation ID, and its trace says it was sent again and what ended each try", async () => {
    const sent = []
    const answers = [
      () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) }) },
      () => new Response("{}", { status: 503 }),
      () => new Response(JSON.stringify({ ok: true, versions: 1, held: 0, through: 1 }), { status: 200 }),
    ]
    const fetch = async (_url, init) => {
      sent.push(init.headers.get(CORRELATION_HEADER))
      return answers.shift()()
    }
    const trace = { tries: 0, failures: [] }
    const remote = recordsOverHttp({ id: "t", base: "https://gw/v1/threads/t-1/records", authorization: () => "Bearer t", fetch, backoff: [1, 1] })
    assert.equal((await remote.pushWith({ harness: "claude", nativeId: "s", units: [] }, [], trace)).ok, true)
    assert.equal(sent.length, 3)
    assert.ok(sent.every((id) => id === trace.correlationId), "the gateway logs every try under the one ID")
    assert.equal(trace.tries, 3)
    assert.equal(trace.failures.length, 2)
    assert.match(trace.failures[0], /^ECONNRESET after \d+ ms$/)
    assert.match(trace.failures[1], /^503 after \d+ ms$/)
  })

  test("a busy gateway's Retry-After is waited out before the call goes again, never past the most", async () => {
    const answers = [
      () => new Response(JSON.stringify({ title: "Busy: try again in a few seconds" }), { status: 429, headers: { "retry-after": "0.3" } }),
      () => new Response("{}", { status: 503, headers: { "retry-after": "nonsense" } }),
      () => new Response(JSON.stringify({ missing: [] }), { status: 200 }),
    ]
    const at = []
    const fetch = async () => {
      at.push(performance.now())
      return answers.shift()()
    }
    const trace = { tries: 0, failures: [] }
    const remote = recordsOverHttp({ id: "t", base: "https://gw/v1/devices/d/originals", authorization: () => "Bearer t", fetch, backoff: [1, 1] })
    assert.deepEqual(await remote.missing(["a".repeat(64)], trace), [])
    assert.equal(trace.tries, 3)
    assert.ok(at[1] - at[0] >= 290, `waited ${Math.round(at[1] - at[0])} ms of the 300 the gateway asked`)
    assert.ok(at[2] - at[1] < 250, "one it can't read is the client's own backoff")
    assert.equal(retryAfterMs("2"), 2_000)
    assert.equal(retryAfterMs(new Date(Date.now() + 5_000).toUTCString()) > 3_000, true)
    assert.equal(retryAfterMs("3600"), RETRY_AFTER_MOST_MS)
    assert.equal(retryAfterMs(null), 0)
  })

  test("a refusal names the call's own correlation ID when the gateway's answer names none", async () => {
    let sent
    const fetch = async (_url, init) => {
      sent = init.headers.get(CORRELATION_HEADER)
      return new Response(JSON.stringify({ title: "No such Thread" }), { status: 404 })
    }
    const call = gatewayCalls({ id: "t", base: "https://gw", authorization: () => "t", fetch })
    await assert.rejects(call("/sessions"), (error) => error instanceof GatewayHttpError && error.call?.correlationId === sent && error.described.includes(`correlation ${sent}`))
  })
})

describe("a project's recipe authority over HTTP", () => {
  const record = (version, extra = {}) => ({ version, state: "draft", savedAt: 1, recipe: { values: { A: "1" } }, ...extra })
  const served = (answers) => {
    const asked = []
    const fetch = async (url, init) => {
      asked.push({ url: String(url), method: init.method, authorization: init.headers.get("authorization"), body: init.body ? JSON.parse(init.body) : undefined })
      const [status, body] = answers.shift()
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    }
    return { asked, fetch }
  }

  test("a device's names its repository on every route; a machine's names none; answers are read by their schemas", async () => {
    const device = served([[200, { change: 3, published: 1, versions: [record(1, { state: "published" })], more: false }], [200, record(2, { parent: 1 })], [200, { ok: false, published: record(3, { state: "published" }), reason: "Version 3 was published after this draft was made from version 1." }]])
    const authority = recipesOverHttp({ id: "a", base: "https://gw/v1/recipes", authorization: () => "Bearer t", fetch: device.fetch, repository: "https://github.com/acme/app" })
    assert.equal((await authority.changes(0)).published, 1)
    const save = { id: crypto.randomUUID(), parent: 1, savedAt: 2, recipe: { values: { A: "2" } } }
    assert.equal((await authority.save(save)).version, 2)
    const refused = await authority.publish({ version: 2, proof: { at: 3, on: "this Mac", place: "local", checkout: "/p", steps: [] }, publishedAt: 3 })
    assert.equal(refused.ok, false)
    assert.equal(refused.ok === false && refused.published?.version, 3)
    assert.deepEqual(device.asked.map((call) => [call.method, call.url]), [
      ["GET", "https://gw/v1/recipes/changes?after=0&repository=https%3A%2F%2Fgithub.com%2Facme%2Fapp"],
      ["POST", "https://gw/v1/recipes/save?repository=https%3A%2F%2Fgithub.com%2Facme%2Fapp"],
      ["POST", "https://gw/v1/recipes/publish?repository=https%3A%2F%2Fgithub.com%2Facme%2Fapp"],
    ])
    assert.deepEqual(device.asked[1].body, save, "the save carries its own id, so a repeat makes no second version")
    assert.ok(device.asked.every((call) => call.authorization === "Bearer t"))

    const machine = served([[200, { change: 0, published: null, versions: [], more: false }]])
    await recipesOverHttp({ id: "m", base: "https://gw/v1/machines/m1/recipes", authorization: () => "Bearer m", fetch: machine.fetch }).changes(0)
    assert.equal(machine.asked[0].url, "https://gw/v1/machines/m1/recipes/changes?after=0")
  })

  test("a busy gateway is asked again; a refusal is thrown with its title, once", async () => {
    const busy = served([[503, {}], [200, record(4)]])
    const authority = recipesOverHttp({ id: "a", base: "https://gw", authorization: () => "t", fetch: busy.fetch, backoff: [1, 1] })
    assert.equal((await authority.prove({ version: 4, proof: { at: 1, on: "a cloud machine", place: "cloud", checkout: "/w", steps: [] } })).version, 4)
    assert.equal(busy.asked.length, 2)
    const refusing = served([[409, { title: "Version 9 isn't a published version of this project's recipe" }]])
    await assert.rejects(recipesOverHttp({ id: "a", base: "https://gw", authorization: () => "t", fetch: refusing.fetch, backoff: [1] }).save({ id: crypto.randomUUID(), parent: 9, savedAt: 1, recipe: {} }), (error) => error instanceof GatewayHttpError && error.status === 409 && /isn't a published version/.test(error.message))
    assert.equal(refusing.asked.length, 1)
  })

  test("a recipe fits while its JSON is within the wire's bound", () => {
    assert.ok(recipeFits(JSON.stringify({ values: { A: "x".repeat(RECIPE_WIRE_BYTES - 100) } })))
    assert.ok(!recipeFits(JSON.stringify({ values: { A: "x".repeat(RECIPE_WIRE_BYTES) } })))
  })
})

describe("a Thread moving between a device and the cloud", () => {
  const sha = (char) => char.repeat(40)
  const checkpoint = { version: 1, sha256: "a".repeat(64), bytes: 1_000, head: sha("1"), branch: "mako/fix", index: sha("2"), work: sha("3") }

  test("a checkpoint names its bundle and its three commits, within the limit", () => {
    assert.deepEqual(MoveCheckpointSchema.parse(checkpoint), checkpoint)
    assert.ok(MoveCheckpointSchema.safeParse({ ...checkpoint, branch: undefined }).success, "a detached HEAD has no branch")
    assert.ok(!MoveCheckpointSchema.safeParse({ ...checkpoint, bytes: MOVE_CHECKPOINT_MAX_BYTES + 1 }).success)
    assert.ok(!MoveCheckpointSchema.safeParse({ ...checkpoint, sha256: "A".repeat(64) }).success)
    assert.ok(!MoveCheckpointSchema.safeParse({ ...checkpoint, extra: true }).success, "nothing else rides along")
  })

  test("a claim carries the Sessions released, and the answer is a claim or a refusal", () => {
    const session = { id: crypto.randomUUID(), generation: 3 }
    assert.ok(MoveClaimRequestSchema.safeParse({ thread: crypto.randomUUID(), sessions: [session], handoff: { any: ["json"] } }).success)
    assert.ok(!MoveClaimRequestSchema.safeParse({ thread: crypto.randomUUID(), sessions: [], handoff: {} }).success, "a move carries a Session")
    assert.ok(!MoveClaimRequestSchema.safeParse({ thread: crypto.randomUUID(), sessions: [{ ...session, generation: 0 }], handoff: {} }).success)
    const move = crypto.randomUUID()
    assert.equal(MoveAnswerSchema.parse({ kind: "claimed", move, at: 1, sessions: [{ ...session, generation: 4 }] }).kind, "claimed")
    assert.equal(MoveAnswerSchema.parse({ kind: "refused", move, at: 1, reason: "the checkout didn't arrive" }).kind, "refused")
  })

  test("a return to the archive says so and who asked, and only an archive is archived", () => {
    const move = crypto.randomUUID()
    const by = crypto.randomUUID()
    const departure = { checkpoint, sessions: [{ harness: "claude", nativeId: "n-1", holdings: { "a.jsonl": 3 } }] }
    assert.deepEqual(ReturnBeginRequestSchema.parse({}), {}, "to its device, as before")
    assert.deepEqual(ReturnBeginRequestSchema.parse({ to: "archive" }), { to: "archive" })
    assert.ok(!ReturnBeginRequestSchema.safeParse({ to: "elsewhere" }).success)
    assert.equal(ReturnStateSchema.parse({ phase: "returning", move, at: 1, to: "archive", by }).to, "archive")
    assert.equal(ReturnStateSchema.parse({ phase: "returning", move, at: 1 }).to, undefined, "a record from before archiving reads as it was")
    assert.equal(ReturnStateSchema.parse({ phase: "archived", move, at: 2, departure, to: "archive", by }).phase, "archived")
    assert.ok(!ReturnStateSchema.safeParse({ phase: "archived", move, at: 2, departure }).success, "an archived record is an archive's")
    assert.ok(ReturnStateSchema.safeParse({ phase: "archived", move, at: 2, to: "archive" }).success, "archived with nothing packed: its machine ran nothing, or couldn't start")
    assert.equal(ReturnStateSchema.parse({ phase: "returned", move, at: 3, departure, to: "archive", by }).phase, "returned", "taken back from the archive, it ends as any return does")
  })
})

describe("an account's list of Threads, one row per Session", () => {
  const session = { session: "0b8f3e1a-7c2d-4f6a-9e5b-1d3c8a7f2e60", thread: "6f1c9a52-0d4e-4b8e-9a51-3f2c7d1e8b40", threadTitle: "Webhooks", conversation: "c-1", harness: "claude", title: "Retry the webhooks", state: "waiting", waitingOn: "Approve: npm test", folder: "/Users/ana/api", createdAt: "2026-10-24T20:00:00.000Z", activityAt: "2026-10-24T20:05:00.000Z", generation: 1 }
  const mac = { kind: "device", deviceId: "9c1f4a2e-5b6d-4e8f-a1b2-c3d4e5f60718" }
  const cloud = { kind: "cloud", threadId: "t-0123456789abcdef" }
  const listed = { ...session, runsOn: mac, listedAt: "2026-10-24T20:05:01.000Z" }

  test("a row holds what a list shows and says where it runs; a report holds nothing else, and a list read passes over what a newer build adds", () => {
    assert.deepEqual(ListedSessionSchema.parse(listed), listed)
    assert.throws(() => ReportedSessionSchema.parse({ ...session, transcript: "…" }), "a report holds no field it doesn't define")
    assert.deepEqual(ListedSessionSchema.parse({ ...listed, transcript: "…" }), listed, "a list read drops it and lists the rest")
    const terminal = { ...session, nativeId: "0b7e", capture: { path: "/Users/ana/.claude/projects/-Users-ana-api/0b7e.jsonl" } }
    assert.deepEqual(ReportedSessionSchema.parse(terminal), terminal, "a session Mako hasn't opened, with how its owner opens it")
    assert.throws(() => ReportedSessionSchema.parse({ ...terminal, capture: { path: "" } }))
    assert.deepEqual(rowsForLink([session, terminal], 5), [session], "a link older than 6 hears neither")
    assert.deepEqual(rowsForLink([session, terminal], 6), [session, terminal])
    const asking = { ...session, waitingFor: "approval" }
    assert.deepEqual(ReportedSessionSchema.parse(asking), asking)
    assert.throws(() => ReportedSessionSchema.parse({ ...session, waitingFor: "a nudge" }), "what a Session waits on is one of three")
    assert.equal(rowsForLink([asking], WAITING_FOR_VERSION)[0].waitingFor, "approval")
    assert.equal(rowsForLink([asking], WAITING_FOR_VERSION - 1)[0].waitingFor, undefined, "a gateway before 10 refuses it, so it goes without")
    assert.equal(rowsForLink([asking], WAITING_FOR_VERSION - 1)[0].waitingOn, "Approve: npm test", "and reads the words it always did")
    const going = { ...session, state: "working", move: { to: "cloud", step: "packing", since: "2026-10-24T20:06:00.000Z" } }
    assert.deepEqual(ReportedSessionSchema.parse(going), going, "a Thread on its way says where to and how far, from its first step")
    assert.throws(() => ReportedSessionSchema.parse({ ...going, move: { ...going.move, to: "phone" } }), "a move goes to a device or the cloud")
    assert.throws(() => ReportedSessionSchema.parse({ ...going, move: { ...going.move, step: "Packing it up" } }), "a step is the owner's word, not a sentence")
    assert.deepEqual(rowsForLink([going], MOVES_VERSION)[0].move, going.move)
    assert.equal(rowsForLink([going], MOVES_VERSION - 1)[0].move, undefined, "a gateway before 11 refuses it, so it goes without")
    assert.equal(rowsForLink([going], MOVES_VERSION - 1)[0].waitingFor, undefined)
    assert.equal(rowsForLink([{ ...going, ...asking, move: going.move }], WAITING_FOR_VERSION)[0].waitingFor, "approval", "and at 10 keeps what 10 knows")
    const listedGoing = { ...going, runsOn: mac, listedAt: listed.listedAt }
    assert.equal(sameListed(listedGoing, { ...listedGoing, move: { ...going.move, step: "handing-over" } }), false, "a move's next step is news")
    assert.equal(sameListed(listedGoing, { ...listedGoing, move: { ...going.move, since: "2026-10-24T20:07:00.000Z" } }), true, "its clock alone isn't")
    const railed = { ...session, state: "working", project: { folder: "/Users/ana/api", head: { kind: "rebasing", name: "pricing-table" } }, worktree: { branch: "mako/retry-webhooks" }, lineage: ["devin", "codex"], background: 25 }
    assert.deepEqual(ReportedSessionSchema.parse(railed), railed, "a row says what its owner's rail shows: its project and its checkout, its worktree, its earlier agents, its background work")
    assert.deepEqual(ReportedSessionSchema.parse({ ...railed, project: { folder: "/Users/ana/api", head: { kind: "detached", commit: "4f2a9c1" } } }).project.head, { kind: "detached", commit: "4f2a9c1" })
    assert.throws(() => ReportedSessionSchema.parse({ ...railed, project: { folder: "/Users/ana/api", head: { kind: "merging", name: "main" } } }), "a head is a branch, a rebase or a commit")
    assert.throws(() => ReportedSessionSchema.parse({ ...railed, lineage: [] }), "no earlier agents is no lineage at all")
    assert.throws(() => ReportedSessionSchema.parse({ ...railed, background: 0 }), "no background work is no count at all")
    assert.deepEqual(rowsForLink([railed], RAIL_VERSION), [railed])
    const older = rowsForLink([railed], RAIL_VERSION - 1)[0]
    assert.deepEqual([older.project, older.worktree, older.lineage, older.background], [undefined, undefined, undefined, undefined], "a gateway before 12 refuses them, so they go without")
    assert.equal(older.state, "working", "and the row still reads as at work")
    assert.deepEqual(rowsForLink([{ ...railed, move: going.move }], MOVES_VERSION)[0].move, going.move, "at 11 it keeps what 11 knows")
    const listedRailed = { ...railed, runsOn: mac, listedAt: listed.listedAt }
    assert.equal(sameListed(listedRailed, { ...listedRailed }), true)
    assert.equal(sameListed(listedRailed, { ...listedRailed, project: { folder: "/Users/ana/api", head: { kind: "branch", name: "pricing-table" } } }), false, "a rebase that finished is news")
    assert.equal(sameListed(listedRailed, { ...listedRailed, background: 24 }), false, "so is a background task that settled")
    assert.equal(sameListed(listedRailed, { ...listedRailed, lineage: ["codex"] }), false)
    assert.equal(sameListed(listedGoing, { ...listedGoing, move: undefined }), false, "nor is its end")
    assert.throws(() => ListedSessionSchema.parse({ ...listed, state: "thinking" }), "a state is one of five")
    assert.throws(() => ListedSessionSchema.parse({ ...listed, title: "x".repeat(201) }), "a title is a row's, not a message's")
    assert.throws(() => SessionsReportSchema.parse({ listed: Array.from({ length: 201 }, () => session), gone: [] }), "at most 200 rows a report")
    assert.deepEqual(SessionListingsSchema.parse({ sessions: [listed], seq: 12 }), { sessions: [listed], seq: 12 })
  })

  test("a message waiting for a Session's owner: what a device sends, what the account keeps, said whole on the stream", () => {
    const input = { conversation: "c-1", text: "Run the tests again" }
    assert.deepEqual(WaitingInputSchema.parse(input), input)
    assert.throws(() => WaitingInputSchema.parse({ ...input, attachments: [] }), "text only: a file stays where it was sent from")
    assert.throws(() => WaitingInputSchema.parse({ ...input, text: "" }))
    const kept = { ...input, id: "0f8e2b6a-4c1d-4e7a-9b3c-5d2e1f0a9b8c", session: session.session, from: mac.deviceId, at: "2026-10-25T09:00:00.000Z" }
    assert.deepEqual(WaitingMessageSchema.parse({ ...kept, later: true }), kept, "read leniently")
    assert.equal(sameWaiting(input, { ...input }), true)
    assert.equal(sameWaiting(input, { ...input, text: "Run them once" }), false, "the same ID with other words is another message")
    assert.deepEqual(AccountEventSchema.parse({ type: "messages-waiting", session: session.session, messages: [kept] }).type, "messages-waiting")
    assert.deepEqual(AccountEventSchema.parse({ type: "messages-waiting", session: session.session, messages: [] }).messages, [], "none waiting: each was taken, or taken back")
    assert.deepEqual(SessionListingsSchema.parse({ sessions: [], seq: 3, waiting: [kept] }).waiting, [kept])
  })

  test("the one-owner rule: a higher generation replaces a row, the same one only from the same owner, a lower one never", () => {
    assert.equal(mayReplace(undefined, { generation: 1, runsOn: mac }), true)
    assert.equal(mayReplace(listed, { generation: 1, runsOn: mac }), true, "its owner, again")
    assert.equal(mayReplace(listed, { generation: 1, runsOn: cloud }), false, "another owner at the same generation: refused")
    assert.equal(mayReplace(listed, { generation: 3, runsOn: cloud }), true, "moved: claimed where it went")
    assert.equal(mayReplace({ ...listed, generation: 3, runsOn: cloud }, { generation: 1, runsOn: mac }), false, "the old owner's late word")
  })

  test("two rows are the same when a list would show them alike; when they were heard isn't compared", () => {
    assert.equal(sameListed(listed, { ...listed, listedAt: "2026-10-25T00:00:00.000Z" }), true)
    assert.equal(sameListed(listed, { ...listed, state: "idle", waitingOn: undefined }), false)
    assert.equal(sameListed(listed, { ...listed, runsOn: cloud }), false)
    assert.equal(sameListed(undefined, listed), false)
  })

  test("the account's stream says Sessions listed, each whole, and Sessions unlisted, by ID", () => {
    assert.deepEqual(AccountEventSchema.parse({ type: "sessions-listed", sessions: [listed] }), { type: "sessions-listed", sessions: [listed] })
    assert.deepEqual(AccountEventSchema.parse({ type: "sessions-unlisted", sessions: [session.session] }), { type: "sessions-unlisted", sessions: [session.session] })
    assert.equal(AccountEventSchema.safeParse({ type: "sessions-unlisted", sessions: [] }).success, false, "an event says something")
  })

  test("a quiet device is said once, not on each of its rows: on the list read, then each change on the stream", () => {
    const quiet = { deviceId: mac.deviceId, since: "2026-10-27T08:00:00.000Z" }
    assert.deepEqual(SessionListingsSchema.parse({ sessions: [listed], seq: 4, quiet: [quiet] }).quiet, [quiet])
    assert.equal(SessionListingsSchema.parse({ sessions: [], seq: 4 }).quiet, undefined, "a gateway that says none")
    assert.deepEqual(AccountEventSchema.parse({ type: "device-quiet", ...quiet }), { type: "device-quiet", ...quiet })
    assert.deepEqual(AccountEventSchema.parse({ type: "device-quiet", deviceId: mac.deviceId, since: null }).since, null, "heard from again")
    assert.equal(AccountEventSchema.safeParse({ type: "device-quiet", deviceId: mac.deviceId }).success, false, "quiet since when, or back, always said")
    assert.equal(AccountEventSchema.safeParse({ type: "device-quiet", deviceId: "laptop", since: null }).success, false)
  })

  test("an archived cloud Thread keeps its Sessions as they were listed; the list and the stream say it, and its taking back", () => {
    const archived = { thread: cloud.threadId, move: "5b1e7c3a-9d2f-4a6b-8c1d-2e3f4a5b6c7d", archivedAt: "2026-10-27T10:00:00.000Z", by: mac.deviceId, sessions: [{ ...listed, runsOn: cloud }] }
    assert.deepEqual(ArchivedThreadSchema.parse({ ...archived, later: true }), archived, "read leniently")
    assert.ok(!ArchivedThreadSchema.safeParse({ ...archived, thread: "not a thread id!" }).success)
    assert.deepEqual(SessionListingsSchema.parse({ sessions: [], seq: 4, archived: [archived] }).archived, [archived])
    assert.equal(SessionListingsSchema.parse({ sessions: [], seq: 4 }).archived, undefined, "a gateway from before archiving says none")
    assert.deepEqual(AccountEventSchema.parse({ type: "thread-archived", thread: archived }), { type: "thread-archived", thread: archived })
    assert.deepEqual(AccountEventSchema.parse({ type: "thread-unarchived", thread: cloud.threadId }), { type: "thread-unarchived", thread: cloud.threadId })
  })
})

describe("what tells the person a Session needs them, the same on every surface", () => {
  const at = "2026-10-28T18:00:00.000Z"
  const row = (state, fields = {}) => ({ state, generation: 1, activityAt: at, ...fields })

  test("five kinds; three of them ask the person, and are withdrawn once answered", () => {
    assert.deepEqual(AttentionKindSchema.options, ["needs-you", "question", "approval", "failed", "finished"])
    assert.deepEqual(AttentionKindSchema.options.filter(asks), ["needs-you", "question", "approval"])
  })

  test("a row's change says one fact, by one rule, under one key", () => {
    assert.equal(attentionFact(row("working"), row("waiting", { waitingFor: "approval", waitingOn: "Approve: npm test" }))?.kind, "approval")
    assert.equal(attentionFact(row("working"), row("waiting", { waitingFor: "question", waitingOn: "A question: which branch?" }))?.kind, "question")
    assert.equal(attentionFact(row("working"), row("waiting", { waitingFor: "needs-you" }))?.kind, "needs-you")
    assert.equal(attentionFact(row("working"), row("failed"))?.kind, "failed")
    assert.equal(attentionFact(row("working"), row("idle"))?.kind, "finished")
    assert.equal(attentionFact(row("waiting", { waitingFor: "approval", waitingOn: "Approve: a" }), row("idle"))?.kind, "finished", "an approval refused that ends the turn")
    assert.equal(attentionFact(row("waiting", { waitingFor: "approval", waitingOn: "Approve: a" }), row("waiting", { waitingFor: "approval", waitingOn: "Approve: b" }))?.kind, "approval", "a second approval in one turn is a new fact")
    assert.equal(attentionFact(row("waiting", { waitingFor: "approval", waitingOn: "Approve: a" }), row("waiting", { waitingFor: "approval", waitingOn: "Approve: a", activityAt: "2026-10-28T18:01:00.000Z" })), undefined, "the same ask moving on the clock is no new fact")
    assert.equal(attentionFact(undefined, row("idle")), undefined, "a Session first heard at rest says nothing")
    assert.equal(attentionFact(row("idle"), row("idle")), undefined)
    assert.equal(attentionFact(row("failed"), row("failed")), undefined)
    assert.equal(attentionFact(row("working"), row("moving")), undefined, "a move isn't the person's to hear")
    const waiting = row("waiting", { waitingFor: "approval", waitingOn: "Approve: npm test" })
    const asked = attentionFact(row("working"), waiting)
    assert.deepEqual(asked, { kind: "approval", key: attentionKey(waiting), generation: 1, waitingOn: "Approve: npm test" })
    assert.equal(factStands(asked, waiting), true)
    assert.equal(factStands(asked, { ...waiting, activityAt: "2026-10-28T18:02:00.000Z" }), true, "still waiting on the same thing")
    assert.equal(factStands(asked, row("working")), false, "answered: the notice goes from every device")
    assert.equal(factStands(asked, row("waiting", { waitingFor: "approval", waitingOn: "Approve: rm" })), false, "a new ask is its own notice")
    assert.equal(factStands(asked, { ...waiting, generation: 2 }), false, "another owner's word")
    assert.equal(factStands(asked, undefined), false, "a Session off the list says nothing")
    const done = attentionFact(row("working"), row("idle"))
    assert.equal(factStands(done, row("idle", { activityAt: "2026-10-28T18:03:00.000Z" })), true)
    assert.equal(factStands(done, row("working")), false, "the person replied: what it said is retired, as on the desktop")
  })

  test("a push says a notice, or takes notices back; anything else is not ours", () => {
    const base = "/app/"
    const notice = { type: "notice", kind: "approval", title: "Webhooks", body: "Approve: npm test", tag: noticeTag("t1"), url: "/app/t/t1", at: 1 }
    assert.deepEqual(readNotice(JSON.stringify(notice), base), notice)
    const { type: _type, ...older } = notice
    assert.deepEqual(readNotice(JSON.stringify(older), base), notice, "a payload from before `type` is a notice")
    assert.deepEqual(readNotice(JSON.stringify({ type: "withdraw", tags: [noticeTag("t1")], at: 2 }), base), { type: "withdraw", tags: ["thread:t1"], at: 2 })
    assert.equal(readNotice(JSON.stringify({ ...notice, url: "https://elsewhere.example/" }), base), undefined, "a tap only opens the app")
    assert.equal(readNotice(JSON.stringify({ ...notice, kind: "nudge" }), base), undefined)
    assert.equal(readNotice("{", base), undefined)
    assert.equal(readNotice(undefined, base), undefined)
  })

  test("an owner from before waitingFor is read from its words, once, here", () => {
    assert.equal(rowWaitingFor({ waitingOn: "Approve: npm test" }), "approval")
    assert.equal(rowWaitingFor({ waitingOn: "A question: which branch?" }), "question")
    assert.equal(rowWaitingFor({ waitingOn: "Input needed" }), "needs-you")
    assert.equal(rowWaitingFor({ waitingOn: "Approve: x", waitingFor: "question" }), "question", "the owner's word wins")
  })

  test("what a request says: a question is a question, even inside an approval; anything else is an approval", () => {
    assert.deepEqual(requestWaiting({ title: "Bash", questions: [{ question: "Which branch?" }] }), { for: "question", line: "A question: Which branch?" })
    assert.deepEqual(requestWaiting({ title: "/bin/zsh -lc 'npm test'" }, () => "npm test"), { for: "approval", line: "Approve: npm test" })
    assert.deepEqual(questionWaiting("Ship it?"), { for: "question", line: "A question: Ship it?" })
    assert.deepEqual(needsYouWaiting(undefined), { for: "needs-you", line: "Waiting for you" })
    assert.equal(requestWaiting({ title: "x".repeat(400) }).line.length, 200, "a line is a line")
  })

  test("one wording: the headline, the line, a summary, and a body for a platform with no subtitle", () => {
    assert.equal(attentionHeadline("approval", "Codex"), "Codex needs your approval")
    assert.equal(attentionHeadline("finished"), "Finished")
    assert.equal(attentionLine("failed"), ATTENTION_WORDS.failed.line)
    assert.equal(attentionLine("finished", "  Done.  "), "Done.")
    assert.deepEqual(attentionSummary([{ kind: "finished", title: "A" }, { kind: "finished", title: "B" }, { kind: "finished", title: "C" }]), { title: "3 Threads finished", body: "A, B, C" })
    assert.deepEqual(attentionSummary(["A", "B", "C", "D", "E"].map((title, index) => ({ kind: index ? "finished" : "question", title }))), { title: "5 Threads need you", body: "A, B, C, D and 1 more" })
    assert.equal(ATTENTION_SUMMARY_FROM, 3)
    assert.equal(foldedBody({ subtitle: "Codex finished", body: "Done." }), "Codex finished\nDone.")
    assert.equal(foldedBody({ body: "Done." }), "Done.")
  })

  test("the person's access choices: one per harness, made or filled, said whole on the stream at a revision", () => {
    const kept = { claude: { mode: "bypassPermissions", access: "full" } }
    assert.deepEqual(applyAccessChoosing(kept, { choices: { codex: { mode: "access:full", access: "full" } } }), { ...kept, codex: { mode: "access:full", access: "full" } })
    assert.deepEqual(applyAccessChoosing(kept, { choices: { claude: { mode: "default" } } }).claude, { mode: "default" }, "a choice replaces the one before")
    assert.deepEqual(applyAccessChoosing(kept, { choices: { claude: { mode: "default" }, grok: { mode: "access:ask" } }, fill: true }), { ...kept, grok: { mode: "access:ask" } }, "filling takes only where none is made")
    assert.ok(sameAccessChoices(kept, { claude: { mode: "bypassPermissions", access: "full" } }))
    assert.ok(!sameAccessChoices(kept, { claude: { mode: "bypassPermissions" } }))
    assert.throws(() => AccessChoosingSchema.parse({ choices: { Claude: { mode: "x" } } }), "a harness is named by its ID")
    assert.throws(() => AccessChoosingSchema.parse({ choices: { claude: { mode: "" } } }))
    assert.throws(() => AccessChoicesAnswerSchema.parse({ choices: Object.fromEntries(Array.from({ length: 33 }, (_, n) => [`h${n}`, { mode: "x" }])), revision: 1 }))
    const event = { type: "access-chosen", choices: kept, revision: 3 }
    assert.deepEqual(AccountEventSchema.parse(event), event)
  })
})

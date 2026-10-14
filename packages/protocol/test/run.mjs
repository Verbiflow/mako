import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { runGatewayConformance } from "../dist/conformance.js"
import { createFakeGateway } from "../dist/fake-gateway.js"
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
  gatewayOverSockets,
  GatewayFrameEnvelopeSchema,
  OperationEnvelopeSchema,
  PROBLEM_DETAIL_LIMIT,
  PROTOCOL_VERSION,
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
  renewal,
  runtimeLinkOverSocket,
  serveRuntime,
  subprotocols,
  Inbox,
  RuntimeThreads,
  threadStream,
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
        versions: { min: PROTOCOL_VERSION + 1, max: PROTOCOL_VERSION + 1 },
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
      far.addEventListener("message", (event) => link.sendUnchecked(event.data))
      far.addEventListener("close", () => link.close())
      void (async () => {
        for await (const frame of link.frames()) if (far.readyState === 1) far.send(encodeGatewayFrame(frame))
        if (far.readyState === 1) far.close()
      })()
      return near
    },
    async client(actor) {
      const [near, far] = socketPair()
      const session = await gateway.connectClient(actor)
      const subscriptions = new Map()
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

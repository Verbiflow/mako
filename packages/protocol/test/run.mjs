import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { runGatewayConformance } from "../dist/conformance.js"
import { createFakeGateway } from "../dist/fake-gateway.js"
import {
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
  problem,
  serveRuntime,
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
      RuntimeFrameEnvelopeSchema.safeParse({ type: "heartbeat" }).success,
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
      GatewayFrameEnvelopeSchema.safeParse({ type: "heartbeat" }).success,
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
      { type: "heartbeat" },
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
    const heartbeat = `${JSON.stringify({ type: "heartbeat" })}\n{}`
    const bare = JSON.stringify({ type: "event", threadId: "th-1", generation: 1, localSeq: 1 })
    const failure = `${encodeReply({
      v: PROTOCOL_VERSION,
      id: operation.id,
      ok: false,
      problem: problem("failed", "It failed", "c-1", "unknown"),
    })}\n"value"`
    const { input: _, ...envelope } = withInput
    for (const [decode, text] of [
      [decodeRuntimeFrame, heartbeat],
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

  test("sends heartbeats at the pace the gateway asked for, and stops once closed", async () => {
    const gateway = createFakeGateway({ heartbeatMs: 5 })
    const link = await gateway.connectRuntime()
    let beats = 0
    const counted = {
      ...link,
      send: (frame) => {
        if (frame.type === "heartbeat") beats++
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

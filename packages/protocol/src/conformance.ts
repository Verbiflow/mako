import assert from "node:assert/strict"
import {
  type Actor,
  type Operation,
  type Reply,
  problem,
  problemType,
} from "./envelope.js"
import { type EventFrame, threadStream } from "./events.js"
import type { GatewayUnderTest, RuntimeLink } from "./gateway.js"
import type { GatewayFrame } from "./runtime-frames.js"
import { PROTOCOL_VERSION } from "./version.js"

/** `test` from `node:test`, or any runner's equivalent. */
export type ConformanceTest = (
  name: string,
  body: () => Promise<void>
) => void | Promise<void>

const desktop: Actor = {
  kind: "client",
  client: "desktop",
  deviceId: "conformance-desktop",
}
const phone: Actor = {
  kind: "client",
  client: "phone",
  deviceId: "conformance-phone",
}

/**
 * The behaviour every gateway owes runtimes and clients. Each case gets a fresh gateway from
 * `makeGateway` and closes it afterwards, so cases don't share state.
 */
export function runGatewayConformance(
  makeGateway: () => Promise<GatewayUnderTest>,
  test: ConformanceTest,
  options: { deadlineMs?: number } = {}
): void {
  const deadlineMs = options.deadlineMs ?? 5_000
  const scenario = (
    name: string,
    body: (gateway: GatewayUnderTest) => Promise<void>
  ) =>
    test(name, async () => {
      const gateway = await makeGateway()
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `no outcome within ${deadlineMs} ms; a reply or frame never came`
              )
            ),
          deadlineMs
        )
      })
      try {
        await Promise.race([body(gateway), deadline])
      } finally {
        clearTimeout(timer)
        await gateway.close()
      }
    })

  scenario(
    "a runtime enrolls at the newest version both sides speak",
    async (gateway) => {
      const link = await gateway.connectRuntime()
      link.send({
        type: "enroll",
        runtimeId: "rt-a",
        versions: { min: 1, max: PROTOCOL_VERSION + 5 },
        build: "test",
        threads: [],
      })
      const enrolled = expect(await link.next(), "enrolled")
      assert.equal(enrolled.version, PROTOCOL_VERSION)
      assert.ok(enrolled.heartbeatMs > 0)
    }
  )

  scenario(
    "a runtime with no version in common is refused and disconnected",
    async (gateway) => {
      const link = await gateway.connectRuntime()
      link.send({
        type: "enroll",
        runtimeId: "rt-a",
        versions: { min: PROTOCOL_VERSION + 1, max: PROTOCOL_VERSION + 2 },
        build: "test",
        threads: [],
      })
      const refused = expect(await link.next(), "refused")
      assert.equal(problemType(refused.problem), "unsupported-version")
      assert.equal(refused.problem.outcome, "not-applied")
      await settle()
      assert.equal(link.closed, true)
    }
  )

  scenario("anything before enrolling is refused", async (gateway) => {
    const link = await gateway.connectRuntime()
    link.send({ type: "heartbeat" })
    assert.equal(
      problemType(expect(await link.next(), "refused").problem),
      "unauthorized"
    )
  })

  scenario(
    "a frame that isn't one is refused as a bad request",
    async (gateway) => {
      const link = await gateway.connectRuntime()
      link.sendUnchecked({ type: "enroll", runtimeId: "rt-a" })
      assert.equal(
        problemType(expect(await link.next(), "refused").problem),
        "bad-request"
      )
    }
  )

  scenario(
    "an operation reaches the Thread's runtime with its correlation ID and is numbered in the Thread's stream",
    async (gateway) => {
      const runtime = await enroll(gateway, "rt-a")
      const generation = await take(gateway, runtime, "th-1", "rt-a")
      const client = await gateway.connectClient(desktop)
      const sent = operation("th-1", { text: "hello" })
      const replied = client.call(sent)

      const delivered = expect(await runtime.next(), "operation")
      assert.equal(delivered.generation, generation)
      assert.deepEqual(delivered.operation, sent)
      runtime.send({
        type: "reply",
        reply: {
          v: PROTOCOL_VERSION,
          id: sent.id,
          ok: true,
          value: { echoed: "hello" },
        },
      })

      const reply = success(await replied)
      assert.deepEqual(reply.value, { echoed: "hello" })
      assert.ok(reply.seq !== undefined)
      const admission = await client
        .subscribe({ stream: threadStream("th-1"), after: reply.seq - 1 })
        .next()
      assert.equal(admission.seq, reply.seq)
      assert.equal(admission.correlationId, sent.correlationId)
    }
  )

  scenario(
    "the same operation sent twice runs once and gets the first answer both times",
    async (gateway) => {
      const runtime = await enroll(gateway, "rt-a")
      await take(gateway, runtime, "th-1", "rt-a")
      const client = await gateway.connectClient(desktop)
      const sent = operation("th-1", { text: "once" })
      const first = client.call(sent)
      const delivered = expect(await runtime.next(), "operation")
      const repeat = client.call({ ...sent, attempt: 2 })
      runtime.send({
        type: "reply",
        reply: {
          v: PROTOCOL_VERSION,
          id: delivered.operation.id,
          ok: true,
          value: 1,
        },
      })

      assert.deepEqual(await repeat, await first)
      await nothingArrives(runtime)
    }
  )

  scenario(
    "an operation for a Thread nobody runs isn't applied, and goes through once a runtime takes it",
    async (gateway) => {
      const client = await gateway.connectClient(phone)
      const sent = operation("th-1", { text: "later" })
      const refused = failure(await client.call(sent))
      assert.equal(problemType(refused.problem), "owner-unavailable")
      assert.equal(refused.problem.outcome, "not-applied")
      assert.equal(refused.problem.correlationId, sent.correlationId)

      const runtime = await enroll(gateway, "rt-a")
      await take(gateway, runtime, "th-1", "rt-a")
      const retried = client.call({ ...sent, attempt: 2 })
      runtime.send({
        type: "reply",
        reply: {
          v: PROTOCOL_VERSION,
          id: expect(await runtime.next(), "operation").operation.id,
          ok: true,
        },
      })
      assert.equal((await retried).ok, true)
    }
  )

  scenario(
    "when the runtime drops before answering, the outcome is unknown",
    async (gateway) => {
      const runtime = await enroll(gateway, "rt-a")
      await take(gateway, runtime, "th-1", "rt-a")
      const client = await gateway.connectClient(desktop)
      const replied = client.call(operation("th-1", { text: "lost" }))
      expect(await runtime.next(), "operation")
      runtime.close()

      const lost = failure(await replied)
      assert.equal(problemType(lost.problem), "owner-unavailable")
      assert.equal(lost.problem.outcome, "unknown")
    }
  )

  scenario(
    "a repeat after the runtime dropped is sent again to whoever runs the Thread, and admitted once",
    async (gateway) => {
      const old = await enroll(gateway, "rt-a")
      await take(gateway, old, "th-1", "rt-a")
      const client = await gateway.connectClient(desktop)
      const sent = operation("th-1", { text: "carry on" })
      const lost = client.call(sent)
      expect(await old.next(), "operation")
      old.close()
      assert.equal((await lost).ok, false)

      const next = await enroll(gateway, "rt-b")
      await take(gateway, next, "th-1", "rt-b")
      const retried = client.call({ ...sent, attempt: 2 })
      const delivered = expect(await next.next(), "operation")
      assert.equal(delivered.operation.attempt, 2)
      assert.equal(delivered.operation.id, sent.id)
      next.send({
        type: "reply",
        reply: { v: PROTOCOL_VERSION, id: sent.id, ok: true, value: "done" },
      })
      const reply = success(await retried)
      assert.equal(reply.value, "done")

      const stream = client.subscribe({
        stream: threadStream("th-1"),
        after: 0,
      })
      assert.equal((await stream.next()).seq, reply.seq)
      await nothingArrives(stream)
    }
  )

  scenario(
    "an operation for a runtime reaches that runtime alone and isn't numbered in any Thread",
    async (gateway) => {
      const laptop = await enroll(gateway, "rt-laptop")
      const other = await enroll(gateway, "rt-other")
      const client = await gateway.connectClient(phone)
      const sent = runtimeOperation("rt-laptop", { path: "README.md" })
      const replied = client.call(sent)

      const delivered = expect(await laptop.next(), "operation")
      assert.deepEqual(delivered.operation, sent)
      assert.equal(delivered.generation, undefined)
      laptop.send({
        type: "reply",
        reply: { v: PROTOCOL_VERSION, id: sent.id, ok: true, value: "# Mako" },
      })
      const reply = success(await replied)
      assert.equal(reply.value, "# Mako")
      assert.equal(reply.seq, undefined)
      await nothingArrives(other)
    }
  )

  scenario(
    "an operation for a runtime that isn't connected isn't applied, and a repeat reaches it once it is",
    async (gateway) => {
      const client = await gateway.connectClient(desktop)
      const sent = runtimeOperation("rt-laptop", {})
      const refused = failure(await client.call(sent))
      assert.equal(problemType(refused.problem), "owner-unavailable")
      assert.equal(refused.problem.outcome, "not-applied")

      const laptop = await enroll(gateway, "rt-laptop")
      const retried = client.call({ ...sent, attempt: 2 })
      expect(await laptop.next(), "operation")
      laptop.send({
        type: "reply",
        reply: { v: PROTOCOL_VERSION, id: sent.id, ok: true },
      })
      assert.equal((await retried).ok, true)
    }
  )

  scenario(
    "a runtime's failure is its answer: a repeat gets the same failure without running again",
    async (gateway) => {
      const laptop = await enroll(gateway, "rt-laptop")
      const client = await gateway.connectClient(desktop)
      const sent = runtimeOperation("rt-laptop", {})
      const first = client.call(sent)
      expect(await laptop.next(), "operation")
      const failed: Reply = {
        v: PROTOCOL_VERSION,
        id: sent.id,
        ok: false,
        problem: problem("failed", "It failed", sent.correlationId, "unknown", {
          detail: "the file is gone",
        }),
      }
      laptop.send({ type: "reply", reply: failed })
      assert.deepEqual(await first, failed)
      assert.deepEqual(await client.call({ ...sent, attempt: 2 }), failed)
      await nothingArrives(laptop)
    }
  )

  scenario(
    "a reply from a runtime the operation wasn't sent to is ignored",
    async (gateway) => {
      const laptop = await enroll(gateway, "rt-laptop")
      const intruder = await enroll(gateway, "rt-intruder")
      const client = await gateway.connectClient(desktop)
      const sent = runtimeOperation("rt-laptop", {})
      const replied = client.call(sent)
      expect(await laptop.next(), "operation")
      intruder.send({
        type: "reply",
        reply: { v: PROTOCOL_VERSION, id: sent.id, ok: true, value: "forged" },
      })
      await settle()
      laptop.send({
        type: "reply",
        reply: { v: PROTOCOL_VERSION, id: sent.id, ok: true, value: "real" },
      })
      assert.equal(success(await replied).value, "real")
    }
  )

  scenario(
    "an invalid operation is a bad request that wasn't applied",
    async (gateway) => {
      const client = await gateway.connectClient(desktop)
      const reply = failure(
        await client.call({ ...operation("th-1", {}), attempt: 0 })
      )
      assert.equal(problemType(reply.problem), "bad-request")
      assert.equal(reply.problem.outcome, "not-applied")
    }
  )

  scenario(
    "events are numbered in arrival order, acknowledged, and a resent one is recorded once",
    async (gateway) => {
      const runtime = await enroll(gateway, "rt-a")
      const generation = await take(gateway, runtime, "th-1", "rt-a")
      for (const localSeq of [1, 2, 1])
        runtime.send({
          type: "event",
          threadId: "th-1",
          generation,
          localSeq,
          event: { localSeq },
        })
      const acks = [
        expect(await runtime.next(), "ack"),
        expect(await runtime.next(), "ack"),
        expect(await runtime.next(), "ack"),
      ]
      assert.deepEqual(
        acks.map((ack) => [ack.localSeq, ack.seq]),
        [
          [1, 1],
          [2, 2],
          [1, 1],
        ]
      )

      const client = await gateway.connectClient(desktop)
      const stream = client.subscribe({
        stream: threadStream("th-1"),
        after: 0,
      })
      assert.deepEqual(
        [(await stream.next()).event, (await stream.next()).event],
        [{ localSeq: 1 }, { localSeq: 2 }]
      )
      await nothingArrives(stream)
    }
  )

  scenario(
    "a reader resuming after N gets exactly what came after N, then live events",
    async (gateway) => {
      const runtime = await enroll(gateway, "rt-a")
      const generation = await take(gateway, runtime, "th-1", "rt-a")
      for (const localSeq of [1, 2, 3])
        runtime.send({
          type: "event",
          threadId: "th-1",
          generation,
          localSeq,
          event: localSeq,
        })
      for (let i = 0; i < 3; i++) expect(await runtime.next(), "ack")

      const client = await gateway.connectClient(phone)
      const stream = client.subscribe({
        stream: threadStream("th-1"),
        after: 2,
      })
      assert.equal((await stream.next()).seq, 3)
      runtime.send({
        type: "event",
        threadId: "th-1",
        generation,
        localSeq: 4,
        event: 4,
      })
      const live = await stream.next()
      assert.equal(live.seq, 4)
      assert.equal(live.generation, generation)
    }
  )

  scenario(
    "moving a Thread fences the old runtime, rejects its late events, and the stream carries on",
    async (gateway) => {
      const old = await enroll(gateway, "rt-a")
      const first = await take(gateway, old, "th-1", "rt-a")
      old.send({
        type: "event",
        threadId: "th-1",
        generation: first,
        localSeq: 1,
        event: "before",
      })
      expect(await old.next(), "ack")

      const next = await enroll(gateway, "rt-b")
      const second = await gateway.assign("th-1", "rt-b")
      assert.ok(second > first)
      assert.equal(expect(await old.next(), "fence").generation, second)
      assert.equal(expect(await next.next(), "assign").generation, second)

      old.send({
        type: "event",
        threadId: "th-1",
        generation: first,
        localSeq: 2,
        event: "late",
      })
      const rejected = expect(await old.next(), "rejected")
      assert.equal(problemType(rejected.problem), "fenced")
      assert.equal(rejected.problem.generation, second)

      next.send({
        type: "event",
        threadId: "th-1",
        generation: second,
        localSeq: 1,
        event: "after",
      })
      assert.equal(expect(await next.next(), "ack").seq, 2)
      const stream = (await gateway.connectClient(desktop)).subscribe({
        stream: threadStream("th-1"),
        after: 0,
      })
      assert.deepEqual(
        [(await stream.next()).event, (await stream.next()).event],
        ["before", "after"]
      )
    }
  )

  scenario(
    "a runtime that comes back claiming a Thread it lost is fenced at once",
    async (gateway) => {
      const runtime = await enroll(gateway, "rt-a")
      const first = await take(gateway, runtime, "th-1", "rt-a")
      runtime.close()
      const second = await gateway.assign("th-1", "rt-b")

      const back = await gateway.connectRuntime()
      back.send({
        type: "enroll",
        runtimeId: "rt-a",
        versions: { min: 1, max: PROTOCOL_VERSION },
        build: "test",
        threads: [{ threadId: "th-1", generation: first }],
      })
      expect(await back.next(), "enrolled")
      assert.equal(expect(await back.next(), "fence").generation, second)
    }
  )

  scenario(
    "a runtime that comes back is told which Threads it now runs",
    async (gateway) => {
      await gateway.assign("th-1", "rt-a")
      const runtime = await gateway.connectRuntime()
      runtime.send({
        type: "enroll",
        runtimeId: "rt-a",
        versions: { min: 1, max: PROTOCOL_VERSION },
        build: "test",
        threads: [],
      })
      expect(await runtime.next(), "enrolled")
      assert.equal(expect(await runtime.next(), "assign").threadId, "th-1")
    }
  )

  scenario(
    "a runtime still running a Thread under an old generation is fenced, then given the current one",
    async (gateway) => {
      const first = await gateway.assign("th-1", "rt-a")
      const second = await gateway.assign("th-1", "rt-a")
      const runtime = await gateway.connectRuntime()
      runtime.send({
        type: "enroll",
        runtimeId: "rt-a",
        versions: { min: 1, max: PROTOCOL_VERSION },
        build: "test",
        threads: [{ threadId: "th-1", generation: first }],
      })
      expect(await runtime.next(), "enrolled")
      assert.equal(expect(await runtime.next(), "fence").generation, second)
      assert.equal(expect(await runtime.next(), "assign").generation, second)
    }
  )

  scenario(
    "a runtime that comes back holding the current generation keeps its Thread without being told again",
    async (gateway) => {
      const generation = await gateway.assign("th-1", "rt-a")
      const runtime = await gateway.connectRuntime()
      runtime.send({
        type: "enroll",
        runtimeId: "rt-a",
        versions: { min: 1, max: PROTOCOL_VERSION },
        build: "test",
        threads: [{ threadId: "th-1", generation }],
      })
      expect(await runtime.next(), "enrolled")
      await nothingArrives(runtime)
    }
  )
}

async function enroll(
  gateway: GatewayUnderTest,
  runtimeId: string
): Promise<RuntimeLink> {
  const link = await gateway.connectRuntime()
  link.send({
    type: "enroll",
    runtimeId,
    versions: { min: 1, max: PROTOCOL_VERSION },
    build: "conformance",
    threads: [],
  })
  expect(await link.next(), "enrolled")
  return link
}

async function take(
  gateway: GatewayUnderTest,
  link: RuntimeLink,
  threadId: string,
  runtimeId: string
): Promise<number> {
  const generation = await gateway.assign(threadId, runtimeId)
  const assigned = expect(await link.next(), "assign")
  assert.deepEqual(assigned, { type: "assign", threadId, generation })
  return generation
}

function operation(threadId: string, input: Operation["input"]): Operation {
  return {
    v: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    op: "thread.send",
    target: { kind: "thread", threadId },
    input,
    correlationId: crypto.randomUUID(),
    actor: desktop,
    attempt: 1,
  }
}

function runtimeOperation(
  runtimeId: string,
  input: Operation["input"]
): Operation {
  return {
    v: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    op: "files.read",
    target: { kind: "runtime", runtimeId },
    input,
    correlationId: crypto.randomUUID(),
    actor: desktop,
    attempt: 1,
  }
}

type FrameOf<T extends GatewayFrame["type"]> = Extract<
  GatewayFrame,
  { type: T }
>

function isFrame<T extends GatewayFrame["type"]>(
  frame: GatewayFrame,
  type: T
): frame is FrameOf<T> {
  return frame.type === type
}

function expect<T extends GatewayFrame["type"]>(
  frame: GatewayFrame,
  type: T
): FrameOf<T> {
  if (!isFrame(frame, type))
    assert.fail(`expected ${type}, got ${JSON.stringify(frame)}`)
  return frame
}

function success(reply: Reply): Extract<Reply, { ok: true }> {
  if (!reply.ok) assert.fail(`expected success, got ${JSON.stringify(reply)}`)
  return reply
}

function failure(reply: Reply): Extract<Reply, { ok: false }> {
  if (reply.ok) assert.fail(`expected a problem, got ${JSON.stringify(reply)}`)
  return reply
}

async function nothingArrives(source: {
  next(timeoutMs?: number): Promise<GatewayFrame | EventFrame>
}): Promise<void> {
  await assert.rejects(source.next(50), /nothing arrived/)
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

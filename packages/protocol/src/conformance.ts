import assert from "node:assert/strict"
import {
  type Actor,
  type Operation,
  type Reply,
  problem,
  problemType,
} from "./envelope.js"
import { type EventFrame, threadStream } from "./events.js"
import { readStreamNotice } from "./live-tail.js"
import { sessionStream } from "./socket.js"
import { type ClientSession, type GatewayUnderTest, LinkClosedError, type RuntimeLink } from "./gateway.js"
import type { Json } from "./ids.js"
import { type MediaWatch, encodeMediaMessage } from "./media.js"
import { Payload } from "./payload.js"
import type { GatewayFrame } from "./runtime-frames.js"
import { COMPACT_LIVE_FORM } from "./live-form.js"
import { COMPACT_LIVE_VERSION, MEDIA_VERSION, PROTOCOL_VERSION, SUPPORTED_VERSIONS, type VersionRange } from "./version.js"

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
        versions: { min: 1, max: SUPPORTED_VERSIONS.max + 5 },
        build: "test",
        threads: [],
      })
      const enrolled = expect(await link.next(), "enrolled")
      assert.equal(enrolled.version, SUPPORTED_VERSIONS.max)
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
        versions: { min: SUPPORTED_VERSIONS.max + 1, max: SUPPORTED_VERSIONS.max + 2 },
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

  scenario(
    "a runtime that says it's going quiet is let go at once: its link closes, and it enrolls again when it's back",
    async (gateway) => {
      const link = await gateway.connectRuntime()
      link.send({ type: "enroll", runtimeId: "rt-a", versions: SUPPORTED_VERSIONS, build: "conformance", threads: [] })
      expect(await link.next(), "enrolled")
      link.send({ type: "going-quiet", reason: "sleep" })
      await assert.rejects(link.next(), LinkClosedError, "closed without waiting for missed heartbeats")
      const back = await gateway.connectRuntime()
      back.send({ type: "enroll", runtimeId: "rt-a", versions: SUPPORTED_VERSIONS, build: "conformance", threads: [] })
      expect(await back.next(), "enrolled")
      back.close()
    }
  )

  /** A runtime on the newest link, watched by a client of its conversation `c-1` from `after`: the watch it hears. */
  const watched = async (gateway: GatewayUnderTest, after = 0) => {
    const runtime = await gateway.connectRuntime()
    runtime.send({ type: "enroll", runtimeId: "rt-live", versions: SUPPORTED_VERSIONS, build: "conformance", threads: [] })
    expect(await runtime.next(), "enrolled")
    const client = await gateway.connectClient(phone)
    const stream = client.subscribe({ stream: sessionStream("rt-live", "c-1"), after })
    assert.deepEqual(expect(await runtime.next(), "watch").conversations, ["c-1"])
    return { runtime, client, stream }
  }
  const live = (runtime: RuntimeLink, n: number, text = `update ${n}`, correlationId?: string) =>
    runtime.send({ type: "live", conversation: "c-1", n, event: Payload.encoded(text), ...(correlationId && { correlationId }) })
  const notice = (frame: EventFrame) => {
    const said = readStreamNotice(frame.event.text)
    if (!said) assert.fail(`expected the stream's notice, got ${frame.event.text}`)
    assert.equal(frame.seq, Math.max(1, said.head))
    return said
  }

  scenario(
    "a watched conversation's updates are numbered by its stream: a watcher hears the head first, then each update with the next number, a trace with the one that carries it",
    async (gateway) => {
      const { runtime, stream } = await watched(gateway)
      const head = notice(await stream.next())
      assert.equal(head.streamNotice, "head")
      live(runtime, 7, "first", "st-trace-1")
      live(runtime, 8, "second")
      const first = await stream.next()
      assert.equal(first.seq, head.head + 1)
      assert.equal(first.event.text, "first")
      assert.equal(first.correlationId, "st-trace-1")
      const second = await stream.next()
      assert.equal(second.seq, head.head + 2)
      assert.equal(second.correlationId, undefined)
    }
  )

  scenario(
    "a watcher back from a dropped link gets what it missed from what the gateway kept, then live updates, each once",
    async (gateway) => {
      const { runtime, stream } = await watched(gateway)
      // Another device watches throughout, so this one knows when the gateway has relayed what it misses.
      const other = (await gateway.connectClient(desktop)).subscribe({ stream: sessionStream("rt-live", "c-1"), after: 0 })
      notice(await stream.next())
      notice(await other.next())
      live(runtime, 1)
      const last = (await stream.next()).seq
      await other.next()
      stream.close()
      // Gone from this device; the runtime still sends, and the gateway keeps what it relays.
      live(runtime, 2)
      live(runtime, 3)
      await other.next()
      await other.next()
      // Back on a new connection, as after a dropped link. (On the connection it left, updates relayed before the gateway
      // read its unsubscribe may still be on their way, and would reach a new subscription there ahead of its notice: a
      // follower's cursor takes those as the repeats or the gap they are.)
      const back = (await gateway.connectClient(phone)).subscribe({ stream: sessionStream("rt-live", "c-1"), after: last })
      const head = notice(await back.next())
      assert.equal(head.streamNotice, "head")
      assert.equal(head.head, last + 2)
      assert.deepEqual([await back.next(), await back.next()].map((frame) => [frame.seq, frame.event.text]), [[last + 1, "update 2"], [last + 2, "update 3"]])
      live(runtime, 4)
      const next = await back.next()
      assert.deepEqual([next.seq, next.event.text], [last + 3, "update 4"])
    }
  )

  scenario(
    "a watcher whose place the gateway no longer keeps is told to read the conversation again",
    async (gateway) => {
      const { stream } = await watched(gateway, 1)
      const said = notice(await stream.next())
      assert.equal(said.streamNotice, "reread")
    }
  )

  scenario(
    "a runtime on a new link hears what was last relayed of each watched conversation, and what it sends again is relayed once",
    async (gateway) => {
      const { runtime, stream } = await watched(gateway)
      const head = notice(await stream.next()).head
      live(runtime, 5)
      live(runtime, 6)
      assert.equal((await stream.next()).seq, head + 1)
      assert.equal((await stream.next()).seq, head + 2)
      runtime.close()
      const back = await gateway.connectRuntime()
      back.send({ type: "enroll", runtimeId: "rt-live", versions: SUPPORTED_VERSIONS, build: "conformance", threads: [] })
      expect(await back.next(), "enrolled")
      const watch = expect(await back.next(), "watch")
      assert.deepEqual(watch.conversations, ["c-1"])
      assert.deepEqual(watch.after, { "c-1": 6 })
      back.send({ type: "live", conversation: "c-1", n: 6, event: Payload.encoded("update 6 again") })
      back.send({ type: "live", conversation: "c-1", n: 7, event: Payload.encoded("update 7") })
      const next = await stream.next()
      assert.deepEqual([next.seq, next.event.text], [head + 3, "update 7"])
    }
  )

  /** A client that says it reads the compact live form (`live-form.ts`). */
  const compactReader = (gateway: GatewayUnderTest, actor = phone) => gateway.connectClient(actor, { live: COMPACT_LIVE_FORM })
  const compactLive = (runtime: RuntimeLink, n: number, text = `compact ${n}`) =>
    runtime.send({ type: "live", conversation: "c-1", n, form: COMPACT_LIVE_FORM, event: Payload.encoded(text) })

  scenario(
    "a conversation whose watchers all read the compact live form is said so in `watch`; a watcher of form 1 joining is said again without, and hears the notice to read again in place of a compact update",
    async (gateway) => {
      const runtime = await gateway.connectRuntime()
      runtime.send({ type: "enroll", runtimeId: "rt-live", versions: SUPPORTED_VERSIONS, build: "conformance", threads: [] })
      expect(await runtime.next(), "enrolled")
      const compact = (await compactReader(gateway)).subscribe({ stream: sessionStream("rt-live", "c-1"), after: 0 })
      const watch = expect(await runtime.next(), "watch")
      assert.deepEqual([watch.conversations, watch.forms], [["c-1"], { "c-1": COMPACT_LIVE_FORM }])
      notice(await compact.next())
      compactLive(runtime, 1)
      assert.equal((await compact.next()).event.text, "compact 1")

      const whole = (await gateway.connectClient(desktop)).subscribe({ stream: sessionStream("rt-live", "c-1"), after: 0 })
      const again = expect(await runtime.next(), "watch")
      assert.deepEqual(again.conversations, ["c-1"])
      assert.equal(again.forms?.["c-1"], undefined, "form 1 is the one every watcher reads")
      notice(await whole.next())
      // Written before the runtime heard: the compact reader takes it, the other reads the conversation again instead.
      compactLive(runtime, 2)
      const taken = await compact.next()
      assert.equal(taken.event.text, "compact 2")
      const instead = notice(await whole.next())
      assert.deepEqual([instead.streamNotice, instead.head], ["reread", taken.seq])
      live(runtime, 3, "whole 3")
      const [both, also] = [await compact.next(), await whole.next()]
      assert.deepEqual([both.seq, both.event.text, also.seq, also.event.text], [taken.seq + 1, "whole 3", taken.seq + 1, "whole 3"])

      whole.close()
      assert.deepEqual(expect(await runtime.next(), "watch").forms, { "c-1": COMPACT_LIVE_FORM }, "back to compact once the form 1 watcher is gone")
    }
  )

  scenario(
    "a watcher back from a dropped link is served what it missed in the form it reads, or told to read again where it was written in another",
    async (gateway) => {
      const runtime = await gateway.connectRuntime()
      runtime.send({ type: "enroll", runtimeId: "rt-live", versions: SUPPORTED_VERSIONS, build: "conformance", threads: [] })
      expect(await runtime.next(), "enrolled")
      const watching = (await compactReader(gateway)).subscribe({ stream: sessionStream("rt-live", "c-1"), after: 0 })
      expect(await runtime.next(), "watch")
      notice(await watching.next())
      live(runtime, 1, "whole 1")
      const first = (await watching.next()).seq
      compactLive(runtime, 2)
      live(runtime, 3, "whole 3")
      await watching.next()
      await watching.next()
      const compact = (await compactReader(gateway, desktop)).subscribe({ stream: sessionStream("rt-live", "c-1"), after: first })
      assert.equal(notice(await compact.next()).streamNotice, "head")
      assert.deepEqual([(await compact.next()).event.text, (await compact.next()).event.text], ["compact 2", "whole 3"])
      const whole = (await gateway.connectClient(desktop)).subscribe({ stream: sessionStream("rt-live", "c-1"), after: first })
      const said = notice(await whole.next())
      assert.deepEqual([said.streamNotice, said.head], ["reread", first + 2])
      live(runtime, 4, "whole 4")
      assert.equal((await whole.next()).event.text, "whole 4")
    }
  )

  /** A runtime on the newest link that runs Thread `th-1`, and the generation it runs it under. */
  const running = async (gateway: GatewayUnderTest) => {
    const runtime = await gateway.connectRuntime()
    runtime.send({ type: "enroll", runtimeId: "rt-a", versions: SUPPORTED_VERSIONS, build: "conformance", threads: [] })
    expect(await runtime.next(), "enrolled")
    return { runtime, generation: await take(gateway, runtime, "th-1", "rt-a") }
  }

  scenario(
    "a Thread whose readers all read the compact live form is said so (`live-form`); a reader of form 1 hears the notice to read again in place of a compact event, and a run of them from the log as one",
    async (gateway) => {
      const { runtime, generation } = await running(gateway)
      const event = (localSeq: number, compact: boolean) =>
        runtime.send({ type: "event", threadId: "th-1", generation, localSeq, event: Payload.encoded(`${compact ? "compact" : "whole"} ${localSeq}`), ...(compact && { form: COMPACT_LIVE_FORM }) })
      const compact = (await compactReader(gateway)).subscribe({ stream: threadStream("th-1"), after: 0 })
      assert.deepEqual(expect(await runtime.next(), "live-form"), { type: "live-form", threadId: "th-1", form: COMPACT_LIVE_FORM })
      event(1, true)
      expect(await runtime.next(), "ack")
      assert.deepEqual([(await compact.next()).event.text], ["compact 1"])

      const whole = (await gateway.connectClient(desktop)).subscribe({ stream: threadStream("th-1"), after: 0 })
      assert.deepEqual(notice(await whole.next()), { streamNotice: "reread", head: 1 })
      assert.equal(expect(await runtime.next(), "live-form").form, 1)
      // Written before the runtime heard: the compact reader takes it; the other, the notice under its number.
      event(2, true)
      expect(await runtime.next(), "ack")
      const taken = await compact.next()
      assert.deepEqual([taken.seq, taken.event.text], [2, "compact 2"])
      assert.deepEqual(notice(await whole.next()), { streamNotice: "reread", head: 2 })
      event(3, false)
      expect(await runtime.next(), "ack")
      assert.deepEqual([(await compact.next()).event.text, (await whole.next()).event.text], ["whole 3", "whole 3"])

      const later = (await gateway.connectClient(desktop)).subscribe({ stream: threadStream("th-1"), after: 0 })
      assert.deepEqual(notice(await later.next()), { streamNotice: "reread", head: 2 }, "events 1 and 2, as one notice")
      assert.deepEqual([(await later.next()).seq], [3])

      whole.close()
      later.close()
      assert.equal(expect(await runtime.next(), "live-form").form, COMPACT_LIVE_FORM, "back to compact once the form 1 readers are gone")
    }
  )

  scenario(
    "a runtime given a Thread whose readers read the compact live form hears so with the assignment",
    async (gateway) => {
      const reader = (await compactReader(gateway)).subscribe({ stream: threadStream("th-1"), after: 0 })
      const runtime = await gateway.connectRuntime()
      runtime.send({ type: "enroll", runtimeId: "rt-a", versions: SUPPORTED_VERSIONS, build: "conformance", threads: [] })
      expect(await runtime.next(), "enrolled")
      await take(gateway, runtime, "th-1", "rt-a")
      assert.deepEqual(expect(await runtime.next(), "live-form"), { type: "live-form", threadId: "th-1", form: COMPACT_LIVE_FORM })
      reader.close()
    }
  )

  scenario(
    "a runtime on a link before the compact live form is never told what its readers read",
    async (gateway) => {
      const runtime = await gateway.connectRuntime()
      runtime.send({ type: "enroll", runtimeId: "rt-a", versions: { min: 1, max: COMPACT_LIVE_VERSION - 1 }, build: "conformance", threads: [] })
      expect(await runtime.next(), "enrolled")
      await take(gateway, runtime, "th-1", "rt-a")
      const client = await compactReader(gateway)
      client.subscribe({ stream: threadStream("th-1"), after: 0 })
      client.subscribe({ stream: sessionStream("rt-a", "c-1"), after: 0 })
      const watch = expect(await runtime.next(), "watch")
      assert.deepEqual([watch.conversations, watch.forms], [["c-1"], undefined])
      await nothingArrives(runtime)
    }
  )

  scenario("anything before enrolling is refused", async (gateway) => {
    const link = await gateway.connectRuntime()
    link.send({
      type: "event",
      threadId: "th-1",
      generation: 1,
      localSeq: 1,
      event: Payload.of("early"),
    })
    assert.equal(
      problemType(expect(await link.next(), "refused").problem),
      "unauthorized"
    )
  })

  scenario(
    "a frame that isn't one is refused as a bad request",
    async (gateway) => {
      const link = await gateway.connectRuntime()
      link.sendUnchecked(JSON.stringify({ type: "enroll", runtimeId: "rt-a" }))
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
          value: Payload.of({ echoed: "hello" }),
        },
      })

      const reply = success(await replied)
      assert.deepEqual(reply.value?.decode(), { echoed: "hello" })
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
          value: Payload.of(1),
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
        reply: {
          v: PROTOCOL_VERSION,
          id: sent.id,
          ok: true,
          value: Payload.of("done"),
        },
      })
      const reply = success(await retried)
      assert.equal(reply.value?.decode(), "done")

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
        reply: {
          v: PROTOCOL_VERSION,
          id: sent.id,
          ok: true,
          value: Payload.of("# Mako"),
        },
      })
      const reply = success(await replied)
      assert.equal(reply.value?.decode(), "# Mako")
      assert.equal(reply.seq, undefined)
      await nothingArrives(other)
    }
  )

  scenario(
    "a runtime operation's input and its reply's value cross unread, byte for byte, so only the runtime and the client decode them",
    async (gateway) => {
      const laptop = await enroll(gateway, "rt-laptop")
      const client = await gateway.connectClient(desktop)
      const input = Payload.encoded('{"path": "README.md",\n  "limit": 1.50, "name": "\\u00e9"}')
      const sent = runtimeOperation("rt-laptop", input)
      const replied = client.call(sent)

      const delivered = expect(await laptop.next(), "operation")
      assert.equal(delivered.operation.input.text, input.text)
      const value = Payload.encoded("only the client reads this, so it needn't be JSON to the gateway")
      laptop.send({
        type: "reply",
        reply: { v: PROTOCOL_VERSION, id: sent.id, ok: true, value },
      })
      assert.equal(success(await replied).value?.text, value.text)
    }
  )

  scenario(
    "an event reaches its readers byte for byte as its runtime encoded it",
    async (gateway) => {
      const runtime = await enroll(gateway, "rt-a")
      const generation = await take(gateway, runtime, "th-1", "rt-a")
      const event = Payload.encoded('{ "type": "delta",\n  "text": "caf\\u00e9", "at": 1.0 }')
      runtime.send({
        type: "event",
        threadId: "th-1",
        generation,
        localSeq: 1,
        event,
      })
      expect(await runtime.next(), "ack")
      const stream = (await gateway.connectClient(phone)).subscribe({
        stream: threadStream("th-1"),
        after: 0,
      })
      assert.equal((await stream.next()).event.text, event.text)
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
        reply: {
          v: PROTOCOL_VERSION,
          id: sent.id,
          ok: true,
          value: Payload.of("forged"),
        },
      })
      await settle()
      laptop.send({
        type: "reply",
        reply: {
          v: PROTOCOL_VERSION,
          id: sent.id,
          ok: true,
          value: Payload.of("real"),
        },
      })
      assert.equal(success(await replied).value?.decode(), "real")
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
          event: Payload.of({ localSeq }),
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
        [
          (await stream.next()).event.decode(),
          (await stream.next()).event.decode(),
        ],
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
          event: Payload.of(localSeq),
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
        event: Payload.of(4),
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
        event: Payload.of("before"),
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
        event: Payload.of("late"),
      })
      const rejected = expect(await old.next(), "rejected")
      assert.equal(problemType(rejected.problem), "fenced")
      assert.equal(rejected.problem.generation, second)
      assert.equal(rejected.generation, first, "the rejection names the generation the event was sent under")

      next.send({
        type: "event",
        threadId: "th-1",
        generation: second,
        localSeq: 1,
        event: Payload.of("after"),
      })
      assert.equal(expect(await next.next(), "ack").seq, 2)
      const stream = (await gateway.connectClient(desktop)).subscribe({
        stream: threadStream("th-1"),
        after: 0,
      })
      assert.deepEqual(
        [
          (await stream.next()).event.decode(),
          (await stream.next()).event.decode(),
        ],
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

/** A gateway that relays a Thread's media (`media.ts`), as the media suite drives it. */
export type MediaGatewayUnderTest = {
  /**
   * A Thread run by a runtime that enrolled at `versions` (every version this build speaks unless given), its link
   * read past `enrolled` and `assign`, so the next frame it reads is the first about media.
   */
  thread(versions?: VersionRange): Promise<{ threadId: string; runtime: RuntimeLink }>
  /** A client admitted to every Thread `thread` makes. */
  client(): Promise<ClientSession>
  close(): Promise<void>
}

/**
 * What every gateway owes a Thread's live media: the client's request and the runtime's bytes cross unread, the
 * viewer's acknowledgements reach the runtime, nothing of it enters the Thread's stream, and each side hears when
 * the other ends it. Each case gets a fresh gateway from `makeGateway`.
 */
export function runMediaConformance(
  makeGateway: () => Promise<MediaGatewayUnderTest>,
  test: ConformanceTest,
  options: { deadlineMs?: number } = {}
): void {
  const deadlineMs = options.deadlineMs ?? 5_000
  const scenario = (name: string, body: (gateway: MediaGatewayUnderTest) => Promise<void>) =>
    test(name, async () => {
      const gateway = await makeGateway()
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no outcome within ${deadlineMs} ms; a frame or message never came`)), deadlineMs)
      })
      try {
        await Promise.race([body(gateway), deadline])
      } finally {
        clearTimeout(timer)
        await gateway.close()
      }
    })
  const streamName = () => `s-${crypto.randomUUID()}`
  const watched = async (runtime: RuntimeLink, threadId: string, stream: string) => {
    const frame = expect(await runtime.next(), "media-watch")
    assert.deepEqual({ type: frame.type, threadId: frame.threadId, stream: frame.stream }, { type: "media-watch", threadId, stream })
    return frame.request
  }
  const data = async (watch: MediaWatch) => {
    const delivery = await watch.next()
    if (delivery.kind !== "data") assert.fail(`expected data, got ${JSON.stringify(delivery)}`)
    return delivery.data
  }
  const ended = async (watch: MediaWatch) => {
    const delivery = await watch.next()
    if (delivery.kind !== "ended") assert.fail(`expected the end, got ${delivery.data.byteLength} bytes`)
    return delivery.problem
  }

  scenario(
    "a watch's request reaches the runtime unread, its messages reach the viewer byte for byte, and the viewer's acknowledgements reach the runtime",
    async (gateway) => {
      const { threadId, runtime } = await gateway.thread()
      const client = await gateway.client()
      const stream = streamName()
      // Spacing and key order a re-encoding would lose.
      const request = Payload.encoded('{"z": 1,  "a": [true]}')
      const watch = client.watch({ threadId, stream, request })
      assert.equal((await watched(runtime, threadId, stream)).text, request.text)
      const bytes = [Uint8Array.of(0, 255, 10, 13, 0x7b), new Uint8Array(200_000).map((_, index) => index % 251)]
      for (const each of bytes) runtime.sendMedia(encodeMediaMessage(stream, each))
      for (const each of bytes) assert.deepEqual(await data(watch), each)
      watch.ack(bytes[0]!.byteLength + bytes[1]!.byteLength)
      assert.deepEqual(await runtime.next(), { type: "media-ack", stream, received: 200_005 })
      watch.close()
    }
  )

  scenario("a viewer changing its request reaches the runtime as a watch of the same stream", async (gateway) => {
    const { threadId, runtime } = await gateway.thread()
    const client = await gateway.client()
    const stream = streamName()
    const watch = client.watch({ threadId, stream, request: Payload.of({ width: 640 }) })
    await watched(runtime, threadId, stream)
    watch.update(Payload.of({ width: 1280 }))
    assert.deepEqual((await watched(runtime, threadId, stream)).decode(), { width: 1280 })
    watch.close()
  })

  scenario("a viewer that stops watching tells the runtime, and media still on its way after is dropped", async (gateway) => {
    const { threadId, runtime } = await gateway.thread()
    const client = await gateway.client()
    const stream = streamName()
    const watch = client.watch({ threadId, stream, request: Payload.of({}) })
    await watched(runtime, threadId, stream)
    watch.close()
    assert.deepEqual(await runtime.next(), { type: "media-unwatch", stream })
    runtime.sendMedia(encodeMediaMessage(stream, Uint8Array.of(1)))
    assert.deepEqual(await runtime.next(), { type: "media-unwatch", stream }, "the gateway says again that nobody watches")
  })

  scenario("media nobody watches is answered with an unwatch", async (gateway) => {
    const { runtime } = await gateway.thread()
    const stream = streamName()
    runtime.sendMedia(encodeMediaMessage(stream, Uint8Array.of(1, 2, 3)))
    assert.deepEqual(await runtime.next(), { type: "media-unwatch", stream })
  })

  scenario("media never enters the Thread's stream", async (gateway) => {
    const { threadId, runtime } = await gateway.thread()
    const client = await gateway.client()
    const events = client.subscribe({ stream: threadStream(threadId), after: 0 })
    const before = await drain(events)
    const stream = streamName()
    const watch = client.watch({ threadId, stream, request: Payload.of({}) })
    await watched(runtime, threadId, stream)
    for (let index = 0; index < 5; index++) runtime.sendMedia(encodeMediaMessage(stream, Uint8Array.of(index)))
    for (let index = 0; index < 5; index++) await data(watch)
    watch.ack(5)
    expect(await runtime.next(), "media-ack")
    watch.close()
    expect(await runtime.next(), "media-unwatch")
    assert.deepEqual(await drain(events), [], `nothing was recorded after the ${before.length} events already there`)
    events.close()
  })

  scenario("a runtime ending a stream ends it for its viewer, with its reason", async (gateway) => {
    const { threadId, runtime } = await gateway.thread()
    const client = await gateway.client()
    const stream = streamName()
    const watch = client.watch({ threadId, stream, request: Payload.of({}) })
    await watched(runtime, threadId, stream)
    const reason = problem("failed", "The tab closed", crypto.randomUUID(), "not-applied")
    runtime.send({ type: "media-end", stream, problem: reason })
    assert.deepEqual(await ended(watch), reason)
    await assert.rejects(watch.next(), LinkClosedError)
  })

  scenario("a viewer's stream ends when its runtime's link closes", async (gateway) => {
    const { threadId, runtime } = await gateway.thread()
    const client = await gateway.client()
    const stream = streamName()
    const watch = client.watch({ threadId, stream, request: Payload.of({}) })
    await watched(runtime, threadId, stream)
    runtime.close()
    const reason = await ended(watch)
    assert.equal(reason && problemType(reason), "unavailable")
  })

  scenario("a Thread whose runtime isn't connected can't be watched", async (gateway) => {
    const { threadId, runtime } = await gateway.thread()
    const client = await gateway.client()
    runtime.close()
    // Whether the gateway has heard of the close yet or ends the watch when it does, the answer is the same.
    const watch = client.watch({ threadId, stream: streamName(), request: Payload.of({}) })
    const reason = await ended(watch)
    assert.equal(reason && problemType(reason), "unavailable")
  })

  scenario("a runtime that agreed a version before media is never asked for it", async (gateway) => {
    const { threadId, runtime } = await gateway.thread({ min: 1, max: MEDIA_VERSION - 1 })
    const client = await gateway.client()
    const watch = client.watch({ threadId, stream: streamName(), request: Payload.of({}) })
    const reason = await ended(watch)
    assert.equal(reason && problemType(reason), "unsupported-version")
    await nothingArrives(runtime)
  })
}

/** Every event that arrives within a short wait. */
async function drain(events: { next(timeoutMs?: number): Promise<EventFrame> }): Promise<EventFrame[]> {
  const seen: EventFrame[] = []
  for (;;) {
    try {
      seen.push(await events.next(200))
    } catch (error) {
      if (error instanceof Error && /nothing arrived/.test(error.message)) return seen
      throw error
    }
  }
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

function operation(threadId: string, input: Json): Operation {
  return {
    v: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    op: "thread.send",
    target: { kind: "thread", threadId },
    input: Payload.of(input),
    correlationId: crypto.randomUUID(),
    actor: desktop,
    attempt: 1,
  }
}

function runtimeOperation(
  runtimeId: string,
  input: Json | Payload
): Operation {
  return {
    v: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    op: "files.read",
    target: { kind: "runtime", runtimeId },
    input: input instanceof Payload ? input : Payload.of(input),
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

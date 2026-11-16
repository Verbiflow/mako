import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mock } from "node:test"
import { EPHEMERAL_LIVE_VERSION, readStreamNotice, serveRuntime, sessionStream, type RuntimeFrame, type Subscription } from "@mako/protocol"
import { createFakeGateway } from "@mako/protocol/fake-gateway"
import { SessionPublisher } from "@mako/host/conversations/session-report"

// The same LiveTail and wire encoders the gateway uses, not merely the publisher's private replay buffer.
for (const version of [EPHEMERAL_LIVE_VERSION, EPHEMERAL_LIVE_VERSION - 1]) {
  const conversation = randomUUID(), epoch = randomUUID(), runtimeId = `d-${randomUUID()}`
  const gateway = createFakeGateway()
  const link = await gateway.connectRuntime()
  let hintFrames = 0, badHintFrames = 0, readyFrames = 0
  const send = link.send.bind(link)
  mock.method(link, "send", (frame: RuntimeFrame) => {
    if (frame.type === "live" && frame.event.text.includes('"conversation-app-hint"')) {
      hintFrames++
      if (frame.ephemeral !== true || "n" in frame) badHintFrames++
      if (frame.event.text.includes('"ready":true')) readyFrames++
    }
    send(frame)
  })
  const publisher = new SessionPublisher({ rows: () => [], now: () => 10_000, schedule: () => {}, appsFollowing: () => new Set([conversation]), appPosition: () => ({ epoch, revision: 0 }) })
  const served = await serveRuntime(link, {
    runtimeId, build: "app-hint-tail", versions: { min: version, max: version },
    handle: async () => { throw new Error("This proof makes no host calls") },
    watch: (ids, after, forms) => publisher.watch(link, ids, after, forms),
  })
  publisher.linked({ link, served })
  const numbers: number[] = []
  const live = served.live.bind(served)
  mock.method(served, "live", (...args: Parameters<typeof served.live>) => {
    assert.ok(args[2], "only durable live updates take a runtime number")
    numbers.push(args[2].n)
    return live(...args)
  })
  const stream = sessionStream(runtimeId, conversation)
  const actor = () => ({ kind: "client" as const, client: "web" as const, deviceId: randomUUID() })
  const passing = (await gateway.connectClient(actor(), { ephemeral: true })).subscribe({ stream, after: 0 })
  const plain = (await gateway.connectClient(actor())).subscribe({ stream, after: 0 })
  assert.equal(readStreamNotice((await passing.next(5_000)).event.text)?.streamNotice, "head")
  assert.equal(readStreamNotice((await plain.next(5_000)).event.text)?.streamNotice, "head")
  let receivedHints = 0
  const kept = async (subscription: Subscription) => {
    for (let index = 0; index < 1_200; index++) {
      const frame = await subscription.next(5_000)
      if (!frame.ephemeral) return frame
      assert.equal(subscription, passing, "a client that didn't declare ephemeral support hears none")
      assert.equal(frame.seq, 0, "passing state has no sequence position")
      assert.ok(frame.event.text.includes('"conversation-app-hint"'))
      receivedHints++
    }
    throw new Error("Expected a bounded hint burst followed by a live batch")
  }
  const batch = (revision: number) => publisher.event("event", { type: "live-batch", conversation, payload: JSON.stringify({ type: "live-batch", batch: { id: conversation, revision, updates: [] } }) })
  assert.equal(badHintFrames, 0, "ready is unnumbered ephemeral state, not a live update in the replay tail")
  batch(1)
  const first = await kept(passing)
  assert.ok(first.event.text.includes('"live-batch"'))
  assert.equal((await kept(plain)).seq, first.seq)
  for (let revision = 1; revision <= 1_100; revision++) publisher.own({ type: "view-hint", hint: { epoch, revision, domain: "apps", fields: ["state"] } })
  publisher.appReady(conversation)
  batch(2)
  assert.equal(badHintFrames, 0, "app hints, including ready, are unnumbered ephemeral frames, never kept live updates")
  assert.deepEqual(numbers, [10_001, 10_002], "hints cannot consume the host's runtime update counter")
  const second = await kept(passing)
  assert.equal(second.seq, first.seq + 1, "hints cannot consume gateway tail slots or sequence numbers")
  assert.ok(second.event.text.includes('"revision":2'))
  assert.equal((await kept(plain)).event.text, second.event.text, "the non-declaring client sees only the two live batches")
  if (version >= EPHEMERAL_LIVE_VERSION) {
    assert.ok(readyFrames >= 1)
    assert.ok(hintFrames >= 1_101)
    assert.equal(receivedHints, hintFrames)
  } else assert.deepEqual([hintFrames, receivedHints], [0, 0], "an older negotiated link sends no hints, including ready")
  const resumed = (await gateway.connectClient(actor())).subscribe({ stream, after: first.seq })
  const notice = readStreamNotice((await resumed.next(5_000)).event.text)
  assert.deepEqual(notice, { streamNotice: "head", head: second.seq }, "after more hints than the tail holds, resuming needs no snapshot reread")
  assert.equal((await resumed.next(5_000)).event.text, second.event.text, "only the missed durable batch replays")
  // The host's replay buffer is independent of the gateway's tail, and must retain the same batch too.
  numbers.length = 0
  publisher.watch(link, [conversation], { [conversation]: 10_001 })
  assert.deepEqual(numbers, [10_002], "host replay retains only the missed durable batch")
  resumed.close(); plain.close(); passing.close(); served.close(); link.close()
  mock.restoreAll()
  console.log(`remote app tail: link ${version}, ${hintFrames} hint frames; host/runtime and gateway sequence delta 1; tail replay intact`)
}

import assert from "node:assert/strict"
import { once } from "node:events"
import { mock } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"
import { WebSocketServer, type WebSocket as ServerSocket } from "ws"
import { z } from "zod"
import { PING, PONG } from "@mako/protocol"
import { CloudLink } from "../packages/host/src/usage/cloud-link.ts"

// Long enough that a runner stalled for a second can't make a link look silent, or an answer late.
const SILENT_MS = 3_000
const ANSWER_MS = 1_500
/** A hang guard: what the probe or a reach opens comes well before the 25 s heartbeat would find a link dead. */
const OPENS_MS = 20_000

/** Idle accounts keep their old cadence; only current ownership waits get immediate probes. */
async function heartbeatDeadline(): Promise<void> {
  const original = globalThis.WebSocket
  class Socket extends EventTarget {
    static readonly OPEN = 1
    static readonly CONNECTING = 0
    static readonly CLOSED = 3
    static readonly all: Socket[] = []
    readyState = Socket.CONNECTING
    answers = false
    pings = 0
    readonly at = Date.now()
    constructor() {
      super()
      Socket.all.push(this)
      queueMicrotask(() => { this.readyState = Socket.OPEN; this.dispatchEvent(new Event("open")) })
    }
    send(data: string): void {
      if (data !== PING) return
      this.pings += 1
      if (this.answers) this.dispatchEvent(new MessageEvent("message", { data: PONG }))
    }
    close(): void { this.readyState = Socket.CLOSED; this.dispatchEvent(new Event("close")) }
  }
  const advance = async (ms: number) => { mock.timers.tick(ms); await Promise.resolve(); await Promise.resolve() }
  mock.timers.enable({ apis: ["Date", "setTimeout"] })
  mock.method(Math, "random", () => 0.5)
  Reflect.set(globalThis, "WebSocket", Socket)
  let waiting = false, readings = 0
  const options = {
    name: "account", url: new URL("http://127.0.0.1/fixture"), token: async () => "fixture",
    refused() {}, removed() {}, signedIn: () => true, onState() {}, attach: () => ({ close() {} }),
    waiting: () => { readings += 1; return waiting },
  }
  const idle = new CloudLink(options)
  const failing = new CloudLink(options)
  try {
    idle.start()
    await advance(0)
    const first = Socket.all[0]!
    const idleReadings = readings
    await advance(5_000)
    assert.equal(readings, idleReadings, "an idle link has no short polling timer")
    assert.equal(first.pings, 0, "idle accounts have no five-second heartbeat")
    await advance(20_000)
    assert.equal(first.pings, 1, "idle accounts retain the 25-second heartbeat")
    waiting = true
    idle.checkWaiting()
    assert.equal(first.pings, 2, "new ownership work probes at once")
    idle.checkWaiting()
    idle.checkWaiting()
    assert.equal(first.pings, 2, "many held turns share one outstanding probe")
    await advance(1_000)
    first.dispatchEvent(new MessageEvent("message", { data: '{"type":"renewed"}' }))
    await advance(2_000)
    assert.equal(first.readyState, Socket.OPEN, "any inbound replay proves liveness, without a pong")
    first.answers = true
    await advance(2_000)
    assert.equal(first.pings, 3, "only an ongoing wait keeps the short cadence")
    await advance(3_000)
    waiting = false
    idle.checkWaiting()
    const pings = first.pings, settledReadings = readings
    await advance(5_000)
    assert.equal(readings, settledReadings, "settled ownership cancels short timer wakeups as well as pings")
    assert.equal(first.pings, pings, "settled ownership cancels the short timer")
    idle.stop()
    const unnotified = new CloudLink(options)
    try {
      unnotified.start()
      await advance(0)
      const socket = Socket.all.at(-1)!
      waiting = true
      // A missed ownership-change notification must not disable both heartbeat policies.
      await advance(24_999)
      assert.equal(socket.pings, 0, "an unannounced wait adds no idle timer wakeups")
      await advance(1)
      assert.equal(socket.pings, 1, "keepalive starts the missing ownership probe")
      await advance(2_999)
      assert.equal(socket.readyState, Socket.OPEN)
      await advance(1)
      assert.equal(socket.readyState, Socket.CLOSED, "the recovered probe enforces its three-second deadline")
      await advance(250)
      assert.notEqual(Socket.all.at(-1), socket, "an unanswered unannounced wait reconnects")
    } finally { unnotified.stop() }
    // Each link receives an initial replay but never a PONG. Its next probe times out after it has been open >5s.
    // That timeout must never reset the growing backoff just because the open time exceeded STABLE_MS.
    waiting = true
    failing.start()
    await advance(0)
    const start = Socket.all.length - 1
    const backoffs = [250, 1_000, 2_000, 5_000, 10_000, 30_000, 30_000]
    for (const backoff of backoffs) {
      const current = Socket.all.at(-1)!
      assert.equal(current.pings, 1, "a replacement with work waiting probes immediately")
      await advance(1_000)
      current.dispatchEvent(new MessageEvent("message", { data: '{"type":"renewed"}' }))
      await advance(2_000)
      assert.equal(current.readyState, Socket.OPEN)
      await advance(2_000)
      assert.equal(current.pings, 2)
      // A reply from an old socket cannot settle this connection's new probe.
      first.dispatchEvent(new MessageEvent("message", { data: PONG }))
      await advance(3_000)
      assert.equal(current.readyState, Socket.CLOSED, "the current missing reply reaches its deadline")
      await advance(backoff)
      assert.notEqual(Socket.all.at(-1), current, "the successor opens at the growing backoff")
    }
    const gaps = Socket.all.slice(start + 1).map((socket, n) => socket.at - Socket.all[start + n]!.at)
    assert.deepEqual(gaps, backoffs.map(delay => 8_000 + delay), "unanswered links grow to the 30-second backoff cap")
    // No frame at all: the opening handshake is not a probe answer, even in the same millisecond.
    const unanswered = Socket.all.at(-1)!
    await advance(3_000)
    assert.equal(unanswered.readyState, Socket.CLOSED)
    await advance(30_000)
    waiting = false
    failing.checkWaiting()
    const unproven = Socket.all.at(-1)!
    await advance(8_000)
    unproven.close()
    const beforeUnproven = Socket.all.length
    await advance(29_999)
    assert.equal(Socket.all.length, beforeUnproven, "open time without any inbound frame is not stability")
    await advance(1)
    const proven = Socket.all.at(-1)!
    proven.answers = true
    waiting = true
    failing.checkWaiting()
    await advance(5_000)
    await advance(3_000)
    proven.close()
    const beforeHealthy = Socket.all.length
    await advance(249)
    assert.equal(Socket.all.length, beforeHealthy)
    await advance(1)
    assert.equal(Socket.all.length, beforeHealthy + 1, "a genuinely answered, stable connection resets ordinary drop backoff")
    failing.stop()
    const opened = Socket.all.length
    await advance(60_000)
    assert.equal(Socket.all.length, opened, "Stop cancels probes and reconnects")
    const runtime = new CloudLink({ ...options, name: "runtime", waiting: undefined })
    try {
      runtime.start()
      await advance(0)
      const socket = Socket.all.at(-1)!
      await advance(25_000)
      assert.equal(socket.pings, 1)
      await advance(25_000)
      assert.equal(socket.pings, 2)
      await advance(25_000)
      assert.equal(socket.readyState, Socket.CLOSED, "idle links retain their old 60-second silence policy")
    } finally { runtime.stop() }
  } finally {
    idle.stop()
    failing.stop()
    Reflect.set(globalThis, "WebSocket", original)
    mock.timers.reset()
    mock.restoreAll()
  }
}

await heartbeatDeadline()

const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
await once(server, "listening")
const { port } = z.object({ port: z.number() }).parse(server.address())
/** Each connection the link opened, in order: whether it answers a ping (a stalled one doesn't), and how many it was sent. */
type Served = { socket: ServerSocket; answers: boolean; pings: number }
const served: Served[] = []
server.on("connection", (socket) => {
  const connection: Served = { socket, answers: true, pings: 0 }
  served.push(connection)
  socket.on("message", (data) => {
    if (data.toString() !== PING) return
    connection.pings += 1
    if (connection.answers) socket.send(PONG)
  })
})

/** The link's side of each connection, once it's open and attached. */
const attached: WebSocket[] = []
let onAttached: (() => void) | undefined
const link = new CloudLink({
  name: "test",
  url: new URL(`http://127.0.0.1:${port}/`),
  token: async () => "token",
  refused: () => {},
  attach: (socket) => {
    attached.push(socket)
    onAttached?.()
    return { close: () => {} }
  },
  removed: () => {},
  onState: () => {},
  signedIn: () => true,
})

const nextAttached = (count: number) =>
  attached.length >= count
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`connection ${count} never opened within ${OPENS_MS / 1_000} s`)), OPENS_MS)
        onAttached = () => {
          if (attached.length < count) return
          clearTimeout(timer)
          resolve()
        }
      })

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + OPENS_MS
  while (!check() && Date.now() < deadline) await sleep(5)
  assert.ok(check(), what)
}

/** The cloud says something on the newest connection, and the link has heard it. */
const heard = async () => {
  const socket = attached.at(-1)!
  const arrived = once(socket, "message")
  served.at(-1)!.socket.send('{"type":"renewed","expiresAt":0}')
  await arrived
}

try {
  link.start()
  await nextAttached(1)

  // Heard from just now, then stalled: the send is too soon after to ask, so it's asked once silent long enough, and
  // replaced unanswered, though nothing more went out.
  await heard()
  served[0]!.answers = false
  const sentAt = Date.now()
  link.probeIfSilent(SILENT_MS, ANSWER_MS)
  await nextAttached(2)
  const replacedMs = Date.now() - sentAt
  assert.equal(served[0]!.pings, 1, "the stalled link was asked once")
  assert.ok(replacedMs >= SILENT_MS + ANSWER_MS - 20, `replaced only after it was silent and unanswered (${replacedMs} ms)`)

  // A link that answers when asked is kept.
  await heard()
  link.probeIfSilent(SILENT_MS, ANSWER_MS)
  await sleep(SILENT_MS + ANSWER_MS + 200)
  assert.equal(served[1]!.pings, 1, "the answering link was asked once")
  assert.equal(served.length, 2, "and kept")

  // Heard from again before it was silent long enough: not asked.
  await heard()
  link.probeIfSilent(SILENT_MS, ANSWER_MS)
  await sleep(SILENT_MS / 2)
  await heard()
  await sleep(SILENT_MS + ANSWER_MS)
  assert.equal(served[1]!.pings, 1, "a link heard from since isn't asked")
  assert.equal(served.length, 2, "nor replaced")

  // Reached while heard: answered at once, nothing replaced.
  assert.equal(await link.reach(), true)
  assert.equal(served.length, 2)

  // Dropped, its next try a backoff step away: reached, it connects now and says so.
  served[1]!.socket.terminate()
  await until(() => !link.heard, "the drop is heard")
  assert.equal(await link.reach(), true, "it opened")
  assert.equal(served.length, 3)

  // Closed for a sleep, its next try 30 s away: reached, it connects now, well before then.
  link.quiet()
  await until(() => !link.heard, "the close is heard")
  const hold = setTimeout(() => assert.fail("the reach waited for the 30 s hold"), OPENS_MS)
  assert.equal(await link.reach(), true, "it opened")
  clearTimeout(hold)
  await nextAttached(4)
  assert.equal(served.length, 4)

  // Offline: the try can't open, and says so.
  server.close()
  served[3]!.socket.terminate()
  await until(() => !link.heard, "the drop is heard")
  // The link's timers don't keep a process alive, and with the server closed nothing else does.
  const held = setTimeout(() => assert.fail("the try never said"), 2_000)
  assert.equal(await link.reach(), false, "it couldn't open")
  clearTimeout(held)

  console.log("Cloud link: a send into a link heard from recently asks it once it's silent long enough; unanswered, it's replaced; reached, a link that's down tries at once and says whether it opened")
} finally {
  link.stop()
  for (const connection of served) connection.socket.terminate()
  server.close()
}

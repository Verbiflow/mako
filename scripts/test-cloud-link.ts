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

/** A half-open socket can still receive unrelated traffic; only its pong settles a heartbeat. */
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
  Reflect.set(globalThis, "WebSocket", Socket)
  let detached = 0
  const link = new CloudLink({
    name: "account", url: new URL("http://127.0.0.1/fixture"), token: async () => "fixture",
    refused: () => {}, removed: () => {}, signedIn: () => true, onState: () => {},
    attach: () => ({ close: () => { detached += 1 } }),
    heartbeat: { everyMs: 100, timeoutMs: 50 },
  })
  try {
    link.start()
    await advance(0)
    const first = Socket.all[0]!
    await advance(100)
    assert.equal(first.pings, 1, "an idle account socket is probed without any outgoing work")
    first.dispatchEvent(new MessageEvent("message", { data: '{"type":"renewed"}' }))
    await advance(49)
    assert.equal(first.readyState, Socket.OPEN, "the pong has its full deadline")
    await advance(1)
    assert.equal(first.readyState, Socket.CLOSED, "unrelated traffic cannot hide a missing pong")
    assert.equal(detached, 1, "the dead attachment ends once")
    await advance(400)
    const second = Socket.all[1]!
    assert.ok(second, "the dead account reconnects without a person or another turn")
    // A stale socket cannot acknowledge the replacement's heartbeat.
    await advance(100)
    first.dispatchEvent(new MessageEvent("message", { data: PONG }))
    await advance(50)
    assert.equal(second.readyState, Socket.CLOSED, "an old pong cannot settle a new socket's probe")
    // This second short-lived connection takes the next backoff step (1 s, with 20% jitter).
    await advance(1_500)
    const healthy = Socket.all[2]!
    healthy.answers = true
    await advance(100)
    await advance(50)
    assert.equal(healthy.readyState, Socket.OPEN, "a timely pong keeps the connection")
    assert.equal(healthy.pings, 1)
    link.stop()
    await advance(5_000)
    assert.equal(Socket.all.length, 3, "Stop cancels heartbeat and reconnect timers")
    const runtime = new CloudLink({
      name: "runtime", url: new URL("http://127.0.0.1/fixture"), token: async () => "fixture",
      refused: () => {}, removed: () => {}, signedIn: () => true, onState: () => {},
      attach: () => ({ close() {} }),
    })
    try {
      runtime.start()
      await advance(0)
      const socket = Socket.all[3]!
      await advance(25_000)
      assert.equal(socket.pings, 1)
      await advance(5_000)
      assert.equal(socket.readyState, Socket.OPEN, "runtime pause recovery retains its existing silence policy")
    } finally { runtime.stop() }
  } finally {
    link.stop()
    Reflect.set(globalThis, "WebSocket", original)
    mock.timers.reset()
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

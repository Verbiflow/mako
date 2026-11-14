import assert from "node:assert/strict"
import { once } from "node:events"
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

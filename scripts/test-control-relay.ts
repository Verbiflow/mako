/**
 * The relay Windows' Local Control joins a client to its worker with (`relayConnection`), and whose processes a
 * run's are (`TableIndex.members`), on any system:
 *
 * - a client that drops before the worker is reached, as it is reached, or after, never leaves an unheard error or
 *   an open handle; whichever side ends takes the other; a worker that can't be reached answers the client;
 * - a process whose recorded parent's pid now names a younger process is that pid's last holder's orphan, not a
 *   member of the younger one's run.
 *
 *   npx tsx scripts/test-control-relay.ts
 */
import assert from "node:assert/strict"
import { once } from "node:events"
import { connect, createServer, type Socket } from "node:net"
import { setTimeout as delay } from "node:timers/promises"
import { relayConnection } from "../packages/control-runtime/src/control-workers.ts"
import { TableIndex, type Row } from "@mako/host/workspaces/process-table"

process.on("uncaughtException", (error) => {
  console.error("FAIL: an unheard error", error)
  process.exit(1)
})

/** A listening TCP server on a port the system picks, and each socket it accepts. */
async function listening(accepted: (socket: Socket) => void) {
  const server = createServer(accepted)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  // SAFETY: a server listening on a TCP port answers its address as an object with its port.
  const { port } = server.address() as { port: number }
  return { server, port }
}

const upstreams: Socket[] = []
const worker = await listening((socket) => {
  upstreams.push(socket)
  socket.on("error", () => undefined)
  socket.on("data", (chunk) => socket.write(`echo:${chunk}`))
})
const reach = (after = 0) => async () => {
  await delay(after)
  const socket = connect(worker.port, "127.0.0.1")
  await once(socket, "connect")
  return socket
}
let refused = 0
let how = reach()
const front = await listening((socket) => relayConnection(socket, how, (left) => { refused += 1; left.end("refused") }))
const client = async () => {
  const socket = connect(front.port, "127.0.0.1")
  socket.on("error", () => undefined)
  await once(socket, "connect")
  return socket
}

// Joined: bytes cross both ways, and the client's leaving closes the worker's side.
const first = await client()
first.write("hi")
assert.equal(String((await once(first, "data"))[0]), "echo:hi")
first.destroy()
await delay(200)
assert.ok(upstreams.every((socket) => socket.destroyed), "the worker's side closed with its client")

// Dropped before the worker is reached, and as it is: nothing unheard, nothing left open.
how = reach(150)
for (let round = 0; round < 25; round += 1) {
  const socket = await client()
  if (round % 2) socket.write("x")
  socket.destroy()
}
how = reach()
for (let round = 0; round < 25; round += 1) (await client()).destroy()
await delay(600)
assert.ok(upstreams.every((socket) => socket.destroyed), "every worker-side connection was closed")
assert.equal(await new Promise((done) => front.server.getConnections((_, count) => done(count))), 0, "no client connection is held")
assert.equal(await new Promise((done) => worker.server.getConnections((_, count) => done(count))), 0, "no worker connection is held")

// The worker's side ending closes the client's.
const held = await client()
held.write("hi")
await once(held, "data")
upstreams.at(-1)!.destroy()
await once(held, "close")

// A worker that can't be reached: the client is answered, not dropped unheard.
how = () => Promise.reject(new Error("no worker"))
const turned = await client()
assert.equal(String((await once(turned, "data"))[0]), "refused")
assert.equal(refused, 1)
turned.destroy()
front.server.close()
worker.server.close()
console.log("ok   the relay: joined both ways, a client dropped at any moment leaves nothing open or unheard, an unreachable worker is answered")

// A run's members by parent: a child older than the process now under its parent's pid isn't that process's.
const row = (pid: number, ppid: number, startedMs: number): Row => ({ pid, ppid, pgid: pid, rssKb: 1, startedMs, command: `p${pid}` })
const rows = [
  row(100, 1, 5_000), // the run's leader, under a pid reused since
  row(200, 100, 6_000), // its child
  row(300, 200, 7_000), // and grandchild
  row(400, 100, 1_000), // an orphan of pid 100's last holder: older than the leader
  row(500, 200, 5_500), // started after the leader but before its recorded parent (pid 200, reused): another's orphan
  row(600, 500, 8_000), // that orphan's child
]
const members = new TableIndex(rows, 1).members({ pid: 100, startedMs: 5_000 }).map((member) => member.pid).sort((a, b) => a - b)
assert.deepEqual(members, [100, 200, 300], "only processes that started after each parent on the way are the run's")
console.log("ok   a run's members: a stale parent's orphan, under a reused pid, isn't pulled in")
console.log("PASS: the control relay and process-tree membership")

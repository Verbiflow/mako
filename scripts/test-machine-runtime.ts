/**
 * The host as a cloud machine's runtime, against a fake gateway over a real WebSocket, with the test playing the
 * machine's agent on the other end of its channel: linking with a credential, operations for the Thread answered
 * through the host's dispatcher, the host's events delivered as the Thread's in order and once across a dropped
 * connection, an oversized live batch sent as the notice to read it, a clock jump reported, an unlink silencing it,
 * and a restarted host numbering after what it reserved.
 */
import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { duplexPair } from "node:stream"
import { after, test } from "node:test"
import { WebSocketServer, type WebSocket as ServerSocket } from "ws"
import { z } from "zod"
import { PING, PONG, SUBPROTOCOL, decodeRuntimeFrame, encodeGatewayFrame, offeredCredential, threadStream, type Actor } from "@mako/protocol"
import { createFakeGateway } from "@mako/protocol/fake-gateway"
import { MachineRuntime } from "@mako/host/usage/machine-runtime"
import type { AgentMessage, HostMessage, MachineRuntimeState } from "@mako/host/contracts/machine-agent"
import { hostCallInput, hostOperations, hostReplyValue, toHostOperation } from "@mako/host/contracts/host-operations"
import type { RuntimeEvent } from "@mako/host/contracts/runtime-value"

const scratch = await mkdtemp(join(tmpdir(), "mako-machine-runtime-"))
after(() => rm(scratch, { recursive: true, force: true }))

const RUNTIME = "m-0123456789abcdef.g1"
const CREDENTIAL = `mmc_${"k".repeat(43)}`
const desktop: Actor = { kind: "client", client: "desktop", deviceId: "d-1" }

/** The gateway's runtime route over a fake gateway: the machine credential checked at the upgrade, then frames carried both ways. */
async function machineGateway() {
  const gateway = createFakeGateway()
  const sockets = new Set<ServerSocket>()
  let upgrades = 0
  const started = Date.now()
  /** When each upgrade came, less those within 100 ms of the one before. */
  const attempts: number[] = []
  const server = createServer((_request, response) => response.writeHead(404).end())
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false) })
  server.on("upgrade", (request, socket, head) => {
    upgrades += 1
    const at = Date.now() - started
    if (!attempts.length || at - attempts.at(-1)! > 100) attempts.push(at)
    const path = new URL(request.url ?? "/", "http://gateway").pathname
    if (path !== `/v1/runtimes/${RUNTIME}/connect` || offeredCredential(request.headers["sec-websocket-protocol"]) !== CREDENTIAL) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n")
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.add(ws)
      void gateway.connectRuntime().then((link) => {
        ws.on("message", (data) => {
          const text = String(data)
          if (text === PING) return ws.send(PONG)
          decodeRuntimeFrame(text)
          link.sendUnchecked(text)
        })
        ws.on("close", () => {
          sockets.delete(ws)
          link.close()
        })
        void (async () => {
          for await (const frame of link.frames()) if (ws.readyState === ws.OPEN) ws.send(encodeGatewayFrame(frame))
        })()
      })
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  after(() => {
    for (const socket of sockets) socket.terminate()
    server.close()
  })
  // SAFETY: a server listening on a TCP port, not a pipe, has an AddressInfo address.
  const { port } = server.address() as AddressInfo
  return {
    gateway,
    url: `http://127.0.0.1:${port}`,
    upgrades: () => upgrades,
    attempts: () => attempts,
    connected: () => sockets.size,
    /** The connection drops as a network change would drop it, with no close frame. */
    drop: () => {
      for (const socket of sockets) socket.terminate()
    },
  }
}

/** The machine's agent: its end of the host's channel, and every message the host sent on it. */
function machineAgent(options: { dataRoot: string; now?: () => number }) {
  const [agentEnd, hostEnd] = duplexPair()
  const messages: HostMessage[] = []
  // SAFETY: the host under test writes only HostMessage lines on its channel; the assertions read what it said.
  createInterface({ input: agentEnd }).on("line", (line) => messages.push(JSON.parse(line) as HostMessage))
  const calls: string[] = []
  const runtime = new MachineRuntime({
    agent: hostEnd,
    invoke: async (channel, args, client, _history, correlationId) => {
      calls.push(channel)
      return JSON.stringify({ channel, args, client, correlationId })
    },
    version: "0.0.0-test",
    build: "test",
    dataRoot: options.dataRoot,
    now: options.now ?? Date.now,
  })
  runtime.start()
  after(() => runtime.stop())
  const state = (): MachineRuntimeState | undefined => messages.findLast((message) => message.type === "state")?.state
  return {
    runtime,
    messages,
    calls,
    state,
    tell: (message: AgentMessage) => agentEnd.write(`${JSON.stringify(message)}\n`),
    /** A line no agent of this version sends. */
    tellRaw: (line: string) => agentEnd.write(`${line}\n`),
    until: async (what: string, check: () => boolean, ms = 5_000) => {
      for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 10))) if (check()) return
      assert.fail(`${what} within ${ms} ms; the host said ${JSON.stringify(state())}`)
    },
  }
}

const HostEventLineSchema = z.object({ channel: z.string(), type: z.string().optional(), payload: z.looseObject({ n: z.number().optional() }) })
const AnsweredSchema = z.object({ channel: z.string(), args: z.array(z.string()), client: z.string(), correlationId: z.string() })

const hostEvent = (n: number): RuntimeEvent => ({ type: "machine-test", payload: JSON.stringify({ type: "machine-test", n }) })

/** The Thread's events from its stream that came from the host, decoded as a socket client decodes its lines. */
async function hostEvents(gateway: ReturnType<typeof createFakeGateway>, count: number) {
  const stream = (await gateway.connectClient(desktop)).subscribe({ stream: threadStream("th-1"), after: 0 })
  const seen: Array<z.infer<typeof HostEventLineSchema>> = []
  while (seen.length < count) {
    const line = HostEventLineSchema.safeParse((await stream.next(5_000)).event.decode())
    if (line.success) seen.push(line.data)
  }
  stream.close()
  return seen
}

test("the agent's link makes the host the machine's runtime: the Thread's operations reach its dispatcher, and its events reach the Thread in order, once, across a drop", async () => {
  const cloud = await machineGateway()
  const agent = machineAgent({ dataRoot: join(scratch, "one") })
  await agent.until("the host's hello", () => agent.messages.some((message) => message.type === "hello"))
  agent.tell({ type: "link", gatewayUrl: cloud.url, runtimeId: RUNTIME, credential: CREDENTIAL, machine: "m-0123456789abcdef", generation: 1 })
  await agent.until("enrolled", () => agent.state()?.link === "connected" && agent.state()?.enrolls === 1)
  const generation = await cloud.gateway.assign("th-1", RUNTIME)
  agent.tell({ type: "inspect" })
  await agent.until("running the Thread", () => agent.state()?.threads[0]?.generation === generation)

  const [name, known] = [...hostOperations].find(([, call]) => call.replay === "read")!
  const session = await cloud.gateway.connectClient(desktop)
  const operation = toHostOperation(known.channel, hostCallInput(["a"], false), { id: crypto.randomUUID(), target: { kind: "thread", threadId: "th-1" }, actor: desktop, correlationId: "corr-machine-1", attempt: 1 })
  const answered = AnsweredSchema.parse(JSON.parse(hostReplyValue(await session.call(operation)) ?? "null"))
  assert.deepEqual(answered, { channel: known.channel, args: ["a"], client: "gateway:desktop:d-1", correlationId: "corr-machine-1" }, `${name} ran through the host's dispatcher`)

  agent.runtime.event("event", hostEvent(1))
  await agent.until("the first event acknowledged", () => agent.state()?.threads[0]?.waiting === 0 && agent.state()?.threads[0]?.acked === 1)
  cloud.drop()
  await agent.until("the drop noticed", () => agent.state()?.link !== "connected" || (agent.state()?.enrolls ?? 0) > 1, 30_000)
  agent.runtime.event("event", hostEvent(2))
  agent.runtime.event("terminal", hostEvent(3))
  await agent.until("enrolled again, and everything acknowledged", () => agent.state()?.enrolls === 2 && agent.state()?.threads[0]?.waiting === 0, 15_000)
  const events = await hostEvents(cloud.gateway, 3)
  assert.deepEqual(events.map((event) => [event.channel, event.payload.n]), [["event", 1], ["event", 2], ["terminal", 3]])
  assert.equal(agent.state()?.threads[0]?.lost, 0)

  // Too large for a gateway message: a live batch becomes the notice that its history changed; anything else is dropped and counted.
  const huge = "x".repeat(900_000)
  agent.runtime.event("event", { type: "live-batch", conversation: "c-1", payload: JSON.stringify({ type: "live-batch", batch: { id: "c-1", revision: 7, updates: [huge] } }) })
  agent.runtime.event("event", { type: "other", payload: JSON.stringify({ type: "other", huge }) })
  await agent.until("the notice acknowledged", () => agent.state()?.threads[0]?.acked === 4)
  const [notice] = (await hostEvents(cloud.gateway, 4)).slice(3)
  assert.deepEqual(notice?.payload, { type: "live-batch", batch: { id: "c-1", revision: 7, updates: [], historyChanged: true } })
  assert.deepEqual(agent.state()?.events, { emitted: 4, invalidated: 1, dropped: 1 })

  // Silenced: the link closes and stays closed, and nothing more is sent for the Thread.
  agent.tell({ type: "unlink", reason: "this machine is a copy of another" })
  await agent.until("silent", () => agent.state()?.link === "silent")
  await agent.until("the connection closed", () => cloud.connected() === 0)
  const upgrades = cloud.upgrades()
  agent.runtime.event("event", hostEvent(5))
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  assert.equal(cloud.upgrades(), upgrades, "no connection attempted while silent")
  assert.equal(agent.state()?.unlinked, "this machine is a copy of another")
})

test("a clock that jumps is told to the agent within a second, and counted in the runtime's state", async () => {
  let offset = 0
  const agent = machineAgent({ dataRoot: join(scratch, "two"), now: () => Date.now() + offset })
  await agent.until("the host's hello", () => agent.messages.some((message) => message.type === "hello"))
  offset += 30_000
  await agent.until("the jump reported", () => agent.messages.some((message) => message.type === "resumed"), 3_000)
  const resumed = agent.messages.find((message) => message.type === "resumed")
  assert.ok(resumed?.type === "resumed" && resumed.gapMs >= 29_000, JSON.stringify(resumed))
  await agent.until("counted in its state", () => agent.state()?.resumes === 1)
})

test("a host that restarts numbers its Thread's events after what it reserved, so none is taken for a repeat", async () => {
  const cloud = await machineGateway()
  const dataRoot = join(scratch, "three")
  const first = machineAgent({ dataRoot })
  first.tell({ type: "link", gatewayUrl: cloud.url, runtimeId: RUNTIME, credential: CREDENTIAL, machine: "m-0123456789abcdef", generation: 1 })
  await first.until("enrolled", () => first.state()?.link === "connected")
  const generation = await cloud.gateway.assign("th-1", RUNTIME)
  first.tell({ type: "inspect" })
  await first.until("running the Thread", () => first.state()?.threads[0]?.generation === generation)
  first.runtime.event("event", hostEvent(1))
  await first.until("acknowledged", () => first.state()?.threads[0]?.acked === 1)
  first.runtime.stop()
  cloud.drop()

  // The same machine's host, started again: it claims nothing, and the gateway gives it the Thread under the same generation.
  const second = machineAgent({ dataRoot })
  second.tell({ type: "link", gatewayUrl: cloud.url, runtimeId: RUNTIME, credential: CREDENTIAL, machine: "m-0123456789abcdef", generation: 1 })
  await second.until("enrolled", () => second.state()?.link === "connected")
  second.tell({ type: "inspect" })
  await second.until("running the Thread again", () => second.state()?.threads[0]?.generation === generation)
  second.runtime.event("event", hostEvent(2))
  await second.until("acknowledged", () => second.state()?.threads[0]?.acked === 1)
  assert.ok((second.state()?.threads[0]?.localSeq ?? 0) > 1_000, `numbered ${second.state()?.threads[0]?.localSeq}, after the reserved block`)
  const events = await hostEvents(cloud.gateway, 2)
  assert.deepEqual(events.map((event) => event.payload.n), [1, 2], "the restarted host's event is recorded, not taken for the first")
})

test("an unknown or malformed message from the agent is ignored, and a credential that's refused isn't retried in a hot loop", async () => {
  const cloud = await machineGateway()
  const agent = machineAgent({ dataRoot: join(scratch, "four") })
  agent.tellRaw(JSON.stringify({ type: "launch-missiles" }))
  agent.tellRaw(JSON.stringify({ type: "link", gatewayUrl: "ftp://nope", runtimeId: RUNTIME, credential: CREDENTIAL, machine: "m", generation: 1 }))
  agent.tell({ type: "link", gatewayUrl: cloud.url, runtimeId: RUNTIME, credential: `mmc_${"w".repeat(43)}`, machine: "m-0123456789abcdef", generation: 1 })
  await new Promise((resolve) => setTimeout(resolve, 2_500))
  // Node's WebSocket asks twice for an upgrade the server refuses, so attempts are counted by the requests' spacing.
  const attempts = cloud.attempts()
  assert.ok(attempts.length >= 2 && attempts.length <= 4, `${attempts.length} attempts in 2.5 s, with backoff: ${attempts.join(", ")} ms`)
  assert.ok(attempts.every((at, index) => index === 0 || at - attempts[index - 1]! >= 350), `spaced by the backoff: ${attempts.join(", ")} ms`)
  assert.notEqual(agent.state()?.link, "connected")
})

import assert from "node:assert/strict"
import { createServer, type ServerResponse } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { HostLiveness, type HostConnectionEvent, type HostProbe } from "@mako/host/contracts/host-liveness"
import { invokeWithRecovery } from "@mako/host/contracts/host-call-recovery"
import { HOST_CALL_SLOW_UNCONFIRMED_MESSAGE, HostCallTimeoutError, RuntimeDisconnectedError } from "@mako/host/contracts/host-connection"
import { invokeRuntime, probeRuntime, subscribeRuntime } from "@mako/host/transport/connection"

/**
 * A window's connection status follows its host's event stream, never one call's failure
 * (`contracts/host-liveness.ts`). On 2026-10-30 a window showed "Reconnecting to the shared Mako host" for good while
 * its host streamed on: one read reset under a held event loop had been taken as the host leaving, and only a new
 * stream's `ready` could take that back.
 */

const MESSAGE = "fixture outage"

function window(probe: (timeoutMs: number) => Promise<HostProbe>, proofMs = 200) {
  const events: HostConnectionEvent["type"][] = []
  const probes: number[] = []
  const link = new HostLiveness({
    message: MESSAGE,
    announce: (event) => {
      if (event.type === "host-disconnected") assert.equal(event.message, MESSAGE)
      events.push(event.type)
    },
    probe: (timeoutMs) => { probes.push(timeoutMs); return probe(timeoutMs) },
    proofMs,
  })
  return { link, events, probes }
}
const answers = (answer: HostProbe) => async () => answer
const never = () => new Promise<HostProbe>(() => {})

// A dropped call while the stream is open: the host answers the probe, so no banner, the window stays connected and
// the call may run again at once. Calls dropping together share one probe.
{
  const { link, events, probes } = window(answers("alive"))
  const stream = link.stream()
  stream.ready()
  assert.deepEqual(events, [], "the first attach announces nothing")
  const [first, second] = await Promise.all([link.dropped(1_000), link.dropped(1_000)])
  assert.equal(first, true)
  assert.equal(second, true)
  assert.equal(probes.length, 1, "one check for calls that drop together")
  assert.deepEqual(events, [], "a dropped call with a live stream raises no banner")
  assert.equal(link.connected, true)
  assert.equal(await link.whenConnected(10), true)
}

// No probe answer: the stream's heartbeat is the proof.
{
  const { link, events } = window(never, 5_000)
  const stream = link.stream()
  stream.ready()
  const dropped = link.dropped(5_000)
  await delay(20)
  stream.heard()
  assert.equal(await dropped, true)
  assert.deepEqual(events, [])
  assert.equal(link.connected, true)
}

// The stream itself ends: the banner, once, whatever else noticed; then the next stream's ready clears it.
{
  const { link, events } = window(answers("alive"))
  const stream = link.stream()
  stream.ready()
  const dropped = link.dropped(2_000)
  stream.ended()
  stream.ended()
  assert.deepEqual(events, ["host-disconnected"])
  assert.equal(link.connected, false)
  await delay(10)
  const next = link.stream()
  stream.heard()
  stream.ready()
  assert.equal(link.connected, false, "a stream that ended says nothing more")
  next.ready()
  assert.equal(await dropped, true, "a call that dropped with the host runs again on the host the window attached to")
  assert.deepEqual(events, ["host-disconnected", "host-reconnected"])
  assert.equal(link.connected, true)
}

// The probe finds no host, or another: the banner goes up at once. When the same stream is heard again, it comes
// down by itself, and calls waiting for the host go on.
{
  const { link, events } = window(answers("absent"))
  const stream = link.stream()
  stream.ready()
  const dropped = link.dropped(2_000)
  await delay(10)
  assert.deepEqual(events, ["host-disconnected"])
  assert.equal(link.connected, false)
  const waiting = link.whenConnected(2_000)
  stream.heard()
  assert.deepEqual(events, ["host-disconnected", "host-reconnected"], "the same stream recovering clears the banner")
  assert.equal(link.connected, true)
  assert.equal(await waiting, true)
  assert.equal(await dropped, true)
}

// Nothing heard and no probe answer within the proof window: a host that is there but says nothing is an outage too,
// until it speaks.
{
  const { link, events } = window(never, 60)
  const stream = link.stream()
  stream.ready()
  assert.equal(await link.dropped(30), false, "the call gives up at its own deadline")
  assert.deepEqual(events, [], "and the window isn't told of an outage before the proof window ends")
  await delay(80)
  assert.deepEqual(events, ["host-disconnected"])
  stream.heard()
  assert.deepEqual(events, ["host-disconnected", "host-reconnected"])
  assert.equal(link.connected, true)
}

// An outage announced before the first attach is cleared by it.
{
  const { link, events } = window(answers("alive"))
  link.stream().ended()
  link.stream().ready()
  assert.deepEqual(events, ["host-disconnected", "host-reconnected"])
}

// A closed window hears nothing more and nothing waits for it.
{
  const { link, events } = window(never, 5_000)
  const stream = link.stream()
  stream.ready()
  const dropped = link.dropped(5_000)
  link.dispose()
  stream.ended()
  assert.equal(await dropped, false)
  assert.equal(await link.dropped(5_000), false)
  assert.deepEqual(events, [])
}
console.log("Host liveness: a dropped call with a live stream raises no banner and keeps the window connected; a stream's end raises it once and a ready or the same stream heard again clears it; a silent host is an outage only after the proof window")

// The same, over a real socket: the desktop's main process wiring (`client-main.ts`), with a fixture host whose
// stream stays up while one call is reset, another is slow, and the stream later ends.
{
  const root = await mkdtemp(join(tmpdir(), "mako-liveness-"))
  const socket = join(root, "host.sock")
  const info = { protocol: 1, instanceId: randomUUID(), pid: process.pid, version: "fixture", methods: ["mako:git-status", "mako:git-commit"] }
  const streams = new Set<ServerResponse>()
  let connections = 0
  let resets = 0
  let rpcs = 0
  let slow = false
  const server = createServer((request, response) => {
    if (request.url === "/health") { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(info)); return }
    if (request.url === "/events") {
      response.writeHead(200, { "content-type": "application/x-ndjson", connection: "close" })
      response.write(`${JSON.stringify({ channel: "ready", runtime: info })}\n`)
      streams.add(response)
      response.once("close", () => streams.delete(response))
      return
    }
    void (async () => {
      for await (const _chunk of request) { /* the call */ }
      rpcs++
      if (slow) return
      if (resets > 0) { resets--; request.socket.destroy(); return }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, value: { answered: rpcs } }))
    })()
  })
  server.on("connection", () => { connections++ })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  const events: HostConnectionEvent["type"][] = []
  const link = new HostLiveness({
    message: MESSAGE,
    announce: (event) => { events.push(event.type) },
    // `askHost` in `client-main.ts`.
    probe: async (timeoutMs) => {
      try {
        const probe = await probeRuntime(socket, { timeoutMs })
        return probe.state === "ready" && probe.info.instanceId === info.instanceId ? "alive" : "absent"
      } catch { return "unknown" }
    },
    proofMs: 2_000,
  })
  let beats = 0
  const attach = () => {
    const stream = link.stream()
    return subscribeRuntime(socket, randomUUID(), (packet) => { if (packet.channel === "ready") stream.ready() }, () => stream.ended(),
      { heard: () => { beats++; stream.heard() } })
  }
  const until = async (predicate: () => boolean, what: string) => {
    const deadline = Date.now() + 3_000
    while (!predicate()) { assert.ok(Date.now() < deadline, what); await delay(5) }
  }
  let unsubscribe = attach()
  const call = (channel: string, timeoutMs?: number) => invokeWithRecovery(channel, (attempt) => invokeRuntime(socket, "fixture", channel, [], attempt, { timeoutMs }), link, 2_000)
  try {
    await until(() => link.connected, "the stream attaches")

    // Each call has a connection of its own: a kept one the host closed while held can't reset the next call.
    const opened = connections
    await call("mako:git-status")
    await call("mako:git-status")
    assert.equal(connections - opened, 2, "no call reuses a kept connection")

    // A read reset under a live stream: no banner, the window stays connected, and the read runs again.
    resets = 1
    const reset = await rejection(invokeRuntime(socket, "fixture", "mako:git-commit", []))
    assert.ok(reset instanceof RuntimeDisconnectedError && reset.unconfirmed, "the transport still reports the reset itself")
    resets = 1
    const read = await call("mako:git-status")
    assert.deepEqual(read, { answered: rpcs }, "the read ran again and answered")
    assert.deepEqual(events, [], "a dropped call with the stream alive raises no banner")
    assert.equal(link.connected, true)

    // A slow read is no outage: it fails as slow, isn't repeated, and the window stays connected.
    slow = true
    const calls = rpcs
    const slowRead = await rejection(call("mako:git-status", 50))
    assert.ok(slowRead instanceof HostCallTimeoutError && !slowRead.unconfirmed)
    const slowCommit = await rejection(call("mako:git-commit", 50))
    assert.ok(slowCommit instanceof HostCallTimeoutError && slowCommit.unconfirmed)
    assert.equal(slowCommit.message, HOST_CALL_SLOW_UNCONFIRMED_MESSAGE, "a slow mutation is unconfirmed, without saying the host left")
    assert.equal(rpcs - calls, 2, "neither slow call was repeated")
    assert.deepEqual(events, [])
    assert.equal(link.connected, true)
    slow = false

    // The host's heartbeat, a bare newline, reaches the link.
    const before = beats
    for (const stream of streams) stream.write("\n")
    await until(() => beats > before, "the heartbeat is heard")

    // The stream really ends: the banner; a new stream's ready clears it.
    for (const stream of streams) stream.destroy()
    await until(() => events.length === 1, "the stream's end is announced")
    assert.deepEqual(events, ["host-disconnected"])
    assert.equal(link.connected, false)
    unsubscribe()
    unsubscribe = attach()
    await until(() => link.connected, "the next stream attaches")
    assert.deepEqual(events, ["host-disconnected", "host-reconnected"])
  } finally {
    unsubscribe()
    link.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
  console.log("Host liveness over the socket: calls use their own connections; a reset read is repeated under a live stream without a banner; slow calls fail as slow, unrepeated; the stream's end raises the banner and the next ready clears it")
}

async function rejection<T>(promise: Promise<T>): Promise<Error> {
  try { await promise } catch (error) { if (error instanceof Error) return error; throw new Error("Rejected with something other than an Error") }
  throw new Error("Expected a rejection")
}

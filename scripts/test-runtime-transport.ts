import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { startWebHost } from "@mako/host/transport/server"
import { invokeRuntime, probeRuntime, runtimeInfo, settleRuntime, subscribeRuntime } from "@mako/host/transport/connection"
import { HostCallTimeoutError, RuntimeDisconnectedError } from "@mako/host/contracts/host-connection"
import { hostCallSchema } from "@mako/host/contracts/host-call-inputs"
import { HOST_CALL_UNCONFIRMED_MESSAGE, HOST_RECONNECTING_MESSAGE } from "@mako/host/contracts/host-connection"
import { encodeRuntimeEvent, runtimeEventLine, splitRuntimeEventLine } from "@mako/host/contracts/runtime-value"
import { runtimeEventRouting, type RuntimePacket } from "@mako/host/contracts/runtime"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"

const root = await mkdtemp(join(tmpdir(), "mako-wire-"))
const socket = join(root, "host.sock")
const a = randomUUID()
const b = randomUUID()
const framesA: unknown[] = []
const framesB: unknown[] = []
const received: unknown[][] = []
const host = await startWebHost(socket, async (channel, args, client) => {
  if (channel === "mako:live-start") hostCallSchema(channel).parse(args)
  received.push(args)
  return JSON.stringify({args,client})
}, async () => new Response("fixture"), undefined, {protocol:1,instanceId:randomUUID(),pid:process.pid,version:"fixture",methods:["mako:echo", "mako:live-start"]})
async function rejection<T>(promise: Promise<T>): Promise<Error> {
  try { await promise } catch (error) { if (error instanceof Error) return error; throw new Error("Rejected with something other than an Error") }
  throw new Error("Expected a rejection")
}
const wait = async (predicate:()=>boolean) => { const end=Date.now()+2000;while(!predicate()){if(Date.now()>end)throw Error("Transport did not settle");await new Promise(resolve=>setTimeout(resolve,5))} }
const closeA = subscribeRuntime(socket,a,(frame)=>framesA.push(frame),()=>{})
const closeB = subscribeRuntime(socket,b,(frame)=>framesB.push(frame),()=>{})
try {
  assert.equal((await runtimeInfo(socket))?.pid,process.pid)
  await wait(()=>framesA.length===1&&framesB.length===1)
  assert.deepEqual(await invokeRuntime(socket,a,"mako:echo",["text",undefined]),{args:["text",null],client:`web:${a}`})
  assert.deepEqual(received.at(-1), ["text", undefined])
  const options = {
    conversationId: randomUUID(),
    threadPath: undefined,
    displayPrompt: undefined,
    modeId: undefined,
    tuning: { model: undefined, options: { fast: false, effort: "" } },
    initialRequest: {
      id: randomUUID(), text: "New conversation",
      attachments: [{ name: "fixture.txt", mimeType: "text/plain", size: 0, data: undefined, path: "/fixture/file" }],
    },
  }
  const original = structuredClone(options)
  const validated = hostCallSchema("mako:live-start").parse(["claude", "/fixture", options])
  await invokeRuntime(socket, a, "mako:live-start", validated)
  assert.deepEqual(received.at(-1), ["claude", "/fixture", {
    conversationId: options.conversationId,
    tuning: { options: { fast: false, effort: "" } },
    initialRequest: { id: options.initialRequest.id, text: "New conversation", attachments: [{ name: "fixture.txt", mimeType: "text/plain", size: 0, path: "/fixture/file" }] },
  }])
  assert.deepEqual(options, original, "Wire encoding must not mutate caller options")
  await invokeRuntime(socket, a, "mako:live-start", hostCallSchema("mako:live-start").parse([
    "claude", "/fixture", { conversationId: options.conversationId, threadPath: undefined, displayPrompt: undefined, modeId: undefined, tuning: undefined, initialRequest: undefined },
  ]))
  assert.deepEqual(received.at(-1), ["claude", "/fixture", { conversationId: options.conversationId }])
  await invokeRuntime(socket, b, "mako:echo", [undefined, null, false, 0, "", { nested: [{ omitted: undefined, retained: null }, undefined], marker: { kind: "absent" } }])
  assert.deepEqual(received.at(-1), [undefined, null, false, 0, "", { nested: [{ retained: null }, null], marker: { kind: "absent" } }])
  const calls = received.length
  await assert.rejects(invokeRuntime(socket, a, "not-a-mako-channel", []))
  await assert.rejects(invokeRuntime(socket, a, "mako:echo", Array.from({ length: 33 }, () => null)))
  await assert.rejects(invokeRuntime(socket, a, "mako:echo", [1n]), TypeError)
  const circular: unknown[] = []
  circular.push(circular)
  await assert.rejects(invokeRuntime(socket, a, "mako:echo", [circular]), TypeError)
  await assert.rejects(invokeRuntime(socket, a, "mako:live-start", ["claude", "/fixture", { conversationId: options.conversationId, modeId: {} }]), /modeId/)
  assert.equal(received.length, calls, "Invalid calls must fail before host dispatch")
  host.event({type:"notice",level:"info",message:"global"})
  host.event({type:"notice",level:"info",message:"private"},`web:${a}`)
  await wait(()=>framesA.length===3&&framesB.length===2)
  assert.deepEqual(framesB.at(-1),{channel:"event",type:"notice",payload:JSON.stringify({type:"notice",level:"info",message:"global"})})
  host.terminal({ type: "output", sessionId: "left", sequence: 1, data: "private terminal" }, `web:${a}`)
  host.terminal({ type: "wake" })
  await wait(() => framesA.length === 5 && framesB.length === 3)
  assert.deepEqual(framesA.at(-2), { channel: "terminal", type: "output", payload: JSON.stringify({ type: "output", sessionId: "left", sequence: 1, data: "private terminal" }) })
  assert.deepEqual(framesB.at(-1), { channel: "terminal", type: "wake", payload: JSON.stringify({ type: "wake" }) })
  console.log("Runtime transport: shared health, exact arguments, distinct clients, global events and targeted workspace delivery verified")
} finally {closeA();closeB();host.close();await rm(root,{recursive:true,force:true})}

// A host that closes with a call in flight answers it instead of resetting the
// socket: the client sees a typed disconnect with the host's own wording, and a
// call made after the close is refused with the plain wording.
{
  const dir = await mkdtemp(join(tmpdir(), "mako-wire-close-"))
  const path = join(dir, "host.sock")
  let finish: (() => void) | undefined
  const closing = await startWebHost(path, () => new Promise((resolve) => { finish = () => resolve(JSON.stringify(null)) }), async () => new Response(""), undefined, { protocol: 1, instanceId: randomUUID(), pid: process.pid, version: "fixture", methods: ["mako:git-status"] })
  const disconnects: string[] = []
  const stream = subscribeRuntime(path, a, () => {}, () => disconnects.push("stream"))
  try {
    const pending = invokeRuntime(path, a, "mako:git-status", [])
    await new Promise((resolve) => setTimeout(resolve, 50))
    closing.close()
    const dropped = await rejection(pending)
    assert.ok(dropped instanceof RuntimeDisconnectedError && dropped.unconfirmed)
    assert.equal(dropped.message, HOST_CALL_UNCONFIRMED_MESSAGE)
    finish?.()
    await wait(() => disconnects.length === 1)
    const refused = await rejection(invokeRuntime(path, a, "mako:git-status", []))
    assert.equal(`${refused.name}: ${refused.message}`, `RuntimeDisconnectedError: ${HOST_RECONNECTING_MESSAGE}`)
    assert.ok(refused instanceof RuntimeDisconnectedError && !refused.unconfirmed)
    assert.equal(await runtimeInfo(path), null, "a closed host no longer reports as healthy")
    console.log("Runtime transport: a closing host answers pending calls explicitly and later calls are refused, never reset")
  } finally { stream(); await rm(dir, { recursive: true, force: true }) }
}

// A health probe against a host that is leaving must never surface a raw
// socket error or pass for an empty socket. The installer polls it every two
// seconds while the host quits; a keep-alive connection reused at the wrong
// moment gets a reset or a 503, and either has to read as "closing".
{
  const dir = await mkdtemp(join(tmpdir(), "mako-wire-probe-"))
  const servers: Server[] = []
  const fixture = (path: string, answer: (respond: () => void, destroy: () => void) => void) =>
    new Promise<Server>((resolve) => {
      const server = createServer((request, response) => {
        answer(
          () => response.writeHead(503, { connection: "close" }).end(),
          () => request.socket.destroy()
        )
      })
      servers.push(server)
      server.listen(path, () => resolve(server))
    })
  try {
    const absent = join(dir, "nobody.sock")
    assert.deepEqual(await probeRuntime(absent), { state: "absent" })
    assert.equal(await runtimeInfo(absent), null)
    const stale = join(dir, "stale.sock")
    await writeFile(stale, "")
    assert.deepEqual(await probeRuntime(stale), { state: "absent" }, "a leftover file where the socket was is nobody's host")

    const refusing = join(dir, "refusing.sock")
    await fixture(refusing, (respond) => respond())
    assert.deepEqual(await probeRuntime(refusing), { state: "closing" }, "a host answering 503 has begun its close")
    const typed = await rejection(runtimeInfo(refusing))
    assert.ok(typed instanceof RuntimeDisconnectedError && !typed.unconfirmed)
    assert.equal(typed.message, HOST_RECONNECTING_MESSAGE)
    const call = await rejection(invokeRuntime(refusing, a, "mako:echo", []))
    assert.ok(call instanceof RuntimeDisconnectedError && !call.unconfirmed, "a 503 never dispatched the call")

    const resetting = join(dir, "resetting.sock")
    await fixture(resetting, (_respond, destroy) => destroy())
    assert.deepEqual(await probeRuntime(resetting), { state: "closing" }, "a reset before any response is a host on its way out")
    assert.ok((await rejection(runtimeInfo(resetting))) instanceof RuntimeDisconnectedError)

    // settle: three farewells, then the host is gone.
    const leaving = join(dir, "leaving.sock")
    let farewells = 0
    const leavingServer = await fixture(leaving, (respond) => {
      farewells += 1
      respond()
      if (farewells === 3) leavingServer.close()
    })
    const settled = await settleRuntime(leaving, { intervalMs: 5 })
    assert.deepEqual(settled, { state: "absent" })
    assert.equal(farewells, 3, "settle keeps probing while the host says goodbye")

    // settle: a host that never finishes closing is reported, not guessed at.
    const stuck = join(dir, "stuck.sock")
    await fixture(stuck, (respond) => respond())
    const started = Date.now()
    assert.deepEqual(await settleRuntime(stuck, { timeoutMs: 60, intervalMs: 5 }), { state: "closing" })
    assert.ok(Date.now() - started >= 60, "settle honours its deadline before giving up")

    // The real host: a probe racing close() reads closing or absent, never throws.
    const racing = join(dir, "racing.sock")
    const host = await startWebHost(racing, async () => JSON.stringify(null), async () => new Response(""), undefined, { protocol: 1, instanceId: randomUUID(), pid: process.pid, version: "fixture", methods: [] })
    assert.equal((await runtimeInfo(racing))?.pid, process.pid)
    host.close()
    const raced = await probeRuntime(racing)
    assert.ok(raced.state === "closing" || raced.state === "absent", `a probe during close() reported ${raced.state}`)
    assert.deepEqual(await settleRuntime(racing, { intervalMs: 5 }), { state: "absent" })
    console.log("Runtime probe: absent, closing (503 and reset), typed disconnects, settling through a farewell, and a bounded refusal verified")
  } finally {
    for (const server of servers) server.close()
    await rm(dir, { recursive: true, force: true })
  }
}

// Typed delivery uncertainty survives both hops, including an RPC timeout: an owner that doesn't answer in time is
// unavailable to its conversation, as `SharedConversations.route` says.
{
  const dir = await mkdtemp(join(tmpdir(), "mako-wire-peer-"))
  const peerSocket = join(dir, "peer.sock")
  const receiverSocket = join(dir, "receiver.sock")
  const conversationId = randomUUID()
  const finishes: (() => void)[] = []
  const peer = await startWebHost(peerSocket, async (channel) => {
    if (channel === "mako:timeout") await new Promise<void>((resolve) => { finishes.push(resolve) })
    throw new RuntimeDisconnectedError(channel !== "mako:refused")
  }, async () => new Response(""))
  const receiver = await startWebHost(receiverSocket, async (channel) => {
    try { await invokeRuntime(peerSocket, a, channel, [], 1, { timeoutMs: 20 }) }
    catch (error) {
      if (error instanceof RuntimeDisconnectedError || error instanceof HostCallTimeoutError) throw new RuntimeDisconnectedError(error.unconfirmed, conversationId)
      throw error
    }
    return undefined
  }, async () => new Response(""))
  try {
    for (const [channel, uncertain] of [["mako:refused", false], ["mako:dropped", true], ["mako:timeout", true]] as const) {
      const error = await rejection(invokeRuntime(receiverSocket, b, channel, []))
      assert.ok(error instanceof RuntimeDisconnectedError)
      assert.equal(error.unconfirmed, uncertain)
      assert.equal(error.conversationId, conversationId)
    }
  } finally {
    for (const finish of finishes) finish()
    receiver.close(); peer.close()
    await rm(dir, { recursive: true, force: true })
  }
  console.log("Two-hop transport: refused, uncertain and timed-out owner calls retain delivery state and conversation identity")
}

// A post-dispatch unreadable reply says nothing about acceptance.
{
  const dir = await mkdtemp(join(tmpdir(), "mako-wire-unreadable-"))
  const path = join(dir, "host.sock")
  let accepted = 0
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the dispatched request */ }
    accepted++
    response.writeHead(200, { "content-type": "application/json" })
    response.end(accepted === 1 ? JSON.stringify({ ok: true, value: "x".repeat(32 * 1024 * 1024 + 1) }) : '{"ok":true,')
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await rejection(invokeRuntime(path, randomUUID(), "mako:live-prompt", [randomUUID(), randomUUID(), "fixture"]))
      assert.ok(error instanceof RuntimeDisconnectedError && error.unconfirmed, "oversized and malformed replies preserve uncertainty")
    }
    assert.equal(accepted, 2)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
  console.log("Desktop transport: oversized and malformed accepted replies remain unconfirmed")
}

// An event line: its header read alone, its payload carried as its producer encoded it, by builds old and new.
{
  const batch = { type: "live-batch", batch: { id: "conversation-1", revision: 3, updates: [{ kind: "text", text: 'says ,"payload": and {"payload":1}' }] } } satisfies HostEvent
  const encoded = encodeRuntimeEvent(batch)
  assert.deepEqual(encoded, { type: "live-batch", conversation: "conversation-1", payload: JSON.stringify(batch) })
  const line = runtimeEventLine("event", encoded)
  assert.ok(line.endsWith("}\n") && !line.slice(0, -1).includes("\n"), "one line")
  assert.deepEqual(JSON.parse(line), { channel: "event", type: "live-batch", conversation: "conversation-1", payload: batch }, "an older reader parses it whole and finds its payload")
  assert.deepEqual(splitRuntimeEventLine(line.slice(0, -1)), { head: '{"channel":"event","type":"live-batch","conversation":"conversation-1"}', payload: JSON.stringify(batch) })

  const spaced = '{ "type" : "notice", "message": "\\u00e9" }'
  const quoted = splitRuntimeEventLine(runtimeEventLine("terminal", { type: 'odd ,"payload": "type', payload: spaced }).slice(0, -1))
  assert.deepEqual(quoted && JSON.parse(quoted.head), { channel: "terminal", type: 'odd ,"payload": "type' }, "a header's own strings can't end it early")
  assert.equal(quoted?.payload, spaced, "the payload crosses byte for byte")

  const older = JSON.stringify({ channel: "event", payload: batch })
  const split = splitRuntimeEventLine(older)
  assert.deepEqual(split, { head: '{"channel":"event"}', payload: JSON.stringify(batch) }, "an older host's line splits the same way")
  assert.deepEqual(runtimeEventRouting({ payload: JSON.stringify(batch) }), { type: "live-batch", conversation: "conversation-1" }, "with no header, the payload says how to route it")
  assert.deepEqual(runtimeEventRouting({ payload: JSON.stringify({ type: "notice", level: "info", message: "m" }) }), { type: "notice", conversation: undefined })
  assert.deepEqual(runtimeEventRouting({ payload: "[1]" }), {})
  assert.equal(splitRuntimeEventLine(JSON.stringify({ channel: "ready", runtime: { payload: 1 } })), null, "a ready line carries no payload")

  const dir = await mkdtemp(join(tmpdir(), "mako-wire-events-"))
  const path = join(dir, "host.sock")
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" })
    response.write(`${JSON.stringify({ channel: "ready" })}\n${older}\n${JSON.stringify({ channel: "terminal", payload: { type: "wake" } })}\n`)
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  const packets: RuntimePacket[] = []
  const close = subscribeRuntime(path, randomUUID(), (packet) => packets.push(packet), () => {})
  try {
    const deadline = Date.now() + 5_000
    while (packets.length < 3) {
      assert.ok(Date.now() < deadline, "an older host's events arrive")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.deepEqual(packets, [
      { channel: "ready" },
      { channel: "event", payload: JSON.stringify(batch) },
      { channel: "terminal", payload: JSON.stringify({ type: "wake" }) },
    ])
  } finally {
    close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
  console.log("Event lines: headers read alone, payloads carried byte for byte, an older host's lines read and routed")
}

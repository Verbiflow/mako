import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { startWebHost } from "../electron/web-host.ts"
import { invokeRuntime, probeRuntime, runtimeInfo, settleRuntime, subscribeRuntime, RuntimeDisconnectedError } from "../electron/runtime-connection.ts"
import { hostCallInputs } from "../electron/contracts/host-call-inputs.ts"
import { HOST_CALL_UNCONFIRMED_MESSAGE, HOST_RECONNECTING_MESSAGE } from "../electron/contracts/host-connection.ts"

const root = await mkdtemp(join(tmpdir(), "mako-wire-"))
const socket = join(root, "host.sock")
const a = randomUUID()
const b = randomUUID()
const framesA: unknown[] = []
const framesB: unknown[] = []
const received: unknown[][] = []
const host = await startWebHost(socket, async (channel, args, client) => {
  if (channel === "mako:live-start") hostCallInputs[channel].parse(args)
  received.push(args)
  return JSON.stringify({ok:true,value:{args,client}})
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
  const validated = hostCallInputs["mako:live-start"].parse(["claude", "/fixture", options])
  await invokeRuntime(socket, a, "mako:live-start", validated)
  assert.deepEqual(received.at(-1), ["claude", "/fixture", {
    conversationId: options.conversationId,
    tuning: { options: { fast: false, effort: "" } },
    initialRequest: { id: options.initialRequest.id, text: "New conversation", attachments: [{ name: "fixture.txt", mimeType: "text/plain", size: 0, path: "/fixture/file" }] },
  }])
  assert.deepEqual(options, original, "Wire encoding must not mutate caller options")
  await invokeRuntime(socket, a, "mako:live-start", hostCallInputs["mako:live-start"].parse([
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
  assert.deepEqual(framesB.at(-1),{channel:"event",payload:{type:"notice",level:"info",message:"global"}})
  console.log("Runtime transport: shared health, exact arguments, distinct clients, global events and targeted workspace delivery verified")
} finally {closeA();closeB();host.close();await rm(root,{recursive:true,force:true})}

// A host that closes with a call in flight answers it instead of resetting the
// socket: the client sees a typed disconnect with the host's own wording, and a
// call made after the close is refused with the plain wording.
{
  const dir = await mkdtemp(join(tmpdir(), "mako-wire-close-"))
  const path = join(dir, "host.sock")
  let finish: (() => void) | undefined
  const closing = await startWebHost(path, () => new Promise((resolve) => { finish = () => resolve(JSON.stringify({ ok: true, value: null })) }), async () => new Response(""), undefined, { protocol: 1, instanceId: randomUUID(), pid: process.pid, version: "fixture", methods: ["mako:git-status"] })
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
    const host = await startWebHost(racing, async () => JSON.stringify({ ok: true, value: null }), async () => new Response(""), undefined, { protocol: 1, instanceId: randomUUID(), pid: process.pid, version: "fixture", methods: [] })
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

// Typed delivery uncertainty survives both hops, including an RPC timeout.
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
      if (error instanceof RuntimeDisconnectedError) throw new RuntimeDisconnectedError(error.unconfirmed, conversationId)
      throw error
    }
    return JSON.stringify({ ok: true })
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

import { registeredHarnessIds } from "./registered-harnesses.ts"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { hostLifecycle } from "@mako/host/base/host-lifecycle"
import { HostCallLifetime } from "@mako/host/transport/call-lifetime"
import { HostMethods } from "@mako/host/transport/methods"
import { HostStopping } from "@mako/host/base/host-stopping"
import { unwatchedWork } from "@mako/host/base/event-loop"
import { RuntimeDisconnectedError } from "@mako/host/contracts/host-connection"
import { runtimeFailure, runtimeFailureError } from "@mako/host/contracts/runtime"
import { waitsFor } from "../src/state/delivery-policy"
import { createFakeGateway } from "@mako/protocol/fake-gateway"
import { gatewayHostCalls, sendWithRepeats } from "@mako/host/contracts/gateway-host-calls"
import { decodeRuntimeValue, encodeRuntimeValue } from "@mako/host/contracts/runtime-value"
import { serveHostThroughGateway } from "@mako/host/transport/gateway"
import { stoppedCallError, HostCallRefusedError } from "@mako/host/transport/call-lifetime"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { SessionMemory } from "@mako/host/threads/session-memory"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const tick = () => new Promise<void>(done => setImmediate(done))

// Every stop joins the first: cleanup runs once and the process ends once.
const cleanup = deferred()
let cleaned = 0, quits = 0
const host = hostLifecycle({
  cleanup: () => { cleaned++; return cleanup.promise },
  exit: () => { quits++ }, log() {}, failed: async error => { throw error },
})
const first = host.stop({ kind: "request", action: "quit" })
assert.equal(host.stop({ kind: "signal", signal: "SIGTERM" }), first, "A later stop joins the first")
await tick(); await tick()
assert.equal(cleaned, 1); assert.equal(quits, 0, "The process ends only after cleanup")
cleanup.resolve(); await first
assert.equal(quits, 1)
assert.deepEqual(host.state(), { kind: "stopped", reason: { kind: "request", action: "quit" }, code: 0 })

// A boot/read started before shutdown can still use its store until it drains.
const lifetime = new HostCallLifetime(), reading = deferred()
let storeOpen = true, completed = false
const read = lifetime.run(async () => { await reading.promise; assert.ok(storeOpen); completed = true })
const drained = lifetime.close().then(() => { storeOpen = false })
await assert.rejects(lifetime.run(async () => { throw Error("must not start") }), /host is stopping/)
await tick(); assert.equal(storeOpen, true)
reading.resolve(); await read; await drained
assert.equal(completed, true); assert.equal(storeOpen, false)

// A person's message sent while the host stops is a disconnect to its client, never a refusal: the outbox keeps it and
// sends it again once the next host answers. One the stopping host refused never ran; one its stop cut may have, and
// is asked again under its ID. As a plain error, the outbox took it as refused for good and handed it back.
{
  const stopping = new HostStopping()
  const methods = new HostMethods({ fixtureDesk: false, route: async () => ({ handled: false }), presentHistory: (value) => value, breadcrumb: () => {}, declaring: async () => {}, work: unwatchedWork, stopping })
  const answering = deferred()
  const ran: string[] = []
  methods.handle("mako:live-prompt", (async (_id: string, requestId: string) => {
    ran.push(requestId)
    if (requestId === "under-way") await new Promise<never>((_resolve, reject) => stopping.signal.addEventListener("abort", () => reject(stopping.signal.reason), { once: true }))
    answering.resolve()
    return null
  }) as never)
  const heard = async (call: Promise<unknown>) => {
    const error = await call.then(() => undefined, (caught: Error) => caught)
    assert.ok(error instanceof RuntimeDisconnectedError, `a disconnect, not ${String(error)}`)
    const client = runtimeFailureError(runtimeFailure(error))
    return { unconfirmed: (client as RuntimeDisconnectedError).unconfirmed, outbox: waitsFor(client) }
  }
  const underWay = methods.invoke("mako:live-prompt", ["c", "under-way", "the long one"])
  await tick()
  const drained = methods.close()
  assert.deepEqual(await heard(methods.invoke("mako:live-prompt", ["c", "after-close", "sent as Mako quits"])), { unconfirmed: false, outbox: "Waiting for Mako to reconnect" }, "refused as the host stops: it never ran, and waits")
  assert.ok(!ran.includes("after-close"), "it never ran")
  await stopping.stop().catch(() => {})
  assert.deepEqual(await heard(underWay), { unconfirmed: true, outbox: "Waiting for Mako to reconnect" }, "cut by the stop: asked again under its ID")
  await drained
}

// Through the gateway, a stopping host answers nothing for a call it didn't run: the gateway keeps a runtime's answer as
// the operation's, so a refusal would be every repeat's for the client's whole 29 s of tries. Left to the link's close,
// the repeat reaches the next host, which runs it.
{
  const gateway = createFakeGateway()
  let stopping = true
  const ran: string[] = []
  const invoke = async (_channel: string, args: unknown[]) => {
    if (stopping) throw stoppedCallError(new HostCallRefusedError())
    ran.push(String(args[1]))
    return encodeRuntimeValue("taken")
  }
  const mac = { runtimeId: "mac", build: "shutdown", invoke }
  const actor = { kind: "client" as const, client: "web" as const, deviceId: "phone" }
  const phone = gatewayHostCalls(await gateway.connectClient(actor), { runtimeId: "mac", actor, history: false })
  let served = await serveHostThroughGateway(await gateway.connectRuntime(), mac)
  const began = Date.now()
  const sent = sendWithRepeats("mako:live-prompt", phone.call("mako:live-prompt", ["c", "sent-as-it-stops", "hello"]), { conversationId: "c", runtime: "mac" })
  await new Promise((done) => setTimeout(done, 50))
  served.close()
  stopping = false
  served = await serveHostThroughGateway(await gateway.connectRuntime(), mac)
  assert.equal(decodeRuntimeValue(await sent), "taken", "the next host takes it")
  assert.deepEqual(ran, ["sent-as-it-stops"], "once")
  assert.ok(Date.now() - began < 5_000, `within a repeat or two, not the whole schedule: ${Date.now() - began} ms`)
  served.close()
}

// Every adapter uses the same awaited close -> ownership-release boundary.
for (const provider of [...registeredHarnessIds(), "future"]) {
  const root = mkdtempSync(join(tmpdir(), "mako-shutdown-")), nativeId = randomUUID()
  const memory = new SessionMemory(join(root, "memory.sqlite"), { pid: process.pid, startedAt: Date.now(), label: "shutdown fixture" })
  const close = deferred(), revoke = deferred()
  let closes = 0, finished = false
  const driver: ProviderLiveDriver = {
    ...noCapabilities,
    resume: fixtureResume(),
    provider, approvalEvidence: { kind: "submission-only", reason: "shutdown fixture" },
    launchEnvironment: { kind: "unavailable", reason: "shutdown fixture" },
    nativeIdentity: { kind: "unavailable", reason: "shutdown fixture" },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    planning: { via: "setting", option: "plan", proposal: "shutdown fixture", feedback: { kind: "next-message", reason: "shutdown fixture" } },
    backgroundStop: { kind: "ends-with-turn", evidence: "shutdown fixture" },
    turnRecovery: { kind: "manual", reason: "shutdown fixture" },
    available: () => true,
    start: async (cwd, options) => ({ id: options.conversationId, harness: provider, cwd, nativeId, status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] }),
    prompt: async () => {}, permission: async () => {}, cancel: async () => {},
    close: async () => { closes++; await close.promise },
    setMode: async () => {},
  }
  const owner = new LiveConversations({ root, appPath: root, memory, driver: () => driver, history: async () => null, emit() {}, revokeTools: () => revoke.promise })
  try {
    const conversationId = randomUUID()
    await owner.start(provider, root, { conversationId })
    const deadline = Date.now() + 2000
    while (owner.snapshot(conversationId)?.session.status !== "ready") {
      assert.ok(Date.now() < deadline, "Fixture startup deadline")
      await tick()
    }
    assert.ok(memory.owns(provider, nativeId, conversationId))
    const stopped = owner.stop()
    assert.equal(owner.stop(), stopped, "Repeated quit must join one shutdown")
    void stopped.then(() => { finished = true })
    await tick(); assert.equal(closes, 1); assert.equal(finished, false)
    close.resolve(); await tick()
    assert.equal(memory.owns(provider, nativeId, conversationId), false)
    assert.equal(finished, false, "Tool revocation must finish before store close")
    revoke.resolve(); await stopped
    memory.close()
    console.log(`${provider}: provider close, ownership release and tool revocation drained before store close`)
  } finally { close.resolve(); revoke.resolve(); await owner.stop(); rmSync(root, { recursive: true, force: true }) }
}
console.log("Repeated stops, in-flight calls and shutdown admission passed")

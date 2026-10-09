import { registeredHarnessIds } from "./registered-harnesses.ts"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { hostLifecycle } from "../electron/host-lifecycle.js"
import { HostCallLifetime } from "../electron/host-call-lifetime.js"
import { LiveConversations } from "../electron/live-conversations.js"
import { SessionMemory } from "../electron/session-memory.js"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.js"
import { NO_NATIVE_EXCLUSION } from "../electron/contracts/execution-context.js"
import { NO_NATIVE_PROMPT_IDENTITY } from "../electron/contracts/native-prompt-identity.js"
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
await assert.rejects(lifetime.run(async () => { throw Error("must not start") }), /shutting down/)
await tick(); assert.equal(storeOpen, true)
reading.resolve(); await read; await drained
assert.equal(completed, true); assert.equal(storeOpen, false)

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

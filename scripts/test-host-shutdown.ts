import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { backgroundLifecycle } from "../electron/background-lifecycle.js"
import { HostCallLifetime } from "../electron/host-call-lifetime.js"
import { LiveConversations } from "../electron/live-conversations.js"
import { SessionMemory } from "../electron/session-memory.js"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.js"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const tick = () => new Promise<void>(done => setImmediate(done))

// A window can cancel between before-quit and will-quit. No stores close then.
const cleanup = deferred()
let cleaned = 0, quits = 0, prevented = 0
const lifecycle = backgroundLifecycle({
  hasActiveWork: () => false, isRestarting: () => false, hide() {},
  cleanup: () => { cleaned++; return cleanup.promise },
  quit: () => { quits++ }, failed: error => { throw error },
})
const event = { preventDefault() { prevented++ } }
lifecycle.beforeQuit(event)
await tick()
assert.equal(cleaned, 0, "A cancelled window close must leave the host usable")
lifecycle.willQuit(event); lifecycle.willQuit(event)
await tick()
assert.equal(cleaned, 1); assert.equal(quits, 0)
cleanup.resolve(); await tick(); await tick()
assert.equal(quits, 1)
lifecycle.willQuit(event)
assert.equal(prevented, 2)

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
for (const provider of ["claude", "codex", "cursor", "grok", "devin", "opencode", "future"]) {
  const root = mkdtempSync(join(tmpdir(), "mako-shutdown-")), nativeId = randomUUID()
  const memory = new SessionMemory(join(root, "memory.sqlite"), { pid: process.pid, startedAt: Date.now(), label: "shutdown fixture" })
  const close = deferred(), revoke = deferred()
  let closes = 0, finished = false
  const driver: ProviderLiveDriver = {
    provider, approvalEvidence: { kind: "submission-only", reason: "shutdown fixture" },
    canResume: true, available: () => true,
    start: async (cwd, options) => ({ id: options.conversationId, harness: provider, cwd, nativeId, status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] }),
    prompt: async () => {}, cancel: async () => {},
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
console.log("Quit cancellation, repeated quit, in-flight calls and shutdown admission passed")

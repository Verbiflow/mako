import assert from "node:assert/strict"
import { mock } from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import { toast } from "sonner"
import { auditId, auditSnapshot } from "./performance-audit-fixtures"
import { RuntimeDisconnectedError } from "../electron/contracts/host-connection"

Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
const { installMockBridge } = await import("../src/dev/mock-bridge")
const { getMako } = await import("../src/lib/bridge")
const { acpStore } = await import("../src/state/acp-state")
const { applyLiveSnapshot, applyLiveBatch, hydrateLive } = await import("../src/state/live-recovery")
installMockBridge()
const notices = mock.method(toast, "error", () => "fixture")
const dismissed = mock.method(toast, "dismiss", () => "fixture")
const sends = mock.method(getMako(), "livePrompt", async () => { throw new Error("Unexpected send") })
const providers = ["claude", "codex", "cursor", "grok", "devin", "opencode"]
try {
  for (const [index, harness] of providers.entries()) {
    const snapshot = auditSnapshot(1, harness)
    snapshot.session.id = auditId(index + 100)
    const id = snapshot.session.id
    applyLiveSnapshot(snapshot)
    const reading = mock.method(getMako(), "liveSnapshot", async () => {
      throw new RuntimeDisconnectedError(true)
    })
    applyLiveBatch({ id, revision: 3, updates: [] })
    await tick()
    for (let i = 0; i < 100; i++) applyLiveBatch({ id, revision: 4 + i, updates: [] })
    await tick()
    assert.equal(reading.mock.callCount(), 2, `${harness}: each burst coalesces into one transient read`)
    assert.equal(notices.mock.callCount(), 0, `${harness}: shared outage has no per-thread toast`)
    assert.equal(acpStore.get().conversations[id]!.blocks.length, snapshot.blocks.length)
    reading.mock.restore()
    const restored = mock.method(getMako(), "liveSnapshot", async () => ({ ...snapshot, revision: 200 }))
    applyLiveBatch({ id, revision: 150, updates: [] })
    await tick()
    assert.equal(acpStore.get().conversations[id]!.revision, 200)
    assert.equal(restored.mock.callCount(), 1, `${harness}: a later batch recovers without an event-stream reconnect`)
    assert.equal(await hydrateLive(id), true, `${harness}: explicit reconnect also retries`)
    restored.mock.restore()
  }
  const id = auditId(100)
  const failure = "Mako could not read the host response: response exceeded its wire limit"
  const reading = mock.method(getMako(), "liveSnapshot", async () => { throw new Error(failure) })
  await hydrateLive(id, true)
  assert.equal(notices.mock.callCount(), 0, "Quiet probe has no visible error")
  await Promise.all([hydrateLive(id), hydrateLive(id)])
  assert.equal(notices.mock.callCount(), 1, "Quiet probe does not consume the first visible failure")
  toast.dismiss(`live-restore:${id}`)
  await hydrateLive(id)
  assert.equal(notices.mock.callCount(), 1, "Dismissed unchanged failure cannot reappear on retry")
  for (let i = 0; i < 100; i++) applyLiveBatch({ id, revision: 202 + i, updates: [] })
  await tick()
  assert.equal(reading.mock.callCount(), 3, "Concurrent callers coalesce and background batches stop retrying")
  const recovered = { ...auditSnapshot(1, "claude"), revision: 500 }
  recovered.session.id = id
  applyLiveSnapshot(recovered)
  assert.ok(dismissed.mock.calls.some((call) => call.arguments[0] === `live-restore:${id}`))
  await hydrateLive(id)
  assert.equal(notices.mock.callCount(), 2, "A new failure after recovery is reported")
  reading.mock.restore()
  const legacy = mock.method(getMako(), "liveSnapshot", async () => {
    throw new Error("Error invoking remote method: Mako's shared host is restarting. This window reconnects on its own.")
  })
  await hydrateLive(auditId(101))
  assert.equal(notices.mock.callCount(), 2, "Older host/IPC disconnect wording is recognized")
  legacy.mock.restore()
  assert.equal(sends.mock.callCount(), 0, "Hydration never resends prompts")
  console.log("PASS: all-six refresh outage, bounded retries, retained content, reconnect, genuine errors, dismissal and legacy IPC")
} finally {
  mock.restoreAll()
  Reflect.deleteProperty(globalThis, "window")
}

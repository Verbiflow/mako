import assert from "node:assert/strict"
import { mock } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LiveConversations } from "../electron/live-conversations"
import { LiveJournal } from "../electron/live-journal"
import type { ProviderLiveDriver } from "../electron/providers/live-driver"
import { auditId, auditSnapshot } from "./performance-audit-fixtures"

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
const { installMockBridge } = await import("../src/dev/mock-bridge")
const { acpStore, acp } = await import("../src/state/acp")
const { applyLiveBatch, hydrateLiveSummaries } =
  await import("../src/state/live-recovery")
const { getMako } = await import("../src/lib/bridge")
const fixture = installMockBridge()
const snapshot = { ...auditSnapshot(10, "claude"), revision: 2 }
fixture.setLiveSnapshot(snapshot)
const reads = mock.method(getMako(), "liveSnapshot", async () => snapshot)
acpStore.set({ activeKey: null, conversations: {} })
hydrateLiveSummaries(
  [{ session: snapshot.session, revision: 1, createdAt: 1 }],
  true
)
applyLiveBatch({
  id: snapshot.session.id,
  revision: 2,
  updates: [{ kind: "text", text: "unseen" }],
})
await tick()
assert.equal(
  reads.mock.callCount(),
  0,
  "Background summaries and text cannot eagerly hydrate history"
)
assert.equal(
  acpStore.get().conversations[snapshot.session.id]?.blocks.length,
  0
)
acp.activate(snapshot.session.id)
await tick()
await tick()
assert.equal(reads.mock.callCount(), 1)
assert.equal(
  acpStore.get().conversations[snapshot.session.id]?.blocks.length,
  snapshot.blocks.length
)
acp.deactivate()
applyLiveBatch({
  id: snapshot.session.id,
  revision: 3,
  updates: [{ kind: "text", id: "text-9", text: " visible after activation" }],
})
assert.equal(
  acpStore.get().conversations[snapshot.session.id]?.projection,
  undefined
)
acp.activate(snapshot.session.id)
assert.ok(
  acpStore
    .get()
    .conversations[snapshot.session.id]?.projection?.messages.at(-1)
    ?.blocks.some(
      (block) =>
        block.type === "text" &&
        block.text.endsWith(" visible after activation")
    )
)
reads.mock.restore()
Reflect.deleteProperty(globalThis, "window")
const root = await mkdtemp(join(tmpdir(), "mako-closed-cache-"))
const closed = mock.method(LiveJournal.prototype, "close")
const driver: ProviderLiveDriver = {
  approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
  provider: "fixture",
  canResume: true,
  available: () => true,
  start: async (cwd, options) => {
    assert.ok(options.conversationId)
    return {
      ...auditSnapshot(1).session,
      harness: "fixture",
      cwd,
      id: options.conversationId,
      status: "ready",
    }
  },
  prompt: async () => {},
  permission: async () => {},
  cancel: async () => {},
  close: async () => {},
  setMode: async () => {},
}
const owner = new LiveConversations({
  root,
  appPath: root,
  driver: () => driver,
  history: async () => null,
  emit: () => {},
})
try {
  for (let index = 1; index <= 11; index++) {
    const id = auditId(index)
    await owner.start("fixture", root, { conversationId: id })
    await tick()
    owner.observe({
      type: "live-update",
      id,
      update: { kind: "text", text: `Saved ${index}` },
    })
    owner.snapshot(id)
    await owner.close(id)
  }
  assert.ok(
    closed.mock.callCount() >= 3,
    "Closed leaf journals are evicted from the warm cache"
  )
  assert.equal(owner.summaries().length, 11)
  assert.ok(
    owner
      .snapshot(auditId(1))
      ?.blocks.some(
        (block) => block.type === "text" && block.text === "Saved 1"
      )
  )
  console.log(
    "Live retention: lazy background history, fresh activation, bounded closed journals, and lossless journal rehydration verified"
  )
} finally {
  owner.stop()
  closed.mock.restore()
  await rm(root, { recursive: true, force: true })
}

import assert from "node:assert/strict"
import { mock } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LiveConversations } from "../electron/live-conversations"
import { LiveJournal } from "../electron/live-journal"
import type { ProviderLiveDriver } from "../electron/providers/live-driver"
import type { LiveSnapshot } from "../electron/shared"
import { NO_NATIVE_EXCLUSION } from "../electron/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "../electron/contracts/native-prompt-identity"
import { auditId, auditSnapshot } from "./performance-audit-fixtures"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"
import { liveContentWeight, residencyPlan } from "../electron/contracts/residency"

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
const { installMockBridge } = await import("../src/dev/mock-bridge")
const { acpStore, acp } = await import("../src/state/acp")
const { applyLiveBatch, applyLiveSnapshot, hydrateLiveSummaries } =
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

// The rule both the host and the window keep conversations in memory by.
const fits = residencyPlan([
  { id: "a", usedAt: 1, weight: 10, pinned: false },
  { id: "b", usedAt: 2, weight: 10, pinned: false },
], { bytes: 100, recent: 0 })
assert.deepEqual(fits.evict, [], "Under budget nothing goes")
const tight = residencyPlan([
  { id: "running", usedAt: 0, weight: 60, pinned: true },
  { id: "old-small", usedAt: 1, weight: 10, pinned: false },
  { id: "older-big", usedAt: 2, weight: 50, pinned: false },
  { id: "recent", usedAt: 4, weight: 20, pinned: false },
  { id: "middle", usedAt: 3, weight: 20, pinned: false },
], { bytes: 110, recent: 1 })
assert.deepEqual(
  tight.evict,
  ["older-big"],
  "Pinned weight counts, the rest fill the budget newest first, and a smaller older one keeps the room a bigger one could not use"
)
assert.deepEqual([tight.kept, tight.pinned], [110, 60])
const heavy = residencyPlan([
  { id: "recent", usedAt: 2, weight: 500, pinned: false },
  { id: "older", usedAt: 1, weight: 1, pinned: false },
], { bytes: 100, recent: 1 })
assert.deepEqual(heavy.evict, ["older"], "The most recent stays whatever it weighs, and its weight still counts")
const block = { type: "text" as const, id: "text-0", text: "x".repeat(1000) }
const once = liveContentWeight({ blocks: [block] })
assert.ok(once > 2000 && once === liveContentWeight({ blocks: [block] }), "Weight is about twice the JSON and stable")
assert.ok(liveContentWeight({ blocks: [block, { ...block, id: "text-1" }] }) > once, "A new block adds its weight")

const idle = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

// Leaving conversations behind keeps what fits the window's budget and the two
// most recent whatever they weigh; a running one keeps its transcript, opening
// an unloaded one reads it again, and the unloading waits for the window to idle.
const { watchLiveResidency } = await import("../src/state/live-residency")
const conversation = (index: number, status: "ready" | "running") => {
  const made = auditSnapshot(20, "claude")
  return { ...made, session: { ...made.session, id: auditId(100 + index), nativeId: `native-${index}`, status } }
}
const left = [0, 1, 2, 3].map((index) => conversation(index, "ready"))
const working = conversation(4, "running")
const all = [...left, working]
const reread = mock.method(getMako(), "liveSnapshot", async (id: string) => all.find((item) => item.session.id === id) ?? null)
acpStore.set({ activeKey: null, conversations: {} })
for (const item of all) applyLiveSnapshot(item)
const loaded = (id: string) => {
  const held = acpStore.get().conversations[id]
  return held?.hydrated === true && held.blocks.length > 0
}
const roomy = watchLiveResidency()
for (const item of left) {
  acp.activate(item.session.id)
  await tick()
  await tick()
}
await idle()
assert.deepEqual(left.map((item) => loaded(item.session.id)), [true, true, true, true], "Conversations that fit the budget all stay")
roomy()
const stopResidency = watchLiveResidency({ bytes: 0, recent: 2 })
acp.activate(left[0]!.session.id)
assert.deepEqual(left.map((item) => loaded(item.session.id)), [true, true, true, true], "Switching never waits on unloading")
for (const item of left) {
  acp.activate(item.session.id)
  await tick()
  await tick()
}
await idle()
const readsWhileSwitching = reread.mock.callCount()
assert.deepEqual(
  left.map((item) => loaded(item.session.id)),
  [false, true, true, true],
  "Over budget, only the active conversation and the two before it stay loaded"
)
assert.equal(loaded(working.session.id), true, "A running conversation keeps its transcript")
acp.activate(left[0]!.session.id)
await tick()
await tick()
await idle()
assert.equal(reread.mock.callCount(), readsWhileSwitching + 1)
assert.equal(loaded(left[0]!.session.id), true, "Opening an unloaded conversation reads it again")
assert.equal(loaded(left[1]!.session.id), false)
stopResidency()
reread.mock.restore()
Reflect.deleteProperty(globalThis, "window")
const root = await mkdtemp(join(tmpdir(), "mako-closed-cache-"))
const closed = mock.method(LiveJournal.prototype, "close")
const driver: ProviderLiveDriver = {
  ...noCapabilities,
  resume: fixtureResume(),
  approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
  launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
  nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
  nativeExclusion: NO_NATIVE_EXCLUSION,
  nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
  planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
  backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
  turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
  provider: "fixture",
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
let clock = 0
const host = (conversationMemory: { bytes: number; recent: number; sweepMs: number }) =>
  new LiveConversations({
    root,
    appPath: root,
    driver: () => driver,
    history: async () => null,
    emit: () => {},
    now: () => ++clock,
    conversationMemory,
  })
const owner = host({ bytes: 0, recent: 1, sweepMs: 0 })
let restarted: LiveConversations | undefined
try {
  const ids = [1, 2, 3].map(auditId)
  for (const [index, id] of ids.entries()) {
    await owner.start("fixture", root, { conversationId: id })
    await tick()
    owner.observe({ type: "live-update", id, update: { kind: "text", text: `Saved ${index}` } })
    owner.snapshot(id)
  }
  await owner.close(ids[0]!)
  const left = owner.snapshot(ids[0]!)
  await owner.close(ids[1]!)
  await idle()
  assert.deepEqual(
    pick(owner.residency().memory),
    { loaded: 2, unloaded: 1 },
    "Over budget the least recently used goes; the most recent stays, and a connected one cannot go"
  )
  const plain = (value: LiveSnapshot | null) => JSON.parse(JSON.stringify(value))
  assert.deepEqual(plain(owner.snapshot(ids[0]!)), plain(left), "An unloaded conversation comes back exactly as it left")
  await idle()
  assert.deepEqual(pick(owner.residency().memory), { loaded: 2, unloaded: 1 }, "Reading one makes it the most recent")
  assert.equal(owner.summaries().length, 3, "An unloaded conversation is still listed")
  assert.equal(owner.summaries().find((summary) => summary.session.id === ids[1])?.session.status, "closed")
  await owner.stop()

  restarted = host({ bytes: 1024 * 1024 * 1024, recent: 0, sweepMs: 0 })
  for (const id of ids) restarted.snapshot(id)
  await idle()
  assert.deepEqual(pick(restarted.residency().memory), { loaded: 3, unloaded: 0 }, "Under budget nothing goes, closed or ready")
  assert.equal(restarted.snapshot(ids[2]!)?.session.status, "ready")
  assert.ok(
    restarted.snapshot(ids[0]!)?.blocks.some((block) => block.type === "text" && block.text === "Saved 0"),
    "A restart reads what the journal kept"
  )
  assert.ok(closed.mock.callCount() >= 1)
  console.log(
    "Live retention: lazy background history, fresh activation, window and host memory bounded by size and recency at idle, pinned work kept, and exact reload verified"
  )
} finally {
  await owner.stop()
  await restarted?.stop()
  closed.mock.restore()
  await rm(root, { recursive: true, force: true })
}

function pick(memory: { loaded: number; unloaded: number }) {
  return { loaded: memory.loaded, unloaded: memory.unloaded }
}

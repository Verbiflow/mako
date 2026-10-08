import assert from "node:assert/strict"
import { mock } from "node:test"
import { TranscriptReaders, transcriptReaders, liveReadingSource, nativeReadingSource } from "../src/state/transcript-reading"
import { LiveHistoryReader } from "../electron/live-history-reader"
import { auditSnapshot, auditId } from "./performance-audit-fixtures"
import { liveContentWeight } from "../electron/contracts/residency"
import type { LiveSnapshot } from "../electron/contracts/live-conversations"
import type { LiveHistoryRead } from "../electron/contracts/live-history"
import type { ThreadPage, ThreadEntry } from "../src/lib/types"

let now = 100
const readers = new TranscriptReaders(() => now)
const first = readers.attach("chat", "left")
assert.equal(readers.protected("chat"), undefined, "An unmeasured pane protects all content")
const left = { visible: ["old"], nearby: ["before", "after"], anchor: { turn: "old", offset: -42 }, following: false, moving: false, interacting: false }
first.report(left)
const second = readers.attach("chat", "right")
assert.equal(readers.protected("chat"), undefined, "A second unmeasured pane cannot borrow the first pane's position")
second.report({ ...left, visible: ["new"], anchor: { turn: "new", offset: -12 } })
assert.deepEqual(readers.protected("chat"), new Set(["old", "before", "after", "new"]))
first.report({ ...left, interacting: true })
assert.equal(readers.protected("chat"), undefined, "Selection/focus postpones structural eviction")
first.report({ ...left, moving: true })
assert.equal(readers.protected("chat"), undefined, "Momentum/drag postpones structural eviction")
first.report(left)
first.release()
first.report({ ...left, visible: ["late"], anchor: { turn: "late", offset: 0 } })
assert.ok(!readers.protected("chat")?.has("late"), "A retired observer cannot publish")
assert.deepEqual(readers.bookmark("chat", "left"), { anchor: left.anchor, following: false, window: undefined }, "The pane keeps its own measured bookmark without transient interaction state")
assert.equal(readers.warm("chat", "old"), true)
now += 61_000
assert.equal(readers.warm("chat", "old"), false, "Recent visits do not pin old bodies indefinitely")
second.report({ ...left, visible: ["arriving"], moving: true })
second.report({ ...left, visible: ["arriving"] })
assert.equal(readers.usedAt("chat", "arriving"), now, "Settling after motion records the actual visit")
const copying = readers.protect("chat", "copy")
second.release()
assert.ok(readers.protected("chat")?.has("copy"), "An in-flight operation survives pane teardown")
copying()
assert.ok(!readers.protected("chat")?.has("copy"))

Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
const { installMockBridge } = await import("../src/dev/mock-bridge")
installMockBridge()
const { getMako } = await import("../src/lib/bridge")
const { acpStore } = await import("../src/state/acp-state")
const { applyLiveSnapshot, applyLiveBatch } = await import("../src/state/live-recovery")
const { watchLiveResidency } = await import("../src/state/live-residency")
const { loadReleasedLiveTurn } = await import("../src/state/live-history")
const { threadsStore } = await import("../src/state/thread-store")
const { rememberThread, rememberedThread, sweepThreadResidency, loadReleasedThreadTurn, readThreadForPane } = await import("../src/state/thread-viewing")
const { toExchanges } = await import("../src/lib/exchanges")
const { threadToMessages } = await import("../src/lib/foreign-thread")
const { appendOptimisticReply, removeOptimisticReply } = await import("../src/state/thread-queue")
const idle = async () => { for (let n = 0; n < 8; n++) await new Promise(resolve => setTimeout(resolve, 0)) }

const source = auditSnapshot(120, "fixture", 8192, 32)
source.session = { ...source.session, id: auditId(9876), status: "ready" }
source.requests = source.requests.map(request => ({ ...request, status: "completed" }))
source.epoch = "residency"
const host = new LiveHistoryReader()
const snapshot = host.capture(source, { blocks: 0, base: 0 })
applyLiveSnapshot(snapshot)
acpStore.set({ activeKey: source.session.id })
const read = mock.method(getMako(), "liveRead", (id: string, input: LiveHistoryRead) => host.read(id, input, async () => source))
const live = liveReadingSource(source.session.id)
const a = transcriptReaders.attach(live), b = transcriptReaders.attach(live)
const turn = (index: number) => `acp-request-${auditId(index + 1)}`
const initial = acpStore.get().conversations[source.session.id]!
const stop = watchLiveResidency({ bytes: 100_000, recent: 0 })
try {
  await idle()
  assert.equal(acpStore.get().conversations[source.session.id], initial, "Unmeasured active panes cannot be trimmed")
  a.report({ ...left, visible: [turn(20)], nearby: [turn(19), turn(21)], anchor: { turn: turn(20), offset: -42 } })
  b.report({ ...left, visible: [turn(80)], nearby: [turn(79), turn(81)], anchor: { turn: turn(80), offset: -12 }, interacting: true })
  await idle()
  assert.equal(acpStore.get().conversations[source.session.id], initial, "Selection in either pane protects the shared view")
  b.report({ ...left, visible: [turn(80)], nearby: [turn(79), turn(81)], anchor: { turn: turn(80), offset: -12 } })
  await idle()
  let current = acpStore.get().conversations[source.session.id]!
  assert.ok(current.releasedTurns?.length)
  assert.ok(liveContentWeight(current) < liveContentWeight(initial) / 5, "Cold body references are released")
  for (const index of [19, 20, 21, 79, 80, 81, 119]) {
    assert.equal(current.blocks[index * 3 + 2], initial.blocks[index * 3 + 2], `Required turn ${index} remains exact`)
    assert.ok(!current.projection!.exchanges.find(exchange => exchange.id === turn(index))?.unloaded)
  }
  assert.equal(current.projection!.exchanges.length, initial.projection!.exchanges.length, "Navigator identities survive eviction")
  const cold = current.releasedTurns![0]!
  const promise = loadReleasedLiveTurn(source.session.id, cold.id)
  assert.equal(loadReleasedLiveTurn(source.session.id, cold.id), promise, "Concurrent reloads share one read")
  await promise
  current = acpStore.get().conversations[source.session.id]!
  const reopened = current.projection!.exchanges.find(exchange => exchange.id === cold.id)!
  assert.equal(reopened.unloaded, undefined)
  assert.equal(reopened.response.at(-1)!.blocks.at(-1)!.type, "text")
  assert.deepEqual(current.blocks.slice(cold.blocks.start, cold.blocks.end), initial.blocks.slice(cold.blocks.start, cold.blocks.end))
  assert.equal(current.revision, initial.revision, "Reload never rewinds controls")
  const older = current.releasedTurns!.find(item => item.blocks.end < source.blocks.length - 3)!
  const protectChanged = transcriptReaders.protect(live, older.id)
  source.revision++
  source.blocks = source.blocks.map((block, index) => index === older.blocks.start + 2 ? { type: "text", text: "Rewritten old answer" } : block)
  applyLiveBatch({ id: source.session.id, revision: source.revision, epoch: source.epoch, changedFrom: older.blocks.start + 2,
    blockCount: source.blocks.length, updates: [{ kind: "text", id: `text-${Math.floor(older.blocks.start / 3)}`, text: "changed" }] })
  await idle()
  assert.deepEqual(acpStore.get().conversations[source.session.id]!.blocks[older.blocks.start + 2], source.blocks[older.blocks.start + 2],
    "A mutation to released coordinates reacquires coherent history rather than reducing into tombstones")
  protectChanged()
  const staleTurn = acpStore.get().conversations[source.session.id]!.releasedTurns![0]!
  let unblock: () => void = () => {}
  let captured: () => void = () => {}
  const started = new Promise<void>(resolve => { captured = resolve })
  const gate = new Promise<void>(resolve => { unblock = resolve })
  read.mock.mockImplementationOnce(async (id: string, input: LiveHistoryRead) => {
    const chunk = await host.read(id, input, async () => source)
    captured()
    await gate
    return chunk
  })
  const oldRange = loadReleasedLiveTurn(source.session.id, staleTurn.id)
  await started
  const newer = { ...source, epoch: "replacement-source", revision: source.revision + 1,
    blocks: source.blocks.map((block, index) => index === staleTurn.blocks.start + 2 ? { type: "text" as const, text: "New source answer" } : block) }
  applyLiveSnapshot(host.capture(newer, { blocks: 0, base: 0 }))
  unblock()
  await oldRange
  assert.equal(acpStore.get().conversations[source.session.id]!.epoch, newer.epoch)
  assert.deepEqual(acpStore.get().conversations[source.session.id]!.blocks[staleTurn.blocks.start + 2], newer.blocks[staleTurn.blocks.start + 2],
    "A delayed range from an old source cannot overwrite its replacement")
} finally { stop(); a.release(); b.release(); read.mock.restore() }

const legacy = { ...snapshot, session: { ...snapshot.session, id: auditId(9899) }, history: { ...snapshot.history!, ranges: undefined } }
applyLiveSnapshot(legacy)
acpStore.set({ activeKey: legacy.session.id })
const legacyPane = transcriptReaders.attach(liveReadingSource(legacy.session.id))
legacyPane.report(left)
const stopLegacy = watchLiveResidency({ bytes: 1, recent: 0 })
try {
  await idle()
  assert.equal(acpStore.get().conversations[legacy.session.id]!.releasedTurns, undefined, "Older hosts keep bodies until exact range reads are supported")
} finally { stopLegacy(); legacyPane.release() }

const entries: ThreadEntry[] = Array.from({ length: 50 }, (_, index) => [
  { kind: "user" as const, id: `q-${index}`, text: `Question ${index}` },
  { kind: "assistant" as const, id: `a-${index}`, blocks: [{ type: "text" as const, text: `Answer ${index}: ${"saved ".repeat(1500)}` }] },
]).flat()
const page: ThreadPage = { ref: { path: "residency-native", harness: "fixture", nativeId: "native", revision: "one" },
  entries, start: 0, hasEarlier: false, total: entries.length, checkpoint: 123 }
const native = { ...page, pageStart: 0, totalEntries: page.total }
rememberThread(native)
threadsStore.set({ viewing: native })
const nativeSource = nativeReadingSource(page.ref.path)
const nativePane = transcriptReaders.attach(nativeSource)
const exchanges = toExchanges(threadToMessages(entries))
nativePane.report({ ...left, visible: [exchanges[10]!.id], nearby: [exchanges[9]!.id, exchanges[11]!.id], anchor: { turn: exchanges[10]!.id, offset: -20 } })
const nativeRead = mock.method(getMako(), "pageThread", async (_path: string, before = entries.length) => ({ ...page, entries: entries.slice(0, before), total: entries.length }))
try {
  sweepThreadResidency(100_000)
  const trimmed = rememberedThread(page.ref.path)!
  assert.ok(trimmed.releasedTurns?.length)
  assert.equal(trimmed.entries[21], native.entries[21], "The native reader's answer remains exact")
  const released = trimmed.releasedTurns![0]!
  await loadReleasedThreadTurn(page.ref.path, released.id)
  const restored = rememberedThread(page.ref.path)!
  assert.deepEqual(restored.entries.slice(released.base.start, released.base.end), entries.slice(released.base.start, released.base.end))
  assert.equal(threadsStore.get().viewing, restored, "Focused and cached native views have one owner")
  let unblock: () => void = () => {}
  let captured: () => void = () => {}
  const started = new Promise<void>(resolve => { captured = resolve })
  const gate = new Promise<void>(resolve => { unblock = resolve })
  let newestPage = page
  nativeRead.mock.mockImplementation(async () => newestPage)
  nativeRead.mock.mockImplementationOnce(async () => { captured(); await gate; return page })
  const oldRefresh = readThreadForPane(page.ref.path)
  await started
  newestPage = { ...page, ref: { ...page.ref, revision: "rewritten" }, checkpoint: 456,
    entries: entries.map((entry, index) => index === 21 ? { kind: "assistant" as const, id: entry.id,
      blocks: [{ type: "text" as const, text: "New native source answer" }] } : entry) }
  rememberThread({ ...newestPage, pageStart: 0, totalEntries: newestPage.total })
  unblock()
  const fresh = await oldRefresh
  assert.deepEqual(fresh!.entries[21], newestPage.entries[21], "An in-flight refresh retries instead of overwriting a newer shared native view")
  assert.equal(threadsStore.get().viewing, rememberedThread(page.ref.path), "Both native panes still read the same view after the race")
  assert.equal(appendOptimisticReply(page.ref, "Unsent reply"), true)
  assert.equal(threadsStore.get().viewing, rememberedThread(page.ref.path), "Optimistic replies publish to the shared native view")
  await readThreadForPane(page.ref.path)
  const echo = rememberedThread(page.ref.path)!.entries.at(-1)!
  assert.equal(echo.kind === "user" ? echo.text : undefined, "Unsent reply", "A background refresh preserves unsent replies")
  removeOptimisticReply(page.ref, "Unsent reply")
  assert.equal(threadsStore.get().viewing, rememberedThread(page.ref.path), "Rolling back an optimistic reply updates both panes")
} finally { nativePane.release(); nativeRead.mock.restore(); Reflect.deleteProperty(globalThis, "window") }

// Independent large captures exceed the byte target well before the old
// 32-capture count cap. The newest one remains readable; expired ones fail.
const budgeted = new LiveHistoryReader()
let firstToken = ""
let newest: LiveSnapshot = source
for (let index = 0; index < 4; index++) {
  newest = { ...source, session: { ...source.session, id: auditId(20000 + index) },
    blocks: [{ type: "text", text: String(index).repeat(24 * 1024 * 1024) }] }
  const captured = budgeted.capture(newest)
  firstToken ||= captured.history!.token
}
await assert.rejects(budgeted.read(auditId(20000), { kind: "detail", token: firstToken, at: { kind: "live", index: 0 } }, async () => newest), /expired/)
console.log("Transcript residency: per-pane observations, stale observers, recent visits, selection/momentum, operation leases, live/native exact reload, source rewrites, and host byte-budget expiry passed")

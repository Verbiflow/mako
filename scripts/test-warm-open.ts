import assert from "node:assert/strict"
import { mock } from "node:test"
import type { ThreadRef } from "@mako/sessions"
import type { LiveHistoryRead } from "@mako/host/contracts/live-history"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import { auditId, auditSnapshot } from "./performance-audit-fixtures"

/**
 * Opening a conversation costs what changed since it was last drawn, and one read. A conversation that took batches
 * while another was shown draws only what they changed when it's opened; a row opened onto a conversation the window
 * holds asks its host once; and one a pane was reading far up opens at its newest page, the place read after.
 */

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const saved = new Map<string, string>()
Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  },
})
const { installMockBridge } = await import("../src/dev/mock-bridge")
const { getMako } = await import("../src/lib/bridge")
const { applyThreads, threads, threadsStore } = await import("../src/state/threads")
const { acp, acpStore } = await import("../src/state/acp")
const { failAroundTheDoor } = await import("./live-door-watch")
const { receivingLive, readingLive } = await import("../src/state/live-door")
failAroundTheDoor(acpStore, receivingLive, readingLive)
const { applyLiveBatch, applyLiveSnapshot, loadEarlierLive, unloadLive } = await import("../src/state/live-recovery")
const { projectAcp } = await import("../src/state/live-projection")
const { liveReadingSource, transcriptReaders } = await import("../src/state/transcript-reading")
const { fixtureHarnesses } = await import("../src/dev/harness-fixtures")
installMockBridge()
threadsStore.set({ descriptors: fixtureHarnesses })

const held = (id: string) => {
  const conversation = acpStore.get().conversations[id]
  assert.ok(conversation?.kind === "live")
  return conversation
}

/** Counts every read of these entries' kind, which any conversion of them makes first. */
function watchEntries(entries: readonly { type: string }[]) {
  const reads = { count: 0 }
  for (const entry of entries) {
    const type = entry.type
    Object.defineProperty(entry, "type", { get() { reads.count += 1; return type }, enumerable: true, configurable: true })
  }
  return reads
}

// A conversation that streams while another is shown is drawn, when it's opened, from what it last drew.
{
  const TURNS = 300
  const long = auditSnapshot(TURNS, "claude")
  long.session.id = auditId(700)
  const other = auditSnapshot(2, "claude")
  other.session.id = auditId(701)
  const id = long.session.id
  applyLiveSnapshot(long)
  applyLiveSnapshot(other)
  acp.activate(id, false)
  const shown = held(id).projection
  assert.ok(shown)
  acp.activate(other.session.id, false)
  let revision = long.revision
  const last = long.requests.at(-1)!
  const next = auditId(7000)
  applyLiveBatch({ id, revision: ++revision, updates: [{ kind: "text", id: `text-${TURNS - 1}`, text: " and more" }] })
  applyLiveBatch({ id, revision: ++revision, updates: [], requestChanges: [{ ...last, status: "completed" }], sessionChanges: { status: "ready" } })
  applyLiveBatch({ id, revision: ++revision, requestChanges: [{ id: next, text: "Next", attachments: [], status: "dispatching" }], sessionChanges: { status: "running" },
    updates: [{ kind: "user", requestId: next, text: "Next" }, { kind: "text", id: "next-answer", text: "An" }] })
  for (let batch = 0; batch < 40; batch++) applyLiveBatch({ id, revision: ++revision, updates: [{ kind: "text", id: "next-answer", text: " answer" }] })
  applyLiveBatch({ id, revision: ++revision, updates: [], requestChanges: [{ id: next, text: "Next", attachments: [], status: "completed" }], sessionChanges: { status: "ready" } })
  assert.equal(held(id).revision, revision, "Every batch merged")
  assert.equal(held(id).projection, undefined, "One that isn't shown isn't drawn at each batch")
  assert.equal(held(id).behind, shown, "What it last drew waits for it")
  // Every entry of the turns the batches left alone: all but the last turn it held, and the one that arrived.
  const settled = watchEntries(held(id).blocks.slice(0, (TURNS - 1) * 3))
  acp.activate(id, false)
  const opened = held(id).projection
  assert.ok(opened)
  assert.equal(settled.count, 0, "Opening it reads no entry of a turn its batches didn't change")
  assert.equal(held(id).behind, undefined)
  assert.equal(opened.exchanges.length, TURNS + 1)
  assert.ok(shown.messages.slice(0, -2).every((message, index) => opened.messages[index] === message), "Every unchanged message is the object it was")
  assert.ok(shown.exchanges.slice(0, -1).every((exchange, index) => opened.exchanges[index] === exchange), "Every unchanged turn is the object it was")
  assert.deepEqual(opened, projectAcp({ ...held(id), projection: undefined, behind: undefined }), "What it draws is what the whole conversation projects to")
}

// A row opened onto a conversation this window holds asks its host once: its own read, never its owner's as well.
{
  const cwd = "/Users/you/shop"
  const path = "/Users/you/.claude/projects/-Users-you-shop/warm.jsonl"
  const row: ThreadRef = { harness: "claude", nativeId: "warm", path, cwd, title: "Warm", updatedAt: "2026-10-13T07:04:41.000Z" }
  const other: ThreadRef = { harness: "codex", nativeId: "x1", path: "/Users/you/.codex/sessions/x1.jsonl", cwd, title: "Other", updatedAt: "2026-10-13T07:00:00.000Z" }
  const fixture = auditSnapshot(3, "claude")
  const snapshot: LiveSnapshot = { ...fixture, threadPath: path, session: { ...fixture.session, id: auditId(710), nativeId: "warm", cwd, status: "ready" },
    requests: fixture.requests.map((request) => ({ ...request, status: "completed" as const })) }
  mock.method(getMako(), "pageThread", async () => ({ ref: other, entries: [{ type: "user", id: "u1", text: "hello" }], start: 0, total: 1, hasEarlier: false, checkpoint: 1 }))
  mock.method(getMako(), "previewThread", async () => null)
  mock.method(getMako(), "followThread", async () => {})
  mock.method(getMako(), "unfollowThread", async () => {})
  mock.method(getMako(), "threadRun", async () => null)
  const reads = mock.method(getMako(), "liveRead", async () => { throw new Error("Unknown Mako host method") })
  const snapshots = mock.method(getMako(), "liveSnapshot", async () => snapshot)
  const owners = mock.method(getMako(), "resolveOwner", async (asked: string) =>
    asked === path ? { transport: "attached" as const, provider: "claude", conversationId: snapshot.session.id, snapshot } : null)
  applyThreads([row, other])
  applyLiveSnapshot(snapshot)
  await threads.view(other)
  await tick()
  const owned = () => owners.mock.calls.filter((call) => call.arguments[0] === path).length
  const asked = () => snapshots.mock.callCount() + owned()
  const before = asked()
  await threads.view(row)
  await tick()
  await tick()
  assert.equal(acpStore.get().activeKey, snapshot.session.id, "The row opens the conversation it's held as")
  assert.equal(owned(), 0, "A conversation the window holds isn't asked of its owner")
  assert.equal(asked() - before, 1, "Opening a held conversation reads one snapshot")
  // One it only lists (after a restart) is read once too, by the same read.
  await threads.view(other)
  await tick()
  assert.ok(unloadLive(snapshot.session.id))
  const listed = asked()
  await threads.view(row)
  await tick()
  await tick()
  assert.equal(held(snapshot.session.id).hydrated, true)
  assert.equal(asked() - listed, 1, "Opening a listed conversation reads one snapshot")
  assert.equal(owned(), 0)
  reads.mock.restore()
  snapshots.mock.restore()
  owners.mock.restore()
}

// One a pane was last reading far up opens at its newest page; its place is read after, in one read, when the
// transcript restoring it asks for earlier turns.
{
  const fixture = auditSnapshot(4, "claude")
  const id = auditId(720)
  const page = (blockStart: number): LiveSnapshot => ({ ...fixture, epoch: "g1.warmopen00.fixture", revision: 9, session: { ...fixture.session, id, status: "ready" },
    requests: fixture.requests.map((request) => ({ ...request, status: "completed" as const })),
    blocks: fixture.blocks.slice(blockStart),
    history: { token: auditId(730 + blockStart), blockStart, blockEnd: fixture.blocks.length, turnStart: blockStart / 3, earlierRequests: [],
      before: blockStart > 0 ? { blocks: blockStart, base: 0 } : null } })
  const asks: LiveHistoryRead[] = []
  let record = 0
  const reads = mock.method(getMako(), "liveRead", async (_id: string, input: LiveHistoryRead) => {
    asks.push(input)
    assert.equal(input.kind, "snapshot", "Only snapshots are read here")
    const data = JSON.stringify(page(input.kind === "snapshot" && input.from ? input.from.blocks : 9))
    return { record: `record-${++record}`, offset: 0, data, next: null, total: data.length }
  })
  // A pane read it from its first block, and wasn't following its end.
  const source = liveReadingSource(id)
  const lease = transcriptReaders.attach(source, "pane")
  lease.report({ visible: ["turn"], nearby: [], anchor: { turn: `acp-request-${auditId(1)}`, offset: 0 }, following: false, moving: false, interacting: false, window: { blocks: 0, base: 0 } })
  lease.release()
  applyLiveSnapshot({ ...page(9), blocks: [], history: undefined })
  assert.ok(unloadLive(id))
  acp.activate(id)
  await tick()
  await tick()
  assert.equal(asks.length, 1, "Opening it reads one snapshot")
  assert.ok(asks[0]?.kind === "snapshot" && asks[0].from === undefined, "It opens at its newest page, not from where a pane last read")
  assert.equal(held(id).history?.blockStart, 9)
  await loadEarlierLive(id)
  assert.equal(asks.length, 2, "The place is read in one read")
  assert.ok(asks[1]?.kind === "snapshot")
  assert.deepEqual(asks[1].from, { blocks: 0, base: 0 }, "The read reaches back to the remembered place")
  assert.equal(held(id).history?.blockStart, 0)
  assert.equal(held(id).projection?.exchanges.length, 4)
  reads.mock.restore()
}

console.log("PASS: warm open draws only what batches changed, a held conversation is read once, and a remembered place is read after its newest page")

import assert from "node:assert/strict"
import { mock } from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import { LiveHistoryReader } from "@mako/host/conversations/live-history-reader"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import { LiveHistoryReadSchema, type LiveHistoryRead } from "@mako/host/contracts/live-history"
import { SessionIdSchema } from "@mako/host/contracts/thread-identity"
import { LiveUpdateSchema, reduceLiveUpdates } from "@mako/sessions/live-content"
import { auditId, auditSnapshot } from "./performance-audit-fixtures"

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
const idle: Array<() => void> = []
const animation = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame")
const cancelAnimation = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame")
Object.assign(globalThis, { requestAnimationFrame: (run: () => void) => setTimeout(run, 16), cancelAnimationFrame: clearTimeout })
const idleCallback = Object.getOwnPropertyDescriptor(globalThis, "requestIdleCallback")
Object.defineProperty(globalThis, "requestIdleCallback", { configurable: true, value: (run: IdleRequestCallback) => {
  idle.push(() => run({ didTimeout: false, timeRemaining: () => 50 }))
  return idle.length
} })
const { installMockBridge } = await import("../src/dev/mock-bridge")
const { getMako } = await import("../src/lib/bridge")
const { acpStore } = await import("../src/state/acp-state")
const { hydrateLive, applyLiveBatch, applyLiveSnapshot, listLive, recaptureLive, unlistLive } = await import("../src/state/live-recovery")
const { loadReleasedLiveTurn } = await import("../src/state/live-history")
const { watchLiveResidency } = await import("../src/state/live-residency")
const { readingLive } = await import("../src/state/live-door")
const { liveReadingSource, transcriptReaders } = await import("../src/state/transcript-reading")
installMockBridge()

interface Fixture {
  source: LiveSnapshot
  reader: LiveHistoryReader
  calls: LiveHistoryRead[]
  reply?: (input: LiveHistoryRead) => Promise<void>
  failSnapshot?: boolean
}
const fixtures = new Map<string, Fixture>()
const bridge = mock.method(getMako(), "liveRead", async (id: string, input: LiveHistoryRead) => {
  const fixture = fixtures.get(id)
  assert.ok(fixture)
  fixture.calls.push(input)
  if (input.kind === "snapshot" && fixture.failSnapshot) throw new Error("Fixture recapture unavailable")
  const result = await fixture.reader.read(id, input, async () => fixture.source)
  await fixture.reply?.(input)
  return result
})
let sequence = 91_000
const current = (fixture: Fixture) => {
  const held = acpStore.get().conversations[fixture.source.session.id]
  assert.ok(held?.kind === "live" && held.history)
  return held
}
function gate(fixture: Fixture, kind: LiveHistoryRead["kind"], count = 1) {
  const arrived = Promise.withResolvers<void>()
  const held: Array<ReturnType<typeof Promise.withResolvers<void>>> = []
  fixture.reply = async (input) => {
    if (input.kind !== kind || held.length >= count) return
    const part = Promise.withResolvers<void>()
    held.push(part)
    if (held.length === count) arrived.resolve()
    await part.promise
  }
  return { arrived: arrived.promise, release: (index = 0) => held[index]!.resolve() }
}
async function released(defaultBudget = false) {
  const answer = defaultBudget ? 1024 * 1024 : 2048
  const output = defaultBudget ? 4 * 1024 * 1024 : 4096
  const source: LiveSnapshot = { ...auditSnapshot(2, "claude", answer, output), epoch: "g1.restore00.one" }
  source.session = { ...source.session, id: auditId(sequence++) }
  source.sessionId = SessionIdSchema.parse(auditId(sequence++))
  const fixture: Fixture = { source, reader: new LiveHistoryReader(), calls: [] }
  fixtures.set(source.session.id, fixture)
  assert.ok(await hydrateLive(source.session.id))
  acpStore.set({ activeKey: source.session.id })
  const token = current(fixture).history!.token
  const next = auditSnapshot(5, "claude", answer, output)
  const updates = LiveUpdateSchema.array().parse(next.blocks.slice(6).map(({ type, ...entry }) => ({ kind: type, ...entry })))
  fixture.source = { ...source, revision: 2, requests: next.requests, blocks: reduceLiveUpdates(source.blocks, updates) }
  applyLiveBatch({ id: source.session.id, epoch: source.epoch, revision: 2, requests: next.requests,
    updates, changedFrom: 6, blockCount: fixture.source.blocks.length })
  assert.equal(current(fixture).history!.token, token, "streaming keeps the original six-block capture")
  const readingSource = liveReadingSource(source.session.id)
  const paneKey = `released-turn-${source.session.id}`
  const pane = transcriptReaders.attach(readingSource, paneKey)
  const newest = current(fixture).projection!.exchanges.at(-1)!.id
  pane.report({ visible: [newest], nearby: [], following: false, moving: false, interacting: false,
    anchor: { turn: newest, offset: 37 }, window: { blocks: current(fixture).history!.blockStart, base: 0 } })
  const bookmark = transcriptReaders.bookmark(readingSource, paneKey)
  const stop = defaultBudget ? watchLiveResidency() : watchLiveResidency({ bytes: 1e9, recent: 2 }, 0)
  try {
    for (let turn = 0; idle.length && turn < 100; turn++) idle.shift()!()
    assert.equal(idle.length, 0, "the residency sweep settles")
  } finally { stop(); pane.release() }
  const turn = current(fixture).releasedTurns?.find(each => each.blocks.start === 6)
  assert.ok(turn, "actual residency releases the completed streamed turn beyond the capture")
  fixture.calls.length = 0
  return { fixture, turn, token, bookmark, readingSource, paneKey }
}
function complete(fixture: Fixture) {
  const held = current(fixture)
  assert.equal(held.history!.blockStart + held.blocks.length, fixture.source.blocks.length)
  const identities = held.blocks.map(entry => entry.id ?? (entry.type === "user" ? entry.requestId : undefined))
  assert.ok(identities.every(id => id !== undefined))
  assert.equal(new Set(identities).size, identities.length, "restoration never duplicates entries")
  return held
}
try {
  {
    const { fixture, turn, token, bookmark, readingSource, paneKey } = await released(true)
    const start = current(fixture).history!.blockStart
    await loadReleasedLiveTurn(fixture.source.session.id, turn.id)
    const restored = complete(fixture)
    assert.notEqual(restored.history!.token, token)
    assert.equal(restored.releasedTurns?.some(each => each.id === turn.id) ?? false, false)
    assert.ok(restored.history!.blockStart <= start, "the loaded window survives recapture")
    assert.equal(transcriptReaders.bookmark(readingSource, paneKey), bookmark, "the reader's anchor is unchanged")
    assert.ok(fixture.calls.some(input => input.kind === "snapshot" && !input.ifCurrent), "restoration explicitly recaptures")
    assert.deepEqual(restored.requests, fixture.source.requests)
    console.log("PASS: default 24/64 MiB residency restores a streamed turn absent from the original capture")
  }
  for (const change of ["unlisted", "relisted", "session", "epoch", "concurrent"] as const) {
    const { fixture, turn } = await released()
    const id = fixture.source.session.id
    const waiting = gate(fixture, "snapshot")
    const refresh = hydrateLive(id)
    await waiting.arrived
    const restoring = [loadReleasedLiveTurn(id, turn.id)]
    if (change === "concurrent") {
      const other = current(fixture).releasedTurns!.find(each => each.blocks.start === 9)!
      assert.ok(other)
      restoring.push(loadReleasedLiveTurn(id, other.id))
    }
    await tick()
    await tick()
    assert.equal(fixture.calls.filter(input => input.kind === "snapshot").length, 1, "restores wait for the existing hydration")
    if (change === "session" || change === "epoch") {
      fixture.source = { ...fixture.source, revision: 3, ...change === "epoch" ? { epoch: "g2.restore00.two" }
        : { sessionId: SessionIdSchema.parse(auditId(sequence++)) } }
      applyLiveSnapshot(fixture.reader.capture(fixture.source))
    } else {
      unlistLive([id])
      assert.equal(acpStore.get().conversations[id], undefined)
      if (change === "relisted") {
        acpStore.set({ activeKey: null })
        listLive([fixture.source])
      }
    }
    const replacement = acpStore.get().conversations[id]
    waiting.release()
    await Promise.all([refresh, ...restoring])
    assert.equal(Boolean(acpStore.get().conversations[id]), Boolean(replacement), "a restore waiting on hydration must not resurrect an unlisted conversation")
    assert.equal(acpStore.get().conversations[id], replacement, "old restores leave the replacement owner or listing unchanged")
    assert.equal(fixture.calls.filter(input => input.kind === "snapshot" && !input.ifCurrent).length, 0, "retired operations admit no new recapture")
    if (change === "relisted") {
      assert.ok(await hydrateLive(id), "a later explicit open still works for the same ID and Session")
      complete(fixture)
    }
  }
  {
    const { fixture, turn } = await released()
    const id = fixture.source.session.id
    const loading = loadReleasedLiveTurn(id, turn.id)
    unlistLive([id])
    acpStore.set({ activeKey: null })
    listLive([fixture.source])
    const relisted = acpStore.get().conversations[id]
    await loading
    assert.equal(acpStore.get().conversations[id], relisted, "the retirement fence starts before the dynamic-import await")
    assert.equal(fixture.calls.length, 0, "unlist/relist before the first await settles admits no recapture")
  }
  {
    const { fixture, turn } = await released()
    const id = fixture.source.session.id
    const waiting = gate(fixture, "snapshot")
    const refresh = hydrateLive(id)
    await waiting.arrived
    const loading = loadReleasedLiveTurn(id, turn.id)
    await tick()
    const updates = LiveUpdateSchema.array().parse([{ kind: "text", id: "text-4", text: " WHILE WAITING" }])
    fixture.source = { ...fixture.source, revision: 3, blocks: reduceLiveUpdates(fixture.source.blocks, updates) }
    applyLiveBatch({ id, epoch: fixture.source.epoch, revision: 3, updates, changedFrom: 14, blockCount: 15 })
    waiting.release()
    await Promise.all([refresh, loading])
    const restored = complete(fixture)
    const last = restored.blocks.at(-1)
    assert.ok(last?.type === "text" && last.text.endsWith(" WHILE WAITING"), "same-owner streaming during the wait remains authoritative")
    assert.equal(restored.releasedTurns, undefined)
    assert.equal(fixture.calls.filter(input => input.kind === "snapshot" && !input.ifCurrent).length, 1, "a legitimate restore still recaptures after hydration")
    console.log("PASS: pre-read retirement fences unlist/relist, owner changes and concurrent restores while preserving legitimate streaming")
  }
  {
    const { fixture } = await released()
    const id = fixture.source.session.id
    const waiting = gate(fixture, "snapshot")
    let permitted = true
    const capture = recaptureLive(id, () => permitted)
    await waiting.arrived
    const updates = LiveUpdateSchema.array().parse([{ kind: "text", id: "text-4", text: " PAST CAPTURE" }])
    fixture.source = { ...fixture.source, revision: 3, blocks: reduceLiveUpdates(fixture.source.blocks, updates) }
    applyLiveBatch({ id, epoch: fixture.source.epoch, revision: 3, updates, changedFrom: 14, blockCount: 15 })
    const newer = current(fixture)
    permitted = false
    waiting.release()
    await capture
    assert.equal(current(fixture), newer, "revoked authority also refuses a stale snapshot's token-only publication")
  }
  {
    const { fixture } = await released()
    const old = current(fixture).releasedTurns!.find(each => each.blocks.start === 0)!
    assert.ok(old, "a turn from the original capture is released too")
    await loadReleasedLiveTurn(fixture.source.session.id, old.id)
    const restored = complete(fixture)
    const token = restored.history!.token
    const range = { kind: "range" as const, token, from: { blocks: 0, base: 0 }, to: { blocks: 3, base: 0 } }
    await assert.rejects(fixture.reader.read("foreign-conversation", range, async () => fixture.source), /expired/)
    await assert.rejects(fixture.reader.read(fixture.source.session.id,
      { ...range, to: { blocks: fixture.source.blocks.length + 1, base: 0 } }, async () => fixture.source), /Invalid retained history cursor/)
    assert.throws(() => LiveHistoryReadSchema.parse({ ...range, from: { blocks: -1, base: 0 } }))
    console.log("PASS: originally captured turns restore; foreign, malformed and out-of-bounds reads remain refused")
  }
  {
    const { fixture, turn } = await released()
    const waiting = gate(fixture, "snapshot")
    const first = loadReleasedLiveTurn(fixture.source.session.id, turn.id)
    const second = loadReleasedLiveTurn(fixture.source.session.id, turn.id)
    assert.equal(first, second, "duplicate restores share one operation")
    await waiting.arrived
    waiting.release()
    await Promise.all([first, second])
    complete(fixture)
    assert.equal(fixture.calls.filter(input => input.kind === "snapshot").length, 1)
  }
  {
    const { fixture, turn } = await released()
    const other = current(fixture).releasedTurns!.find(each => each.blocks.start === 9)!
    assert.ok(other)
    const waiting = gate(fixture, "snapshot", 2)
    const first = loadReleasedLiveTurn(fixture.source.session.id, turn.id)
    const second = loadReleasedLiveTurn(fixture.source.session.id, other.id)
    await waiting.arrived
    waiting.release(1)
    await second
    waiting.release(0)
    await first
    complete(fixture)
    assert.equal(current(fixture).releasedTurns, undefined)
    console.log("PASS: concurrent and duplicate restores preserve entries under reversed recapture completion")
  }
  for (const change of ["epoch", "session", "unlisted"] as const) {
    const { fixture, turn } = await released()
    const waiting = gate(fixture, "snapshot")
    const loading = loadReleasedLiveTurn(fixture.source.session.id, turn.id)
    await waiting.arrived
    if (change === "unlisted") unlistLive([fixture.source.session.id])
    else {
      fixture.source = { ...fixture.source, revision: 3, ...change === "epoch" ? { epoch: "g2.restore00.two" }
        : { sessionId: SessionIdSchema.parse(auditId(sequence++)) } }
      fixture.reader = new LiveHistoryReader()
      await hydrateLive(fixture.source.session.id)
    }
    const newer = acpStore.get().conversations[fixture.source.session.id]
    waiting.release()
    await loading
    assert.equal(acpStore.get().conversations[fixture.source.session.id], newer, "a late old recapture cannot replace the new owner")
    assert.equal(fixture.calls.filter(input => input.kind === "range").length, 0)
  }
  {
    const { fixture, turn } = await released()
    const snapshot = gate(fixture, "snapshot")
    const loading = loadReleasedLiveTurn(fixture.source.session.id, turn.id)
    await snapshot.arrived
    const updates = LiveUpdateSchema.array().parse([{ kind: "text", id: "text-4", text: " NEWEST" }])
    fixture.source = { ...fixture.source, revision: 3, blocks: reduceLiveUpdates(fixture.source.blocks, updates),
      permissions: [{ id: "new-permission", sessionId: fixture.source.session.id, title: "Allow?", options: [{ optionId: "yes", name: "Allow" }] }] }
    applyLiveBatch({ id: fixture.source.session.id, epoch: fixture.source.epoch, revision: 3, updates,
      changedFrom: 14, blockCount: 15, permissions: fixture.source.permissions })
    const range = gate(fixture, "range")
    snapshot.release()
    await range.arrived
    fixture.source = { ...fixture.source, revision: 4 }
    await hydrateLive(fixture.source.session.id)
    const newer = current(fixture)
    range.release()
    await loading
    assert.equal(current(fixture), newer, "a late old range cannot replace a newer snapshot")
    assert.equal(current(fixture).permission?.id, "new-permission")
    const newest = current(fixture).blocks.at(-1)
    assert.ok(newest?.type === "text" && newest.text.endsWith(" NEWEST"), "later streaming bytes survive the old range reply")
    complete(fixture)
    console.log("PASS: old epoch/session/ownership and late ranges preserve newer controls and history")
  }
  {
    const { fixture, turn, token } = await released()
    fixture.failSnapshot = true
    await assert.rejects(loadReleasedLiveTurn(fixture.source.session.id, turn.id), /Fixture recapture unavailable/)
    assert.equal(current(fixture).history!.token, token)
    assert.ok(current(fixture).releasedTurns?.includes(turn))
    assert.equal(fixture.calls.filter(input => input.kind === "range").length, 0, "a failed recapture never falls back to the stale range")
  }
  assert.equal(readingLive(), false, "every operation releases its retirement record")
} finally {
  bridge.mock.restore()
  if (animation) Object.defineProperty(globalThis, "requestAnimationFrame", animation)
  else Reflect.deleteProperty(globalThis, "requestAnimationFrame")
  if (cancelAnimation) Object.defineProperty(globalThis, "cancelAnimationFrame", cancelAnimation)
  else Reflect.deleteProperty(globalThis, "cancelAnimationFrame")
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
  else Reflect.deleteProperty(globalThis, "window")
  if (idleCallback) Object.defineProperty(globalThis, "requestIdleCallback", idleCallback)
  else Reflect.deleteProperty(globalThis, "requestIdleCallback")
}

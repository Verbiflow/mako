import assert from "node:assert/strict"
import { mock, test } from "node:test"
import type { LiveBatch } from "@mako/host/contracts/live-conversations"
import { auditId, auditSnapshot } from "./performance-audit-fixtures"

Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
const { acpStore, railAcpStore } = await import("../src/state/acp-state")
const { applyLiveAhead, applyLiveBatch, applyLiveSnapshot } = await import("../src/state/live-recovery")
const { everyWhileShown, setWindowShown, windowShown } = await import("../src/lib/window-shown")
const { followWindowShown } = await import("../src/state/window-hidden")

/**
 * A window nobody can see (AGENTS.md, "The hot path"): it takes every batch in, so nothing is lost and its revisions
 * stay continuous, and does nothing that only serves drawing. No projection, no text said ahead, no clock. Shown
 * again, it draws once and holds what a window that was visible throughout holds.
 */

const ID = auditId(900)
const WORDS = 40

const text = (revision: number): LiveBatch => ({ id: ID, revision, updates: [{ kind: "text", text: ` word-${revision}` }] })

function open(): number {
  setWindowShown(true)
  acpStore.set({ activeKey: null, conversations: {} })
  const snapshot = auditSnapshot(1, "claude")
  snapshot.session.id = ID
  applyLiveSnapshot(snapshot)
  acpStore.set({ activeKey: ID })
  return snapshot.revision
}

function held() {
  const conversation = acpStore.get().conversations[ID]
  assert.ok(conversation?.kind === "live", "the conversation is held")
  return conversation
}

/** How often the conversation's projection became another object: each is a pass over its tail and a transcript drawn. */
function projections() {
  let count = 0
  let last = held().projection
  const stop = acpStore.subscribe(() => {
    const now = acpStore.get().conversations[ID]?.projection
    if (now !== last) count += 1
    last = now
  })
  return { count: () => count, stop }
}

/** A turn's stream as the host says it to its own windows: each batch, and the text waiting for the next one, said ahead. */
function stream(from: number): number {
  let revision = from
  for (let word = 0; word < WORDS; word++) {
    revision += 1
    applyLiveBatch(text(revision))
    applyLiveAhead({ id: ID, revision, more: " and" })
    applyLiveAhead({ id: ID, revision, more: " and more" })
  }
  revision += 1
  applyLiveBatch({ id: ID, revision, updates: [], sessionChanges: { status: "ready" } })
  return revision
}

/** The conversation as data, without the moment this window last touched it. */
function settled() {
  const { updatedAt: _touched, ...rest } = held()
  return structuredClone(rest)
}

test("a hidden window takes every batch in and draws none; shown, it holds what a visible window holds", () => {
  const shownFrom = open()
  const seen = projections()
  const shownEnd = stream(shownFrom)
  seen.stop()
  assert.ok(seen.count() >= WORDS, `a visible window draws each batch and each word said ahead: ${seen.count()}`)
  const visible = settled()

  const hiddenFrom = open()
  assert.equal(hiddenFrom, shownFrom)
  setWindowShown(false)
  const before = held().projection
  const unseen = projections()
  let live = 0
  let rail = 0
  const stops = [acpStore.subscribe(() => { live += 1 }), railAcpStore.subscribe(() => { rail += 1 })]
  const hiddenEnd = stream(hiddenFrom)
  assert.equal(hiddenEnd, shownEnd)
  assert.equal(held().revision, hiddenEnd, "every batch was taken in, in order")
  assert.equal(held().blocks.at(-1)?.type, "text")
  assert.equal(unseen.count(), 0, "and none was projected")
  assert.equal(held().projection, before, "the transcript holds the object it last drew, so no row reads anything")
  assert.equal(held().ahead, undefined, "nothing said ahead was kept: it's only for painting")
  assert.equal(live, WORDS + 1, "the store said each batch, and no frame of text said ahead")
  assert.equal(rail, 1, "the rail heard the one fact that moved, the turn ending")
  stops.forEach((stop) => stop())

  const tell = mock.fn(async (_shown: boolean) => true)
  const following = followWindowShown({ windowShown: tell })
  setWindowShown(true)
  following.stop()
  assert.equal(unseen.count(), 1, "shown again, it's drawn once")
  unseen.stop()
  assert.deepEqual(settled(), visible, "and holds exactly what the window that was visible throughout holds")
})

test("a conversation that left the screen while hidden keeps what it drew for when it's opened", () => {
  const from = open()
  setWindowShown(false)
  applyLiveBatch(text(from + 1))
  const stale = held().projection
  acpStore.set({ activeKey: "elsewhere" })
  const following = followWindowShown({})
  setWindowShown(true)
  following.stop()
  assert.equal(held().projection, undefined, "it isn't shown, so it isn't drawn")
  assert.equal(held().behind, stale, "and opens from what it last drew")
})

test("no clock ticks in a hidden window, and each reads once as it comes back", () => {
  setWindowShown(true)
  mock.timers.enable({ apis: ["setInterval"] })
  try {
    let ticks = 0
    const stop = everyWhileShown(1_000, () => { ticks += 1 })
    mock.timers.tick(3_000)
    assert.equal(ticks, 3, "shown: once a second")
    setWindowShown(false)
    mock.timers.tick(60_000)
    assert.equal(ticks, 3, "hidden: a minute passes and nothing fires")
    setWindowShown(true)
    assert.equal(ticks, 4, "back: read at once, so the frame the person sees is current")
    mock.timers.tick(2_000)
    assert.equal(ticks, 6, "and ticking again from there")
    stop()
    mock.timers.tick(5_000)
    setWindowShown(false)
    setWindowShown(true)
    assert.equal(ticks, 6, "stopped, it hears nothing more")
  } finally {
    mock.timers.reset()
  }
})

test("the window tells its host when it hides and shows, again on a new stream, and an older host changes nothing", async () => {
  setWindowShown(true)
  const told: boolean[] = []
  const following = followWindowShown({
    windowShown: async (shown) => {
      told.push(shown)
      return true
    },
  })
  assert.deepEqual(told, [], "a stream starts out shown: nothing to say")
  setWindowShown(false)
  assert.deepEqual(told, [false])
  following.renewed()
  assert.deepEqual(told, [false, false], "a new stream is told again, since it starts out shown")
  setWindowShown(true)
  assert.deepEqual(told, [false, false, true])
  following.renewed()
  assert.deepEqual(told, [false, false, true], "a shown window says nothing to a new stream")
  following.stop()

  // A host from before the call refuses it; a bridge from before it has no such call at all.
  const refusing = followWindowShown({ windowShown: async () => { throw new Error("Unknown host call mako:window-shown") } })
  setWindowShown(false)
  setWindowShown(true)
  await new Promise((done) => setImmediate(done))
  refusing.stop()
  const without = followWindowShown({})
  setWindowShown(false)
  assert.equal(windowShown(), false)
  setWindowShown(true)
  without.stop()
})

test("text said ahead of a conversation that isn't on screen sets nothing", () => {
  const from = open()
  acpStore.set({ activeKey: "elsewhere" })
  let live = 0
  const stop = acpStore.subscribe(() => { live += 1 })
  const before = held()
  for (let frame = 1; frame <= 60; frame++) applyLiveAhead({ id: ID, revision: from, more: "word ".repeat(frame) })
  assert.equal(live, 0, "sixty frames a second, and the store said none: it was sixty, each waking every reader of it")
  assert.equal(held(), before, "the conversation is the object it was")
  acpStore.set({ activeKey: ID })
  live = 0
  for (let frame = 1; frame <= 60; frame++) applyLiveAhead({ id: ID, revision: from, more: "word ".repeat(frame) })
  stop()
  assert.equal(live, 60, "on screen, each is drawn")
  assert.equal(held().ahead?.more, "word ".repeat(60))
})

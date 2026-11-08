import assert from "node:assert/strict"
import { setImmediate as turn } from "node:timers/promises"
import type { LiveBatch, LiveSnapshot, LiveSummary } from "@mako/host/contracts/live-conversations"

/**
 * One door for what reaches the window about a live conversation (`receiveLive`, `src/state/live-door.ts`). The
 * store's own subscription watches every write (`watchDoor`): a live conversation made, or any field but the window's
 * own changed, while nothing is being taken in through the door, fails, whichever path wrote it. Each way in (a batch,
 * one that waited on a snapshot, a listing, a reconnect's and a boot's summaries, an unlisting, its owner's connection,
 * a snapshot read or an action's answer, an approval's receipt, a recapture, an earlier page, a move's and a return's
 * and a continue's step) is driven here and must change the conversation through it. Then #524's tenth review: a listing
 * that says a newer start while a fresh read is out moves the read, on both bridges, so its answer isn't the last word.
 */
/** The window's bridge: each read waits in turn to be answered, or answers at once with `answer`. */
const reads: ((snapshot: LiveSnapshot) => void)[] = []
let answer: ((id: string) => LiveSnapshot) | undefined
const read = (id: string) => answer ? Promise.resolve(answer(id)) : new Promise<LiveSnapshot>((done) => reads.push(done))
const legacy = { liveSnapshot: read, livePermission: async () => {}, liveEarlier: (id: string) => read(id) }
const framed = {
  ...legacy,
  liveRead: async (id: string) => {
    const data = JSON.stringify(await read(id))
    return { record: "read-response", offset: 0, data, next: null, total: data.length }
  },
}
Object.defineProperty(globalThis, "window", { value: { mako: legacy }, configurable: true, writable: true })
Object.assign(globalThis, { requestAnimationFrame: (run: () => void) => setTimeout(run, 16), cancelAnimationFrame: clearTimeout })
const { acpStore, updateAcpConversation } = await import("../src/state/acp-state")
const recovery = await import("../src/state/live-recovery")
const { receiveLive, receivingLive } = await import("../src/state/live-door")
const { answerLiveApproval } = await import("../src/state/live-approvals")
const { threadMoveStepped, threadReturnStepped } = await import("../src/state/cloud-moves")
const { threadContinueStepped } = await import("../src/state/cloud-continues")
const { watchDoor } = await import("./live-door-watch")

const door = watchDoor(acpStore, receivingLive)
const settle = async () => { for (let wait = 0; wait < 12; wait += 1) await turn() }
// SAFETY: an approval as the window reads it.
const approval = (id: string) => ({ id, observationId: "o", sessionId: "s", title: "Run", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }) as never
const session = (id: string, status: "ready" | "running" = "ready") => ({ id, harness: "codex", cwd: "/fixture", title: "Door", status, connection: "connected" as const, modes: [], currentMode: null, configOptions: [] })
const snapshot = (id: string, epoch: string, revision: number, permissions: never[] = []): LiveSnapshot =>
  ({ session: session(id), epoch, revision, createdAt: 1, blocks: [], requests: [], permissions, base: null, nativeAgents: { agents: [], limited: false } })
const summary = (id: string, epoch: string, revision: number, more: Partial<LiveSummary> = {}): LiveSummary => ({ session: session(id), epoch, revision, createdAt: 1, ...more })
const batch = (id: string, epoch: string, revision: number, more: Partial<LiveBatch> = {}) => ({ id, epoch, revision, updates: [], ...more })
const held = (id: string) => acpStore.get().conversations[id]

/** Drives one way in, which must change the conversation, and through the door alone. */
async function through(what: string, id: string, act: () => void | Promise<void>): Promise<void> {
  const before = held(id)
  await act()
  await settle()
  assert.notEqual(held(id), before, `${what}: changed the conversation`)
  assert.deepEqual(door.strays.splice(0), [], `${what}: went through the door`)
}

// The watch itself: what its host said, written around the door, is caught; through it, it isn't.
{
  const id = "watched"
  recovery.applyLiveSnapshot(snapshot(id, "g1.watchroot.a", 1))
  updateAcpConversation(id, (current) => ({ ...current, sending: true }))
  assert.deepEqual(door.strays.splice(0), [], "what only the window says needs no door")
  updateAcpConversation(id, (current) => current.kind === "live" ? { ...current, permission: approval("around") } : current)
  assert.deepEqual(door.strays.splice(0).map(({ key, fields }) => ({ key, fields })), [{ key: id, fields: ["permission"] }], "a host's word written around the door is caught")
  receiveLive(id, { from: "answer" }, () => updateAcpConversation(id, (current) => current.kind === "live" ? { ...current, permission: null } : current))
  assert.deepEqual(door.strays.splice(0), [], "and through it, isn't")
}

// Every way in.
{
  const id = "door", epoch = "g1.doorroot0.a"
  answer = (asked) => snapshot(asked, epoch, held(asked)?.revision ?? 1)
  await through("a snapshot", id, () => recovery.applyLiveSnapshot(snapshot(id, epoch, 1)))
  await through("a batch", id, () => recovery.applyLiveBatch(batch(id, epoch, 2, { session: session(id, "running") })))
  answer = undefined
  // A batch past a gap waits on the read it asks for, then goes on after its answer.
  acpStore.set({ activeKey: id })
  await through("a batch past a gap, the read's answer, and the batch that waited on it", id, async () => {
    recovery.applyLiveBatch(batch(id, epoch, 5, { permissions: [approval("waiting")] }))
    await settle()
    assert.equal(reads.length, 1, "it reads the conversation")
    reads.shift()!(snapshot(id, epoch, 4))
  })
  assert.equal(held(id)?.revision, 5)
  answer = (asked) => snapshot(asked, epoch, held(asked)?.revision ?? 1, [approval("waiting")])
  await through("a recapture", id, () => recovery.recaptureLive(id))
  await through("an approval's receipt", id, async () => {
    recovery.applyLiveBatch(batch(id, epoch, 6))
    // SAFETY: the answer as the approval card sends it; this bridge takes any.
    await answerLiveApproval(id, "waiting", { outcome: "selected", optionId: "allow" } as never)
  })
  await through("an earlier page", id, () => { updateAcpConversation(id, (current) => ({ ...current, sending: false })); answer = (asked) => snapshot(asked, epoch, 7); return recovery.loadEarlierLive(id) })
  acpStore.set({ activeKey: null })
  await through("a reconnect's summary", id, () => recovery.hydrateLiveSummaries([summary(id, epoch, 7, { waitingOn: "Approve" })], true))
  await through("its owner gone", id, () => recovery.markLiveOwnerDisconnected([id]))
  // SAFETY: each step as its host event says it, with only the fields its handler reads for the conversation.
  await through("a move's step", id, () => threadMoveStepped(id, "move-1", { kind: "moved", conversations: [id] } as never))
  // SAFETY: as above.
  await through("a return's step", id, () => threadReturnStepped(id, "move-2", { kind: "back", conversations: [id] } as never))
  // SAFETY: as above.
  await through("a continue's step", id, () => threadContinueStepped(id, "op-1", { kind: "continued", cloudThread: "t-door" } as never))
  await through("a listing", id, () => recovery.listLive([summary(id, epoch, 8, { elsewhere: "another Mac", waitingOn: "Approve: run" })]))
  await through("a boot's summary", "door-boot", () => recovery.hydrateLiveSummaries([summary("door-boot", epoch, 1)]))
  acpStore.set({ activeKey: null })
  await through("an unlisting", id, () => recovery.unlistLive([id]))
  answer = undefined
  reads.length = 0
}

// #524's tenth review: while a fresh read (asked for a reply it couldn't place) is out, a listing says a newer start
// that asks the person. The read no longer speaks alone, so its answer isn't the last word: the listed start is read,
// and its approval shown. On either bridge.
for (const [name, bridge] of [["legacy", legacy], ["framed", framed]] as const) {
  Object.assign(globalThis.window, { mako: bridge })
  const id = `fresh-list-${name}`, held1 = "g1.rootAAAA.a", asked = "g1.rootBBBB.b", newer = "g2.rootBBBB.c"
  acpStore.set({ activeKey: id })
  recovery.applyLiveSnapshot(snapshot(id, held1, 1))
  recovery.applyLiveSnapshot(snapshot(id, asked, 1))
  assert.equal(reads.length, 1, `${name}: a start it can't place is read afresh`)
  recovery.listLive([summary(id, newer, 1, { elsewhere: "another device", waitingOn: "Current approval", attention: { kind: "approval", key: "current-ask" } })])
  reads.shift()!(snapshot(id, asked, 1))
  await settle()
  assert.equal(reads.length, 1, `${name}: the listed start is read`)
  reads.shift()!(snapshot(id, newer, 1, [approval("current-ask")]))
  await settle()
  const now = held(id)
  assert.equal(now?.epoch, newer, `${name}: its start is taken`)
  assert.equal(now?.kind === "live" ? now.permission?.id : undefined, "current-ask", `${name}: and its approval shown`)
  assert.equal(reads.length, 0, `${name}: with nothing more to read`)
  acpStore.set({ activeKey: null })
}
assert.deepEqual(door.strays, [], "nothing went around the door")
console.log("Live door: every way in to a conversation's state goes through one door, a write around it is caught, and a listing during a fresh read is read after it on both bridges")
process.exit(0)

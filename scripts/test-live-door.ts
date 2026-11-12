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
const legacy = { liveSnapshot: read, livePermission: async () => {}, liveEarlier: (id: string) => read(id), liveTransfer: (id: string) => read(id), liveAcknowledgeAction: async () => {}, answerAgentAsk: async (id: string, ask: string, allow: boolean) => { const want = held(id)?.control?.asks?.find(each => each.id === ask)?.want; return want ? { outcome: "answered", ask, allow, want } : { outcome: "missing", ask } },
  // A rewind answers with the fork it makes; a capture, with the conversation that holds its session, which may be one
  // already there.
  liveRewind: (_id: string, input: { id: string }) => read(input.id), liveCapture: (id: string) => read(id),
  liveFork: (_id: string, input: { id: string }) => read(input.id) }
const framed = {
  ...legacy,
  liveRead: async (id: string) => {
    const data = JSON.stringify(await read(id))
    return { record: "read-response", offset: 0, data, next: null, total: data.length }
  },
}
Object.defineProperty(globalThis, "window", { value: { mako: legacy }, configurable: true, writable: true })
Object.assign(globalThis, { requestAnimationFrame: (run: () => void) => setTimeout(run, 16), cancelAnimationFrame: clearTimeout })
const { acpStore, removeAcpConversation, updateAcpConversation } = await import("../src/state/acp-state")
const recovery = await import("../src/state/live-recovery")
const { letGoLive, readingLive, receiveLive, receivingLive } = await import("../src/state/live-door")
const { answerLiveApproval } = await import("../src/state/live-approvals")
const { answerAgentAsk } = await import("../src/state/agent-asks")
const { threadMoveStepped, threadReturnStepped } = await import("../src/state/cloud-moves")
const { threadContinueStepped } = await import("../src/state/cloud-continues")
const { submitTransfer } = await import("../src/state/live-transfers")
const { acp } = await import("../src/state/acp")
const { restorePendingStart } = await import("../src/state/acp-start")
const { acknowledgeLiveAction } = await import("../src/state/live-actions")
const { watchDoor, watchReads } = await import("./live-door-watch")

const door = watchDoor(acpStore, receivingLive)
// Every read of a conversation's snapshot on either bridge, made with no read of it out (`readLive`), is caught.
const bridgeReads = [watchReads(legacy, readingLive), watchReads(framed, readingLive)]
const bypassed = () => bridgeReads.flatMap((watch) => watch.bypasses.splice(0))
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
  assert.deepEqual(bypassed(), [], `${what}: read through the window's one read`)
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
  // A removal counts as a change does: an unlisting around the door is caught, and through it, or as the window's own
  // let-go (the person closed it), isn't.
  removeAcpConversation(id)
  assert.deepEqual(door.strays.splice(0).map(({ key, fields }) => ({ key, fields })), [{ key: id, fields: ["removed"] }], "an unlisting written around the door is caught")
  recovery.applyLiveSnapshot(snapshot(id, "g1.watchroot.a", 2))
  recovery.unlistLive([id])
  recovery.applyLiveSnapshot(snapshot(id, "g1.watchroot.a", 3))
  letGoLive(id, () => removeAcpConversation(id))
  assert.deepEqual(door.strays.splice(0), [], "an unlisting through the door, and the window's own let-go, aren't")
  // And a read: one of a conversation's snapshot made around the window's one read is caught; through it, it isn't.
  answer = (asked) => snapshot(asked, "g1.watchroot.a", 4)
  await legacy.liveSnapshot(id)
  assert.deepEqual(bypassed().map(({ method, asked }) => ({ method, asked })), [{ method: "liveSnapshot", asked: id }], "a read around the window's one read is caught")
  await recovery.readBackLive(id)
  assert.deepEqual(bypassed(), [], "and through it, isn't")
  answer = undefined
  letGoLive(id, () => removeAcpConversation(id))
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
  answer = (asked) => snapshot(asked, epoch, 8)
  // SAFETY: a transfer as the switch sends it; this bridge reads only its id.
  const transfer = { id: "transfer-1", provider: "claude" } as never
  await through("a transfer's answer", id, async () => { await submitTransfer(id, transfer) })
  answer = (asked) => snapshot(asked, epoch, 9)
  await through("an action acknowledged, read back", id, () => acknowledgeLiveAction(id, "action-1"))
  answer = undefined
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

// Agent tool asks (#461) arrive in control alone. Answer receipts use the same guarded read-back on both bridges.
for (const [name, bridge] of [["legacy", legacy], ["framed", framed]] as const) {
  Object.assign(globalThis.window, { mako: bridge })
  const id = `agent-ask-${name}`, epoch = "g1.agentask.a"
  const ask = { id: "move-ask", at: 1, want: { kind: "move" as const, move: "move-1", handsOff: true } }
  const control: NonNullable<LiveSnapshot["control"]> = { activeBindingId: "00000000-0000-4000-8000-000000000001", bindings: [], merges: [], transfers: [], asks: [ask] }
  recovery.applyLiveSnapshot(snapshot(id, epoch, 1))
  await through(`${name}: a control-only agent ask`, id, () => recovery.applyLiveBatch(batch(id, epoch, 2, { control })))
  assert.equal(held(id)?.kind === "live" && held(id)?.control?.asks?.[0]?.id, ask.id)
  answer = (asked) => ({ ...snapshot(asked, epoch, 3), control: { ...control, asks: [] } })
  await through(`${name}: an agent answer read back without its event`, id, async () => { assert.equal(await answerAgentAsk(id, ask, true), true) })
  assert.deepEqual(held(id)?.kind === "live" && held(id)?.control?.asks, [], "the receipt retires the agent ask")
  answer = undefined
  const answering = answerAgentAsk(id, ask, false)
  await settle()
  assert.equal(reads.length, 1, "one read-back, without replaying the answer")
  recovery.unlistLive([id])
  reads.shift()!({ ...snapshot(id, epoch, 4), control: { ...control, asks: [] } })
  await answering
  assert.equal(held(id), undefined, "an agent answer read back after unlisting doesn't recreate its conversation")
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
// #524's twelfth review: a read out of a Session when it's unlisted (a recapture, a read-back) never brings it back,
// on either bridge.
for (const [name, bridge] of [["legacy", legacy], ["framed", framed]] as const) {
  Object.assign(globalThis.window, { mako: bridge })
  for (const kind of ["recapture", "read-back"] as const) {
    const id = `unlisted-${kind}-${name}`, epoch = "g1.unlistroot.a"
    recovery.applyLiveSnapshot(snapshot(id, epoch, 1))
    const reading = kind === "recapture" ? recovery.recaptureLive(id) : recovery.readBackLive(id).then(() => undefined)
    await settle()
    assert.equal(reads.length, 1, `${name}: the ${kind} is out`)
    recovery.unlistLive([id])
    reads.shift()!(snapshot(id, epoch, 2))
    await reading
    await settle()
    assert.equal(held(id), undefined, `${name}: a ${kind} answered after its Session was unlisted doesn't bring it back`)
  }
}
// #524's thirteenth review: a read is of the conversation its answer is about. A rewind answers with the fork it makes,
// so a fork that appears on the stream and is unlisted while the rewind is out isn't brought back by its answer; and a
// read whose answer is about a conversation it didn't name (a capture of a session another conversation holds) is
// weighed by what was unlisted while it was out, as one of the conversation it named is.
Object.assign(globalThis.window, { mako: legacy })
{
  const source = "rewind-source", target = "rewind-target", epoch = "g1.rewindrt.a"
  recovery.applyLiveSnapshot(snapshot(source, epoch, 1))
  // SAFETY: a rewind as its card sends it; this bridge reads only the fork's id.
  const rewinding = acp.rewind(source, { id: target, requestId: "rewind-request", expectedId: "rewind-checkpoint" } as never)
  await settle()
  assert.equal(reads.length, 1, "the rewind is out")
  recovery.applyLiveSnapshot(snapshot(target, epoch, 1))
  recovery.unlistLive([target])
  reads.shift()!(snapshot(target, epoch, 2))
  await rewinding
  await settle()
  assert.equal(held(target), undefined, "the unlisted fork isn't brought back by the rewind's answer")
}
{
  const owner = "capture-owner", captured = "capture-asked", epoch = "g1.captureroot.a"
  recovery.applyLiveSnapshot(snapshot(owner, epoch, 1))
  const capturing = recovery.readLive(captured, () => legacy.liveCapture(captured))
  await settle()
  assert.equal(reads.length, 1, "the capture is out")
  const beside = recovery.readBackLive("capture-beside")
  assert.equal(reads.length, 2, "another keyed read is out beside it")
  recovery.unlistLive([owner])
  reads.pop()!(snapshot("capture-beside", epoch, 1))
  await beside
  // Settling another keyed read must keep the unlisting until this capture is answered too.
  reads.shift()!(snapshot(owner, epoch, 2))
  await capturing
  await settle()
  assert.equal(held(owner), undefined, "a capture answered with the unlisted conversation that holds its session doesn't bring it back")
}
// A normal fork answers with its new id; moving to a worktree can instead keep the source conversation. Both replies
// must respect an unlisting of the conversation they actually return. A transfer keeps the existing conversation.
for (const kind of ["fork", "relocated fork", "transfer"] as const) {
  const source = `identity-${kind}-source`, fork = `identity-${kind}-fork`, epoch = "g1.identityroot.a"
  const target = kind === "fork" ? fork : source
  recovery.applyLiveSnapshot(snapshot(source, epoch, 1))
  const pending = kind === "transfer"
    ? submitTransfer(source, { id: "identity-transfer", provider: "codex", text: "", attachments: [] })
    : recovery.readLive(fork, () => legacy.liveFork(source, { id: fork }))
  await settle()
  assert.equal(reads.length, 1, `${kind}: the read is out`)
  if (target === fork) recovery.applyLiveSnapshot(snapshot(target, epoch, 1))
  recovery.unlistLive([target])
  reads.shift()!(snapshot(target, epoch, 2))
  await pending
  await settle()
  assert.equal(held(target), undefined, `${kind}: its answer doesn't bring back the unlisted conversation`)
  // Unlisting only retires reads already out. A later intentional read can take the conversation again.
  answer = () => snapshot(target, epoch, 3)
  if (kind === "transfer") await recovery.readBackLive(source)
  else await recovery.readLive(fork, () => legacy.liveFork(source, { id: fork }))
  answer = undefined
  assert.equal(held(target)?.revision, 3, `${kind}: a read begun after unlisting can take the conversation`)
}
// A read can confirm durable acceptance even when a newer batch overtakes its snapshot. Restoring that start must
// settle its outbox command without replaying the start or replacing the newer state.
{
  Object.assign(globalThis.window, { mako: legacy })
  const id = "start-receipt", epoch = "g1.startreceipt.a"
  const receipt: LiveSnapshot = { ...snapshot(id, epoch, 1), requests: [{ id: "start-request", text: "Go", attachments: [], createdAt: 1, status: "completed" }] }
  recovery.applyLiveSnapshot(receipt)
  let settled = false
  const restoring = restorePendingStart({ kind: "start", draftKey: "start-receipt", args: ["codex", "/fixture", {
    conversationId: id, initialRequest: { id: "start-request", text: "Go", attachments: [] },
  }] }).then(() => { settled = true })
  await settle()
  assert.equal(reads.length, 1, "the durable start's receipt is being read")
  recovery.applyLiveBatch(batch(id, epoch, 2))
  reads.shift()!(receipt)
  await settle()
  assert.equal(settled, true, "an overtaken receipt still confirms acceptance without another start")
  assert.equal(reads.length, 0, "no replay or second receipt read")
  assert.equal(held(id)?.revision, 2, "the newer batch still stands")
  await restoring
}
assert.deepEqual(door.strays, [], "nothing went around the door")
assert.deepEqual(bypassed(), [], "and nothing read around the window's one read")
console.log("Live door: every way in to a conversation's state goes through one door and every snapshot read through one read, a write or read around them is caught, a listing during a fresh read is read after it, and a read out when its Session is unlisted doesn't bring it back, on both bridges")
process.exit(0)

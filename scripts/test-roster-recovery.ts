import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { NativeAgentSchema, type NativeAgent, type NativeAgentRoster } from "@mako/host/contracts/native-agents"
import { applyRosterPatch, compactLiveBatch, rosteredLiveBatch, type CompactLiveBatch, type LiveSnapshot } from "@mako/host/contracts/live-conversations"
import { rosterWindow, type WindowState } from "./lib/roster-window.ts"

const THREADS = new Map([["a", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"], ["b", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"], ["c", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"], ["d", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"]])
const agent = (id: string, at = 1, title = `Worker ${id}, with a title long enough to be worth leaving out of a change`): NativeAgent =>
  NativeAgentSchema.parse({ bindingId: "binding", provider: "codex", nativeId: id, title, observedAt: at, state: { kind: "working", activity: "doing work" }, child: { thread: THREADS.get(id) ?? "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", origin: "started", name: id, state: { kind: "working" } } })
const moved = (roster: NativeAgentRoster, id: string, at: number): NativeAgentRoster => ({ ...roster, agents: roster.agents.map((each) => (each.nativeId === id ? agent(id, at) : each)) })
const r1: NativeAgentRoster = { limited: false, agents: ["a", "b", "c", "d"].map((id) => agent(id)) }
const r2 = moved(r1, "b", 2), r3 = moved(r2, "c", 3)
const asking = NativeAgentSchema.parse({ ...agent("new-fin", 4), child: { thread: "11111111-1111-4111-8111-111111111111", origin: "started", name: "new-fin", state: { kind: "blocked", question: "Can I deploy?", on: "person", ask: { id: "new-question", kind: "report" } } } })
// Five Fins, one asking the person.
const r4: NativeAgentRoster = { ...r3, agents: [...r3.agents, asking] }

const change = (id: string, revision: number, held: NativeAgentRoster, next: NativeAgentRoster, epoch = "E"): CompactLiveBatch => {
  const batch = rosteredLiveBatch(compactLiveBatch({ id, revision, epoch, updates: [], nativeAgents: next }, { blocks: [], requests: [] }), held)
  assert.ok(batch?.rosterPatch, "goes as what changed")
  return batch
}
let thread = 0
const snapshotOf = (id: string, revision: number, nativeAgents: NativeAgentRoster | undefined, epoch = "E"): LiveSnapshot => ({
  session: { id, harness: "codex", cwd: "/fixture", title: "A Fin's Apex", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] },
  threadId: `22222222-2222-4222-8222-${String(thread).padStart(12, "0")}`, createdAt: 1, epoch, revision, base: null, blocks: [], requests: [], permissions: [], ...(nativeAgents && { nativeAgents }),
})

const window = rosterWindow()
let state: WindowState
const init = async (id: string, roster: NativeAgentRoster | undefined = r1, listed = true, revision = 1, epoch = "g1.roottest.a") => {
  thread += 1
  state = await window.ask({ kind: "init", snapshot: snapshotOf(id, revision, roster, epoch), listed })
}
const hear = async (batch: CompactLiveBatch) => { state = await window.ask({ kind: "batch", batch }) }
const reply = async (snapshot: LiveSnapshot | null, fail = false) => {
  const read = state.reads[0]
  assert.ok(read, "the window has a read out")
  state = await window.ask({ kind: "reply", read: read.number, snapshot, fail })
}
const next = (id: string, revision: number, held: NativeAgentRoster, roster: NativeAgentRoster, epoch = "g1.roottest.a") => change(id, revision, held, roster, epoch)
try {
  const stale: NativeAgentRoster = { ...r1, agents: r1.agents.map((each) => each.nativeId === "a" ? { ...each, title: "An old name" } : each) }
  assert.equal(applyRosterPatch(stale, next("seal", 2, r1, r2).rosterPatch!), undefined, "the seal covers titles")
  await init("seal", stale)
  await hear(next("seal", 2, r1, r2))
  assert.deepEqual(state!.held?.roster, stale, "an unread change never makes up a roster")
  assert.equal(state!.reads.length, 1, "a listed window reads the failed seal back")
  await reply(snapshotOf("seal", 2, r2, "g1.roottest.a"))
  assert.deepEqual(state!.held?.roster, r2)
  assert.equal(state!.held?.hydrated, false, "a listed read releases its transcript")
  await hear(next("seal", 3, r2, r3))
  assert.deepEqual(state!.held?.roster, r3, "the next patch reads against that roster")
  assert.equal(state!.reads.length, 0)
  await hear(next("seal", 3, r2, r3))
  assert.equal(state!.reads.length, 0, "an old duplicate asks for nothing")

  await init("gap")
  await hear(next("gap", 3, r2, r3))
  assert.equal(state!.reads.length, 1, "a gap reads back through the same path")
  await hear(next("gap", 4, r3, r4))
  assert.equal(state!.reads.length, 1, "one hydration at a time")
  await reply(snapshotOf("gap", 3, r3, "g1.roottest.a"))
  assert.equal(state!.reads.length, 1, "the stream overtook that reply, so a fresh read is needed")
  await reply(snapshotOf("gap", 4, r4, "g1.roottest.a"))
  assert.deepEqual(state!.held?.roster, r4, "the fresh reply repairs the gap")

  await init("shown", r1, false)
  await hear(next("shown", 3, r2, r3))
  await reply(snapshotOf("shown", 3, r3, "g1.roottest.a"))
  assert.deepEqual(state!.held?.roster, r3)
  assert.equal(state!.held?.hydrated, true)

  await init("restart", r1, true, 10)
  await hear(next("restart", 1, r1, r2, "g2.roottest.b"))
  await reply(snapshotOf("restart", 1, r2, "g2.roottest.b"))
  await hear(next("restart", 2, r2, r3, "g2.roottest.b"))
  assert.deepEqual(state!.held?.roster, r3, "a new start's numbering begins again")

  // Unlisting invalidates a read even after the same row has returned, at the same revision it held before removal.
  await init("relisted", r4, true, 5)
  state = await window.ask({ kind: "read" })
  state = await window.ask({ kind: "unlist" })
  state = await window.ask({ kind: "list", summary: { session: snapshotOf("relisted", 5, r4).session, revision: 5, epoch: "g1.roottest.a", createdAt: 1 } })
  await reply(snapshotOf("relisted", 5, r4, "g1.roottest.a"))
  assert.equal(state!.held?.roster, undefined, "the reply out before unlisting cannot populate the new row")
  state = await window.ask({ kind: "open" })
  await reply(snapshotOf("relisted", 5, r4, "g1.roottest.a"))
  assert.deepEqual(state!.held?.roster, r4, "a later intentional read restores all five Fins and their question")

  state = await window.ask({ kind: "init", snapshot: snapshotOf("absent", 1, undefined, "g1.roottest.a"), listed: true })
  await hear(next("absent", 2, r1, r2))
  await reply(snapshotOf("absent", 2, undefined, "g1.roottest.a"))
  assert.equal(state!.held?.roster, undefined, "a snapshot can say the host has no roster")

  for (const fail of [false, true]) {
    const id = fail ? "failed-read" : "null-read"
    await init(id, stale)
    await hear(next(id, 2, r1, r2))
    await reply(null, fail)
    assert.equal(state!.reads.length, 0, "an unavailable read does not spin")
    await hear(next(id, 3, r2, r3))
    await reply(snapshotOf(id, 3, r3, "g1.roottest.a"))
    assert.deepEqual(state!.held?.roster, r3, "the next change recovers after an unavailable read")
  }
  console.log("Roster recovery: seal, gap, buffered replay, shown and listed, restart, removal/relisting, absent roster, failed/null reads and duplicate batches; every write and read guarded")
} finally { window.close() }

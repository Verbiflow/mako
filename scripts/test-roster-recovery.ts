import assert from "node:assert/strict"
import { mock } from "node:test"
import { setImmediate as turn } from "node:timers/promises"
import { NativeAgentSchema, type NativeAgent, type NativeAgentRoster } from "@mako/host/contracts/native-agents"
import { applyRosterPatch, compactLiveBatch, rosteredLiveBatch, type CompactLiveBatch, type LiveRoster, type LiveSnapshot } from "@mako/host/contracts/live-conversations"

/**
 * A window's read of a whole roster against what lands while it's out (`readRoster`), in the real renderer: an answer
 * older than a roster that went whole meanwhile, by a batch or a snapshot, never undoes it; one that can't be laid over
 * what came is read again, and after `ROSTER_TRIES` its snapshot is; and a held roster wrong in any field a surface
 * shows fails the seal.
 */
Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
Object.assign(globalThis, { requestAnimationFrame: (run: () => void) => setTimeout(run, 16), cancelAnimationFrame: clearTimeout })
const { installMockBridge } = await import("../src/dev/mock-bridge")
installMockBridge()
const { getMako } = await import("../src/lib/bridge")
const { inboxModel } = await import("../src/state/inbox")
const { AudioFeedback } = await import("../src/lib/audio-feedback")
const { acpStore } = await import("../src/state/acp-state")
const { applyLiveBatch, applyLiveSnapshot, unloadLive } = await import("../src/state/live-recovery")
mock.method(AudioFeedback.prototype, "play", async () => {})
const bridge = getMako()

const THREADS = new Map([["a", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"], ["b", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"], ["c", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"], ["d", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"]])
const agent = (id: string, at = 1, title = `Worker ${id}, with a title long enough to be worth leaving out of a change`): NativeAgent =>
  NativeAgentSchema.parse({ bindingId: "binding", provider: "codex", nativeId: id, title, observedAt: at, state: { kind: "working", activity: "doing work" }, child: { thread: THREADS.get(id) ?? "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", origin: "started", name: id, state: { kind: "working" } } })
const moved = (roster: NativeAgentRoster, id: string, at: number): NativeAgentRoster => ({ ...roster, agents: roster.agents.map((each) => (each.nativeId === id ? agent(id, at) : each)) })
const r1: NativeAgentRoster = { limited: false, agents: ["a", "b", "c", "d"].map((id) => agent(id)) }
const r2 = moved(r1, "b", 2), r3 = moved(r2, "c", 3)
const asking = NativeAgentSchema.parse({ ...agent("new-fin", 4), child: { thread: "11111111-1111-4111-8111-111111111111", origin: "started", name: "new-fin", state: { kind: "blocked", question: "Can I deploy?", on: "person", ask: { id: "new-question", kind: "report" } } } })
// A new entry ahead of the rest: only a whole roster says that.
const r4: NativeAgentRoster = { ...r3, agents: [asking, ...r3.agents] }
const r5 = moved(r4, "a", 5), r6 = moved(r5, "d", 6)

const delta = (id: string, revision: number, held: NativeAgentRoster, next: NativeAgentRoster): CompactLiveBatch => {
  const batch = rosteredLiveBatch(compactLiveBatch({ id, revision, epoch: "E", updates: [], nativeAgents: next }, { blocks: [], requests: [] }), held)
  assert.ok(batch?.rosterPatch, "goes as what changed")
  return batch
}
/** A roster gone whole: as a window of form 3 hears one a change can't say, in the compact form, or as another reader does. */
const whole = (id: string, revision: number, nativeAgents: NativeAgentRoster, compact = true) =>
  applyLiveBatch(compact ? compactLiveBatch({ id, revision, epoch: "E", updates: [], nativeAgents }, { blocks: [], requests: [] }) : { id, revision, epoch: "E", updates: [], nativeAgents })
const snapshotOf = (id: string, revision: number, nativeAgents: NativeAgentRoster, threadId: string): LiveSnapshot => ({
  session: { id, harness: "codex", cwd: "/fixture", title: "A Fin's Apex", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] },
  threadId, createdAt: 1, epoch: "E", revision, base: null, blocks: [], requests: [], permissions: [], nativeAgents,
})
let thread = 0
/** A conversation this window lists, holding `roster` at `revision`. */
const listed = (id: string, revision = 1, roster = r1) => {
  thread += 1
  applyLiveSnapshot(snapshotOf(id, revision, roster, `22222222-2222-4222-8222-${String(thread).padStart(12, "0")}`))
  unloadLive(id)
  acpStore.set({ activeKey: null })
  assert.equal(acpStore.get().conversations[id]?.hydrated, false, "listed, not shown")
}
const rosterOf = (id: string) => acpStore.get().conversations[id]?.nativeAgents
const titles = (roster: NativeAgentRoster | undefined) => roster?.agents.map((each) => `${each.nativeId}@${each.observedAt}`)

const asked: { id: string; answer: (told: LiveRoster | null) => void }[] = []
mock.method(bridge, "liveRoster", (id: string) => new Promise<LiveRoster | null>((answer) => asked.push({ id, answer })))
const snapshotReads: string[] = []
mock.method(bridge, "liveRead", async (id: string) => { snapshotReads.push(id); throw new Error("not read here") })
const answer = async (told: LiveRoster | null) => {
  const next = asked.shift()
  assert.ok(next, "a read is out")
  next.answer(told)
  for (let wait = 0; wait < 6; wait += 1) await turn()
}

// The seal is every field a surface shows: an entry wrong only in its title and activity fails it, and is read whole.
const stale: NativeAgentRoster = { ...r1, agents: r1.agents.map((each) => (each.nativeId === "a" ? { ...each, title: "An old name", state: { kind: "working", activity: "something it stopped doing" } } : each)) }
assert.equal(applyRosterPatch(stale, delta("seal", 2, r1, r2).rosterPatch!), undefined, "a roster wrong in a title doesn't take a change")
listed("seal", 1, stale)
applyLiveBatch(delta("seal", 2, r1, r2))
assert.equal(asked.length, 1, "so its roster is read whole")
await answer({ roster: r2, revision: 2, epoch: "E" })
assert.deepEqual(rosterOf("seal"), r2, "and the title is right again")

// An answer older than a roster that went whole meanwhile doesn't undo it, nor the question it asks, in either form.
for (const compact of [true, false]) {
  const id = `whole-${String(compact)}`
  listed(id)
  applyLiveBatch(delta(id, 3, r2, r3))
  assert.equal(asked.length, 1)
  whole(id, 4, r4, compact)
  assert.ok(inboxModel().asks.some((ask) => ask.question === "Can I deploy?"), "the new Fin's question is in the Inbox")
  await answer({ roster: r3, revision: 3, epoch: "E" })
  assert.deepEqual(titles(rosterOf(id)), titles(r4), `an older answer leaves the newer roster${compact ? "" : ", heard whole"}`)
  assert.ok(inboxModel().asks.some((ask) => ask.question === "Can I deploy?"), "and its question")
  applyLiveBatch(delta(id, 5, r4, r5))
  assert.deepEqual(rosterOf(id), r5, "and what changes after it reads against it")
}

// And a roster that went whole before the answer's moment doesn't undo the answer either.
listed("newer")
applyLiveBatch(delta("newer", 3, r2, r3))
whole("newer", 4, r4)
await answer({ roster: r5, revision: 5, epoch: "E" })
assert.deepEqual(rosterOf("newer"), r5, "an answer newer than what came meanwhile stands")

// Likewise a snapshot read meanwhile, shown and let go again.
listed("shown")
applyLiveBatch(delta("shown", 3, r2, r3))
applyLiveSnapshot(snapshotOf("shown", 4, r4, "33333333-3333-4333-8333-333333333333"))
unloadLive("shown")
acpStore.set({ activeKey: null })
await answer({ roster: r3, revision: 3, epoch: "E" })
assert.deepEqual(titles(rosterOf("shown")), titles(r4), "an older answer leaves what a snapshot said")

// A change missed while the read is out: the answer can't take what came after it, so it's read again, unasked.
listed("gap")
applyLiveBatch(delta("gap", 3, r2, r3))
applyLiveBatch(delta("gap", 6, r5, r6))
await answer({ roster: r3, revision: 3, epoch: "E" })
assert.equal(asked.length, 1, "read again with no change to prompt it")
await answer({ roster: r6, revision: 6, epoch: "E" })
assert.deepEqual(rosterOf("gap"), r6, "and right")
assert.equal(asked.length, 0, "and no more")

// One that never makes sense, from a host of another start each time, is read in its snapshot, not given up on.
listed("never")
applyLiveBatch(delta("never", 3, r2, r3))
for (let tries = 0; tries < 3; tries += 1) await answer({ roster: r3, revision: 3, epoch: "another start" })
assert.equal(asked.length, 0, "three tries")
assert.deepEqual(snapshotReads, ["never"], "then its snapshot")

console.log("Roster recovery: an older answer never undoes a roster that went whole, by a batch or a snapshot; one that can't be read is read again, then its snapshot; the seal is every field a surface shows")
process.exit(0)

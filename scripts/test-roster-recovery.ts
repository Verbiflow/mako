import assert from "node:assert/strict"
import { mock } from "node:test"
import { setImmediate as turn } from "node:timers/promises"
import { NativeAgentSchema, type NativeAgent, type NativeAgentRoster } from "@mako/host/contracts/native-agents"
import { applyRosterPatch, compactLiveBatch, rosteredLiveBatch, type CompactLiveBatch, type LiveSnapshot, type LiveSummary } from "@mako/host/contracts/live-conversations"

/**
 * What a window does with a change to a roster it can't read (`applyLiveBatch`, `askWholeRoster`), in the real renderer:
 * one it only lists asks its host to send the roster whole, which comes in the stream like any batch, so nothing it holds
 * says which roster it has; one it shows reads its snapshot. Each case is a way a window comes to hold a roster the
 * change wasn't written against: a field wrong (the seal), a gap, another start of its host, none at all after its
 * conversation was let go of and listed again, or the host having none. An ask that fails is made again, up to three
 * times; one the host can't answer waits for the next change.
 */
Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
Object.assign(globalThis, { requestAnimationFrame: (run: () => void) => setTimeout(run, 16), cancelAnimationFrame: clearTimeout })
const { installMockBridge } = await import("../src/dev/mock-bridge")
installMockBridge()
const { getMako } = await import("../src/lib/bridge")
const { inboxModel } = await import("../src/state/inbox")
const { AudioFeedback } = await import("../src/lib/audio-feedback")
const { acpStore } = await import("../src/state/acp-state")
const { applyLiveBatch, applyLiveSnapshot, listLive, unlistLive, unloadLive } = await import("../src/state/live-recovery")
mock.method(AudioFeedback.prototype, "play", async () => {})
const bridge = getMako()

const THREADS = new Map([["a", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"], ["b", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"], ["c", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"], ["d", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"]])
const agent = (id: string, at = 1, title = `Worker ${id}, with a title long enough to be worth leaving out of a change`): NativeAgent =>
  NativeAgentSchema.parse({ bindingId: "binding", provider: "codex", nativeId: id, title, observedAt: at, state: { kind: "working", activity: "doing work" }, child: { thread: THREADS.get(id) ?? "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", origin: "started", name: id, state: { kind: "working" } } })
const moved = (roster: NativeAgentRoster, id: string, at: number): NativeAgentRoster => ({ ...roster, agents: roster.agents.map((each) => (each.nativeId === id ? agent(id, at) : each)) })
const r1: NativeAgentRoster = { limited: false, agents: ["a", "b", "c", "d"].map((id) => agent(id)) }
const r2 = moved(r1, "b", 2), r3 = moved(r2, "c", 3)
const asking = NativeAgentSchema.parse({ ...agent("new-fin", 4), child: { thread: "11111111-1111-4111-8111-111111111111", origin: "started", name: "new-fin", state: { kind: "blocked", question: "Can I deploy?", on: "person", ask: { id: "new-question", kind: "report" } } } })
// Five Fins, one asking the person.
const r4: NativeAgentRoster = { ...r3, agents: [...r3.agents, asking] }
const r5 = moved(r4, "a", 5)

const change = (id: string, revision: number, held: NativeAgentRoster, next: NativeAgentRoster, epoch = "E"): CompactLiveBatch => {
  const batch = rosteredLiveBatch(compactLiveBatch({ id, revision, epoch, updates: [], nativeAgents: next }, { blocks: [], requests: [] }), held)
  assert.ok(batch?.rosterPatch, "goes as what changed")
  return batch
}
/** The roster gone whole, as the host sends it when asked: in the stream, in its place. */
const whole = (id: string, revision: number, nativeAgents: NativeAgentRoster, epoch = "E") =>
  applyLiveBatch(compactLiveBatch({ id, revision, epoch, updates: [], nativeAgents }, { blocks: [], requests: [] }))
let thread = 0
const snapshotOf = (id: string, revision: number, nativeAgents: NativeAgentRoster | undefined, epoch = "E"): LiveSnapshot => ({
  session: { id, harness: "codex", cwd: "/fixture", title: "A Fin's Apex", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] },
  threadId: `22222222-2222-4222-8222-${String(thread).padStart(12, "0")}`, createdAt: 1, epoch, revision, base: null, blocks: [], requests: [], permissions: [], ...(nativeAgents && { nativeAgents }),
})
/** A conversation this window lists, holding `roster` at `revision`. */
const listed = (id: string, revision = 1, roster: NativeAgentRoster | undefined = r1, epoch = "E") => {
  thread += 1
  applyLiveSnapshot(snapshotOf(id, revision, roster, epoch))
  unloadLive(id)
  acpStore.set({ activeKey: null })
  assert.equal(acpStore.get().conversations[id]?.hydrated, false, "listed, not shown")
}
const rosterOf = (id: string) => acpStore.get().conversations[id]?.nativeAgents
const deploys = () => inboxModel().asks.some((ask) => ask.question === "Can I deploy?")

type Ask = { id: string; answer: (sent: boolean) => void; fail: () => void }
const asks: Ask[] = []
mock.method(bridge, "liveRoster", (id: string) => new Promise<boolean>((answer, reject) => asks.push({ id, answer, fail: () => reject(new Error("The host isn't answering")) })))
const snapshotReads: string[] = []
mock.method(bridge, "liveRead", async (id: string) => { snapshotReads.push(id); throw new Error("not read here") })
const settle = async () => {
  for (let wait = 0; wait < 6; wait += 1) await turn()
}
const answerAll = async (sent = true) => {
  while (asks.length) asks.shift()!.answer(sent)
  await settle()
}

// The seal is every field a surface shows: a roster wrong only in a title and an activity takes no change, keeps what it
// holds and asks for the roster whole, once while it's on its way, however many changes it can't read meanwhile.
const stale: NativeAgentRoster = { ...r1, agents: r1.agents.map((each) => (each.nativeId === "a" ? { ...each, title: "An old name", state: { kind: "working", activity: "something it stopped doing" } } : each)) }
assert.equal(applyRosterPatch(stale, change("seal", 2, r1, r2).rosterPatch!), undefined, "a roster wrong in a title doesn't take a change")
listed("seal", 1, stale)
applyLiveBatch(change("seal", 2, r1, r2))
applyLiveBatch(change("seal", 3, r2, r3))
assert.deepEqual(rosterOf("seal"), stale, "it keeps what it holds, not a roster made of a change to another")
assert.deepEqual(asks.map((ask) => ask.id), ["seal"], "and asks once while the ask is out")
await answerAll()
whole("seal", 4, r3)
assert.deepEqual(rosterOf("seal"), r3, "the roster that goes whole is the host's")
applyLiveBatch(change("seal", 5, r3, r4))
assert.deepEqual(rosterOf("seal"), r4, "and changes after it read against it")
assert.equal(asks.length, 0, "with nothing more asked")

// A gap: a change written against a revision this window never heard.
listed("gap")
applyLiveBatch(change("gap", 3, r2, r3))
assert.deepEqual(asks.map((ask) => ask.id), ["gap"], "a gap asks")
await answerAll()
whole("gap", 4, r3)
assert.deepEqual(rosterOf("gap"), r3)

// Another start of its host, whose numbers begin again: what it holds is the last start's, so a change can't read
// against it even at the next number, and the conversation takes the new start's from then on.
listed("restart", 10, r1, "before")
applyLiveBatch(change("restart", 1, r1, r2, "after"))
assert.deepEqual(asks.map((ask) => ask.id), ["restart"], "another start asks")
assert.equal(acpStore.get().conversations.restart?.epoch, "after", "and the conversation is the new start's")
await answerAll()
whole("restart", 2, r2, "after")
applyLiveBatch(change("restart", 3, r2, r3, "after"))
assert.deepEqual(rosterOf("restart"), r3, "what the new start changes after it reads")
assert.equal(asks.length, 0)

// Let go of and listed again, as an account's list does: it holds no roster, the next change asks for it, and opening it
// takes the snapshot's whole, its five Fins and the question one asks with it. (#512's third round lost both, to a mark
// of the revision a roster was held at that outlived the conversation.)
listed("relisted", 5, r4)
assert.ok(deploys(), "the asking Fin's question is in the Inbox")
const summary = acpStore.get().conversations.relisted
assert.ok(summary?.kind === "live")
unlistLive(["relisted"])
const { nativeAgents: _roster, ...listing } = summary
listLive([{ session: listing.session, revision: 5, epoch: "E", threadId: listing.threadId, createdAt: 1 } as LiveSummary])
assert.equal(rosterOf("relisted"), undefined, "listed again from the account's row, it holds no roster")
applyLiveBatch(change("relisted", 6, r4, r5))
assert.deepEqual(asks.map((ask) => ask.id), ["relisted"], "so a change asks for it")
await answerAll()
whole("relisted", 7, r5)
assert.deepEqual(rosterOf("relisted"), r5)
assert.ok(deploys(), "and the question is back")
unlistLive(["relisted"])
listLive([{ session: listing.session, revision: 7, epoch: "E", threadId: listing.threadId, createdAt: 1 } as LiveSummary])
applyLiveSnapshot(snapshotOf("relisted", 7, r5))
assert.equal(acpStore.get().conversations.relisted?.hydrated, true, "opened at the revision it last held")
assert.deepEqual(rosterOf("relisted"), r5, "it has its five Fins")
assert.ok(deploys(), "and the question")

// A host with no roster to say sends an empty one: a window holding one hears there's none.
listed("absent")
applyLiveBatch(change("absent", 3, r2, r3))
await answerAll()
whole("absent", 4, { agents: [], limited: false })
assert.deepEqual(rosterOf("absent"), { agents: [], limited: false }, "an empty roster stands for none")

// An ask that fails is made again, three times in all; then it waits for the next change it can't read, which asks again.
listed("failing")
applyLiveBatch(change("failing", 3, r2, r3))
for (let tries = 1; tries <= 3; tries += 1) {
  assert.deepEqual(asks.map((ask) => ask.id), ["failing"], `try ${tries}`)
  asks.shift()!.fail()
  await settle()
}
assert.equal(asks.length, 0, "three tries")
applyLiveBatch(change("failing", 4, r3, r4))
assert.deepEqual(asks.map((ask) => ask.id), ["failing"], "the next change it can't read asks again")
asks.shift()!.fail()
await settle()
await answerAll()
whole("failing", 5, r4)
assert.deepEqual(rosterOf("failing"), r4)

// One the host can't answer (the conversation isn't there) isn't asked again until the next change.
listed("gone")
applyLiveBatch(change("gone", 3, r2, r3))
await answerAll(false)
assert.equal(asks.length, 0, "an ask the host can't answer isn't made again")
assert.deepEqual(rosterOf("gone"), r1, "and what it holds stays")

// A conversation this window shows reads its snapshot again, which says the roster whole: it asks nothing.
thread += 1
applyLiveSnapshot(snapshotOf("shown", 1, r1))
acpStore.set({ activeKey: "shown" })
applyLiveBatch(change("shown", 3, r2, r3))
await settle()
assert.deepEqual(snapshotReads, ["shown"], "a shown conversation reads its snapshot")
assert.equal(asks.length, 0, "and asks for no roster")
acpStore.set({ activeKey: null })

// A change to a conversation this window doesn't list at all asks for nothing.
applyLiveBatch(change("unknown", 2, r1, r2))
await settle()
assert.equal(asks.length, 0, "nothing asked for a conversation it doesn't hold")

console.log("Roster recovery: a change a window can't read (a field wrong, a gap, another start, a conversation listed again, none held) asks for the roster whole, once while the ask is out; what comes whole is the host's; a failed ask is made again three times, one the host can't answer waits; a shown conversation reads its snapshot")
process.exit(0)

import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { childEntry, ThreadParentSchema } from "@mako/host/contracts/agents"
import type { LiveBatch, LiveSummary } from "@mako/host/contracts/live-conversations"
import { SessionIdSchema, ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { acpStore, railAcpStore } from "../src/state/acp-state"
import { applyLiveBatch, listLive } from "../src/state/live-recovery"
import { atWorkOf, QUEUED_AFTER_MS, queuedAt, queuedSince, waitingOf, waitingWords } from "../src/state/waiting"

/**
 * What a conversation waits on at its transcript's end (`waitingOf`): its Fins at work by name, the first two and a
 * count past three, read from the roster the window holds and built again only when that roster or the turn's
 * standing moves. A streamed batch, of this conversation or another, builds nothing and wakes no reader.
 */

const T = Date.parse("2026-11-17T09:00:00.000Z")
const apexThread = ThreadIdSchema.parse(randomUUID())
const apexSession = SessionIdSchema.parse(randomUUID())
const APEX = "c-0"
const summary = (index: number, fields: Partial<LiveSummary> = {}): LiveSummary => ({
  session: { id: `c-${index}`, harness: "codex", cwd: "/p", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] },
  revision: 1,
  createdAt: T + index * 60_000,
  threadPath: `/p/rollout-${index}.jsonl`,
  ...fields,
})
const fin = (name: string, startedAgo: number, working: boolean) => childEntry(
  ThreadParentSchema.parse({
    child: randomUUID(), parent: apexThread, parentSession: apexSession, name, role: "worker", origin: "started",
    asked: { brief: { objective: "Work" }, harness: "claude" }, op: `start-${name}`, startedBy: { kind: "agent", session: apexSession }, createdAt: T - startedAgo,
  }),
  { source: "live", working, updatedAt: T },
  {}
)
const batch = (id: string, revision: number, fields: Partial<LiveBatch> = {}): LiveBatch => ({ id, revision, updates: [], ...fields })
const names = (count: number) => Array.from({ length: count }, (_, index) => fin(`fin-${index + 1}`, (count - index) * 10_000, true))

acpStore.set({ activeKey: "elsewhere", conversations: {} })
listLive([summary(0, { threadId: apexThread, sessionId: apexSession }), summary(1), summary(2)])

// Six Fins at work: the first two by name, then a count.
applyLiveBatch(batch(APEX, 2, { nativeAgents: { agents: names(6), limited: false } }))
const six = waitingOf(acpStore.get(), APEX)
assert.equal(six.fins, 6)
const words = waitingWords(six)
assert.deepEqual(words.named.map((agent) => agent.title), six.items.slice(0, 2).map((agent) => agent.title))
assert.equal(words.rest, "4 other Fins")
assert.equal(atWorkOf(acpStore.get(), APEX).items.length, 6, "the pill counts the same six")

// A token batch of another conversation, and of this one, builds nothing: the same object, and no rail reader woken.
let woken = 0
const stop = railAcpStore.subscribe(() => { woken += 1 })
for (let revision = 2; revision < 12; revision++) applyLiveBatch(batch("c-1", revision, { activityAt: T + revision * 1000, updates: [{ kind: "text", text: " word" }] }))
applyLiveBatch(batch(APEX, 3, { activityAt: T + 5000, updates: [{ kind: "text", text: " word" }] }))
stop()
assert.equal(woken, 0, "streamed batches wake no reader of the rail's store, which the line and the pill read")
assert.equal(waitingOf(acpStore.get(), APEX), six, "and the waiting items are the object they were")
assert.equal(atWorkOf(acpStore.get(), APEX), atWorkOf(acpStore.get(), APEX))

// Three or fewer are all named; a Fin that settles leaves the line.
applyLiveBatch(batch(APEX, 4, { nativeAgents: { agents: names(3), limited: false } }))
const three = waitingOf(acpStore.get(), APEX)
assert.notEqual(three, six, "a roster that changed is read again")
assert.equal(waitingWords(three).named.length, 3)
assert.equal(waitingWords(three).rest, undefined)
applyLiveBatch(batch(APEX, 5, { nativeAgents: { agents: [...names(2), fin("done", 1000, false)], limited: false } }))
assert.equal(waitingOf(acpStore.get(), APEX).fins, 2, "a Fin whose turn ended isn't waited on")

// While the Apex's own turn runs it waits on nothing, and the pill still counts what is at work.
applyLiveBatch(batch(APEX, 6, { sessionChanges: { status: "running" } }))
assert.equal(waitingOf(acpStore.get(), APEX).fins, 0)
assert.equal(atWorkOf(acpStore.get(), APEX).items.length, 2)
assert.equal(waitingOf(acpStore.get(), "c-2").items.length, 0, "a conversation with nothing at work waits on nothing")

// A message a minute unsent is said since when it was written; before that, and once it goes, nothing is.
{
  const queued = { requests: [{ id: "r1", createdAt: T, text: "Later", attachments: [], status: "queued" as const }] }
  assert.equal(queuedAt(queued), T)
  assert.equal(queuedSince(queued, T + QUEUED_AFTER_MS - 1), undefined, "under a minute the line says nothing")
  assert.equal(queuedSince(queued, T + QUEUED_AFTER_MS), T, "at a minute it says since when")
  assert.equal(queuedSince({ requests: [{ ...queued.requests[0]!, status: "held" as const }] }, T + 5 * QUEUED_AFTER_MS), T, "a held message is waiting too")
  assert.equal(queuedSince({ requests: [{ ...queued.requests[0]!, status: "dispatching" as const }] }, T + 5 * QUEUED_AFTER_MS), undefined, "a sent one isn't")
  assert.equal(queuedSince(undefined, T), undefined)
}

console.log("PASS: the waiting line's items come from the roster, first two by name past three, and no streamed batch builds them again")

import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { childEntry, ThreadParentSchema } from "@mako/host/contracts/agents"
import { rosterChildren } from "@mako/host/contracts/children"
import type { LiveBatch, LiveSummary } from "@mako/host/contracts/live-conversations"
import { SessionIdSchema, ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { selectAcpPresence, selectSessionOwners } from "../src/state/acp-presence"
import { acpForThread, acpStore, conversationRoster, finSources, listedCounts, railAcpStore, threadChildren, type AcpState } from "../src/state/acp-state"
import { apexPips } from "../src/state/fin-pips"
import { applyLiveBatch, hydrateLiveSummaries, listLive } from "../src/state/live-recovery"
import { threadLiveKey } from "../src/state/thread-status"

/**
 * The hot path's promise for the rail (AGENTS.md, "The hot path"): a streamed batch of a conversation the window
 * hasn't opened wakes no rail reader and builds nothing again, a batch that moves a fact a row shows reads that one
 * conversation again, and a list of conversations (boot, a reconnect) is one change to the store however long it is.
 */

const COUNT = 60
const T = Date.parse("2026-10-30T09:00:00.000Z")
const apexThread = ThreadIdSchema.parse(randomUUID())
const apexSession = SessionIdSchema.parse(randomUUID())
const APEX = "c-0"

const summary = (index: number, fields: Partial<LiveSummary> = {}): LiveSummary => ({
  session: { id: `c-${index}`, harness: "codex", cwd: `/Users/ana/project-${index % 7}`, status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] },
  revision: 1,
  createdAt: T + index * 60_000,
  threadPath: `/Users/ana/.codex/sessions/rollout-${index}.jsonl`,
  ...fields,
})

const summaries = (): LiveSummary[] => Array.from({ length: COUNT }, (_, index) => summary(index, index === 0 ? { threadId: apexThread, sessionId: apexSession } : {}))

/** A Fin of the Apex as its host's roster carries it; the roster files them newest first, where the Thread's order is oldest first. */
const fin = (name: string, startedAgo: number, working: boolean) => childEntry(
  ThreadParentSchema.parse({
    child: randomUUID(), parent: apexThread, parentSession: apexSession, name, role: "worker", origin: "started",
    asked: { brief: { objective: "Work" }, harness: "claude" }, op: `start-${name}`, startedBy: { kind: "agent", session: apexSession }, createdAt: T - startedAgo,
  }),
  { source: "live", working, updatedAt: T },
  {}
)
const fins = [fin("third", 10_000, true), fin("second", 20_000, true), fin("first", 30_000, true)]

const batch = (id: string, revision: number, fields: Partial<LiveBatch> = {}): LiveBatch => ({ id, revision, updates: [], ...fields })

/** How often each store spoke, and each conversations object the live store said. */
function watch() {
  const seen = { live: 0, rail: 0, conversations: new Set<AcpState["conversations"]>() }
  const stops = [
    acpStore.subscribe(() => {
      seen.live += 1
      seen.conversations.add(acpStore.get().conversations)
    }),
    railAcpStore.subscribe(() => {
      seen.rail += 1
    }),
  ]
  return { seen, stop: () => stops.forEach((stop) => stop()) }
}

/** Everything the rail derives from the whole state, as it stands now. */
function derivedNow() {
  const state = acpStore.get()
  return {
    presence: selectAcpPresence(state),
    owners: selectSessionOwners(state),
    children: threadChildren(state, apexThread),
    sources: finSources(state),
    counts: listedCounts(state),
  }
}

function boot(): void {
  acpStore.set({ activeKey: "elsewhere", conversations: {} })
  listLive(summaries())
  applyLiveBatch(batch(APEX, 2, { nativeAgents: { agents: fins, limited: false } }))
}

function live(id: string) {
  const conversation = acpStore.get().conversations[id]
  assert.ok(conversation?.kind === "live", `${id} is listed`)
  return conversation
}

test("a list of conversations is one change to the store, at boot and on a reconnect", () => {
  acpStore.set({ activeKey: null, conversations: {} })
  const booted = watch()
  hydrateLiveSummaries(summaries())
  booted.stop()
  assert.equal(Object.keys(acpStore.get().conversations).length, COUNT)
  assert.equal(booted.seen.conversations.size, 1, "boot: the conversations were set once, not once per summary")
  assert.ok(booted.seen.live <= 2, "boot: one set for the list and one for the selection")
  assert.deepEqual(Object.keys(railAcpStore.get().conversations), Object.keys(acpStore.get().conversations), "the rail holds the list")

  acpStore.set({ activeKey: "elsewhere" })
  const again = watch()
  hydrateLiveSummaries(summaries().map((each) => ({ ...each, revision: 5, session: { ...each.session, status: "running" as const } })), true)
  again.stop()
  assert.equal(again.seen.live, 1, "a reconnect: one change")
  assert.equal(again.seen.rail, 1, "said to the rail once")
  assert.equal(selectAcpPresence(railAcpStore.get()).filter((presence) => presence.status === "running").length, COUNT, "with every summary taken in")

  const listed = watch()
  listLive([summary(COUNT + 1), summary(COUNT + 2)])
  listed.stop()
  assert.equal(listed.seen.live, 1, "a listing of two: one change")
  assert.equal(Object.keys(acpStore.get().conversations).length, COUNT + 2)
})

test("a streamed batch of an unopened conversation wakes no rail reader and builds nothing again", () => {
  boot()
  const before = derivedNow()
  assert.equal(before.children.length, 3, "the Apex's Fins are indexed")
  // Sixty rows' worth of readers, each with the selectors a row runs.
  let selectorRuns = 0
  const readers = Array.from({ length: COUNT }, (_, index) => railAcpStore.subscribe(() => {
    selectorRuns += 1
    threadLiveKey(railAcpStore.get(), { harness: "codex", nativeId: `n-${index}`, path: `/Users/ana/.codex/sessions/rollout-${index}.jsonl` })
  }))
  const watched = watch()
  for (let revision = 2; revision < 22; revision++)
    applyLiveBatch(batch("c-7", revision, { activityAt: T + revision * 1000, updates: [{ kind: "text", text: " word" }] }))
  // A context reading moves through a turn and no row shows it.
  applyLiveBatch(batch("c-7", 22, { sessionChanges: { usage: { used: 1200, size: 200_000 } } }))
  watched.stop()
  readers.forEach((stop) => stop())
  assert.equal(live("c-7").revision, 22, "the batches were taken in")
  assert.equal(watched.seen.live, 21, "the live store said each of them")
  assert.equal(watched.seen.rail, 0, "and the rail's store none")
  assert.equal(selectorRuns, 0, "so no row's selector ran")
  const after = derivedNow()
  assert.equal(after.presence, before.presence, "the presence list is the same array")
  assert.equal(after.owners, before.owners, "the owners are the same array")
  assert.equal(after.children, before.children, "the Thread's Fins are the same array")
  assert.equal(after.sources, before.sources, "the Fin sources are the same index")
  assert.equal(after.counts, before.counts, "the listed counts are the same index")
  assert.equal(threadLiveKey(railAcpStore.get(), { harness: "codex", nativeId: "n-7", path: "/Users/ana/.codex/sessions/rollout-7.jsonl" }), "connected|ready|||||0", "what the rail holds of it is still true")
})

test("an unopened Apex's roster is read once, whoever asks for it", () => {
  boot()
  const state = acpStore.get()
  const apex = live(APEX)
  const roster = conversationRoster(state, apex)
  assert.notEqual(roster, apex.nativeAgents, "its own roster files its Fins in another order than its Thread's")
  assert.equal(conversationRoster(state, apex), roster, "the roster made for it is kept")
  assert.deepEqual(rosterChildren(roster), threadChildren(state, apexThread), "with the Thread's Fins in the Thread's order")
  assert.equal(rosterChildren(conversationRoster(state, apex)), rosterChildren(roster), "sorted once")
  assert.equal(apexPips(state, apexThread), "www")
})

test("a batch that moves a fact a row shows reads that conversation again, and only it", () => {
  boot()
  const before = derivedNow()
  const watched = watch()
  applyLiveBatch(batch("c-9", 2, { sessionChanges: { status: "running" } }))
  watched.stop()
  assert.equal(watched.seen.rail, 1, "the rail hears it once")
  const after = derivedNow()
  assert.notEqual(after.presence, before.presence)
  assert.equal(after.presence.length, before.presence.length)
  const changed = after.presence.filter((presence, index) => presence !== before.presence[index])
  assert.deepEqual(changed.map((presence) => [presence.key, presence.status]), [["c-9", "running"]], "one presence is new, the rest are the objects they were")
  assert.equal(after.children, before.children, "it says nothing of any Thread's Fins, so those indexes stand")
  assert.equal(after.sources, before.sources)
  assert.equal(after.counts, before.counts)
  assert.equal(selectAcpPresence(railAcpStore.get()), after.presence, "the rail reads the list the live store holds")
})

test("a Fin's change reaches the rail through its Apex's roster", () => {
  boot()
  const before = derivedNow()
  const watched = watch()
  applyLiveBatch(batch(APEX, 3, { nativeAgents: { agents: [fins[0]!, fins[1]!, { ...fins[2]!, child: { ...fins[2]!.child!, state: { kind: "idle" } } }], limited: false } }))
  watched.stop()
  assert.equal(watched.seen.rail, 1)
  const after = derivedNow()
  assert.notEqual(after.children, before.children, "the Thread's Fins are read again")
  assert.equal(apexPips(railAcpStore.get(), apexThread), "wwi")
  assert.deepEqual(before.presence.find((presence) => presence.key === APEX)?.background, 3)
  assert.deepEqual(after.presence.filter((presence, index) => presence !== before.presence[index]).map((presence) => [presence.key, presence.background]), [[APEX, 2]], "its Apex waits on one fewer, and every other presence is the object it was")
})

test("of two conversations that stand for one row, the one that moves last is the rail's", () => {
  boot()
  const shared = "/Users/ana/.codex/sessions/rollout-shared.jsonl"
  listLive([summary(70, { threadPath: shared }), summary(71, { threadPath: shared })])
  applyLiveBatch(batch("c-71", 2))
  assert.equal(acpForThread(railAcpStore.get(), { path: shared })?.key, "c-71")
  const watched = watch()
  // The older one streams: it takes the row, which the rail must hear, and then holds it without another word.
  const later = Date.now
  Date.now = () => later() + 5
  try {
    applyLiveBatch(batch("c-70", 2))
    assert.equal(watched.seen.rail, 1, "taking the row is said")
    assert.equal(acpForThread(railAcpStore.get(), { path: shared })?.key, "c-70")
    Date.now = () => later() + 10
    applyLiveBatch(batch("c-70", 3))
    assert.equal(watched.seen.rail, 1, "holding it isn't")
    assert.equal(acpForThread(acpStore.get(), { path: shared })?.key, "c-70")
  } finally {
    Date.now = later
    watched.stop()
  }
})

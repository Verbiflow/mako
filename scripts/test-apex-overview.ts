import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { childEntry, ThreadParentSchema, type ChildState } from "@mako/host/contracts/agents"
import type { LiveBatch, LiveSummary } from "@mako/host/contracts/live-conversations"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { SessionIdSchema, ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import type { ThreadWorktree, WorktreeSummary } from "@mako/host/contracts/thread-worktrees"
import { acpStore, railAcpStore } from "../src/state/acp-state"
import { apexOnScreen } from "../src/state/agents-offered"
import { OVERVIEW_SECTIONS, overviewChildren, overviewPulls, overviewSection, sameFins, treeFins, type OverviewSection } from "../src/state/apex-overview"
import { applyLiveBatch, listLive } from "../src/state/live-recovery"
import { APEX_COMPANION, shownCompanion } from "../src/state/stage"

/**
 * The Overview's promise (AGENTS.md, "The hot path"): each section is read from the roster the window holds, made once
 * per roster, and heard through the rail's store. A token streaming in any conversation, the Apex's own included, runs
 * no section's selector; a Fin's step moving reads its own section again and leaves the others the arrays they were.
 */

const T = Date.parse("2026-11-17T09:00:00.000Z")
const apexThread = ThreadIdSchema.parse(randomUUID())
const apexSession = SessionIdSchema.parse(randomUUID())
const APEX = "apex"
const OTHER = "other"

const summary = (id: string, fields: Partial<LiveSummary> = {}): LiveSummary => ({
  session: { id, harness: "codex", cwd: "/Users/ana/project", status: "running", connection: "connected", modes: [], currentMode: null, configOptions: [] },
  revision: 1,
  createdAt: T,
  threadPath: `/Users/ana/.codex/sessions/${id}.jsonl`,
  ...fields,
})

/** A Fin as its host's roster carries it, standing as `state` says. */
function fin(name: string, state: ChildState, ago: number): NativeAgent {
  const entry = childEntry(
    ThreadParentSchema.parse({
      child: randomUUID(), parent: apexThread, parentSession: apexSession, name, role: "worker", origin: "started",
      asked: { brief: { objective: "Work" }, harness: "claude" }, op: `start-${name}`, startedBy: { kind: "agent", session: apexSession }, createdAt: T - 3_600_000,
    }),
    { source: "live", working: state.kind === "working", updatedAt: T - ago },
    {}
  )
  return { ...entry, since: T - ago, child: { ...entry.child!, state } }
}

const roster = (): NativeAgent[] => [
  fin("asks", { kind: "blocked", on: "person", question: "Plain or friendly?", ask: { kind: "report", id: "report:asks" } }, 60_000),
  fin("decides", { kind: "ended", outcome: "done", decision: { question: "Merge #371?", on: "person", ask: { kind: "report", id: "report:decides" } } }, 90_000),
  fin("edits", { kind: "working", step: "Edit src/a.ts" }, 120_000),
  fin("asks-apex", { kind: "blocked", on: "lead", question: "Which branch?" }, 30_000),
  fin("idle", { kind: "idle" }, 240_000),
  fin("queued", { kind: "queued", reason: "tree-running", ahead: 0 }, 0),
  fin("waits", { kind: "idle", waitingOn: [{ kind: "pull-request", ref: "acme/app#371", repository: "acme/app", number: 371, until: "checks" }], since: T - 720_000 }, 720_000),
  fin("failed", { kind: "ended", outcome: "failed", reason: "The build broke." }, 300_000),
  fin("older", { kind: "ended", outcome: "done", reason: "Older result." }, 900_000),
  fin("newer", { kind: "ended", outcome: "done", reason: "Newer result." }, 100_000),
]

const batch = (id: string, revision: number, fields: Partial<LiveBatch> = {}): LiveBatch => ({ id, revision, updates: [], ...fields })

function boot(agents: NativeAgent[] = roster()): NativeAgent[] {
  // Neither is the one on screen, as in the rail's own test: a listed conversation takes its batches in with no read of its host.
  acpStore.set({ activeKey: "elsewhere", conversations: {} })
  listLive([summary(APEX, { threadId: apexThread, sessionId: apexSession }), summary(OTHER)])
  applyLiveBatch(batch(APEX, 2, { nativeAgents: { agents, limited: false } }))
  return agents
}

const names = (agents: readonly NativeAgent[]) => agents.map((agent) => agent.child?.name)

/** The panel's readers as the hooks make them: a selector a section over the rail's store, kept by `sameFins`. */
function readers() {
  const runs = { needs: 0, working: 0, waiting: 0, failed: 0, done: 0 }
  const draws = { needs: 0, working: 0, waiting: 0, failed: 0, done: 0 }
  const now = (section: OverviewSection) => overviewSection(railAcpStore.get(), apexThread, section)
  const held = { needs: now("needs"), working: now("working"), waiting: now("waiting"), failed: now("failed"), done: now("done") }
  const stops = OVERVIEW_SECTIONS.map((section) => railAcpStore.subscribe(() => {
    runs[section] += 1
    const next = overviewSection(railAcpStore.get(), apexThread, section)
    if (sameFins(held[section], next)) return
    held[section] = next
    draws[section] += 1
  }))
  return { runs, draws, held, stop: () => stops.forEach((stop) => stop()) }
}

test("every Fin is in one section, in the order the panel draws them", () => {
  boot()
  const state = railAcpStore.get()
  const section = (name: OverviewSection) => names(overviewSection(state, apexThread, name))
  assert.deepEqual(section("needs"), ["asks", "decides"], "a question and a done Fin's decision are the person's")
  assert.deepEqual(section("working"), ["edits", "asks-apex"], "one asking its Apex is still at work for the person")
  assert.deepEqual(section("waiting"), ["waits", "queued", "idle"], "waiting on what it named first, then the queued, then the idle")
  assert.deepEqual(section("failed"), ["failed"])
  assert.deepEqual(section("done"), ["newer", "older"], "the newest result first")
  const total = OVERVIEW_SECTIONS.reduce((sum, name) => sum + overviewSection(state, apexThread, name).length, 0)
  assert.equal(total, overviewChildren(state, apexThread).length, "none is left out or listed twice")
})

test("a token batch in any conversation runs no section's selector", () => {
  boot()
  const reading = readers()
  const before = { ...reading.held }
  for (let revision = 3; revision < 43; revision++) applyLiveBatch(batch(APEX, revision, { activityAt: T + revision * 1000, updates: [{ kind: "text", text: " word" }] }))
  for (let revision = 2; revision < 42; revision++) applyLiveBatch(batch(OTHER, revision, { activityAt: T + revision * 1000, updates: [{ kind: "text", text: " word" }] }))
  applyLiveBatch(batch(APEX, 43, { sessionChanges: { usage: { used: 1200, size: 200_000 } } }))
  reading.stop()
  assert.equal(acpStore.get().conversations[APEX]?.revision, 43, "the batches were taken in")
  assert.deepEqual(reading.runs, { needs: 0, working: 0, waiting: 0, failed: 0, done: 0 }, "81 batches, and no selector ran")
  assert.deepEqual(reading.draws, { needs: 0, working: 0, waiting: 0, failed: 0, done: 0 })
  for (const section of OVERVIEW_SECTIONS) assert.equal(overviewSection(acpStore.get(), apexThread, section), before[section], `${section} is the array it was`)
})

test("a Fin's step moving draws its own section, and every other Fin is the entry it was", () => {
  const agents = boot()
  const reading = readers()
  const before = { ...reading.held }
  const moved = agents.map((agent) => (agent.child?.name === "edits" ? { ...agent, child: { ...agent.child!, state: { kind: "working" as const, step: "Shell npm test" } } } : agent))
  // Through JSON, as the host's batch crosses to the window: every entry arrives a new object.
  applyLiveBatch(batch(APEX, 3, { nativeAgents: JSON.parse(JSON.stringify({ agents: moved, limited: false })) }))
  reading.stop()
  assert.deepEqual(reading.runs, { needs: 1, working: 1, waiting: 1, failed: 1, done: 1 }, "the rail's store said the roster once")
  assert.deepEqual(reading.draws, { needs: 0, working: 1, waiting: 0, failed: 0, done: 0 }, "and only Working holds a different Fin")
  const working = overviewSection(railAcpStore.get(), apexThread, "working")
  assert.notEqual(working[0], before.working[0], "the Fin that moved is a new entry")
  assert.equal(working[1], before.working[1], "its neighbour is the object it was, so its row doesn't draw")
})

test("a Fin changing section draws the two sections it leaves and joins", () => {
  const agents = boot()
  const reading = readers()
  const moved = agents.map((agent) => (agent.child?.name === "edits" ? { ...agent, child: { ...agent.child!, state: { kind: "ended" as const, outcome: "done" as const, reason: "Edited." } }, since: T } : agent))
  applyLiveBatch(batch(APEX, 3, { nativeAgents: JSON.parse(JSON.stringify({ agents: moved, limited: false })) }))
  reading.stop()
  assert.deepEqual(reading.draws, { needs: 0, working: 1, waiting: 0, failed: 0, done: 1 })
  assert.deepEqual(names(overviewSection(railAcpStore.get(), apexThread, "done")), ["edits", "newer", "older"], "it's the newest result")
})

test("a roster of 226 Fins is divided once, whoever asks", () => {
  const many = Array.from({ length: 226 }, (_, index) => fin(`fin-${index}`, index % 2 ? { kind: "working", step: "Read a.ts" } : { kind: "ended", outcome: "done", reason: "Done." }, index * 1000))
  boot(many)
  const state = railAcpStore.get()
  const done = overviewSection(state, apexThread, "done")
  assert.equal(done.length, 113)
  assert.equal(overviewSection(state, apexThread, "working").length, 113)
  assert.equal(overviewSection(state, apexThread, "done"), done, "the same array each time it's asked for")
  assert.equal(names(done)[0], "fin-0", "newest first")
})

test("the tree's open pull requests come from what the window holds", () => {
  const agents = boot()
  const state = railAcpStore.get()
  const tree = treeFins(state, apexThread)
  assert.equal(tree, overviewChildren(state, apexThread), "a tree of one level is the roster itself")
  const threadOf = (name: string) => agents.find((agent) => agent.child?.name === name)!.child!.thread
  const worktree = (thread: string, path: string): ThreadWorktree => ({ path, thread: ThreadIdSchema.parse(thread), repoRoot: "/Users/ana/app", project: "/Users/ana/app", branch: `mako/${path.split("/").at(-1)}`, base: "abc", createdAt: T })
  const summaryOf = (path: string, pull: WorktreeSummary["pull"]): WorktreeSummary => ({ path, into: "main", ahead: 1, changes: 0, landing: { kind: "open", into: "main", commits: 1 }, pull, behind: null })
  const pull = (number: number, fields: Partial<NonNullable<WorktreeSummary["pull"]>> = {}): NonNullable<WorktreeSummary["pull"]> => ({ number, title: `Pull ${number}`, url: `https://github.com/acme/app/pull/${number}`, branch: "b", state: "open", head: "abc", checks: "passed", ...fields })
  const worktrees = [worktree(apexThread, "/w/apex"), worktree(threadOf("edits"), "/w/edits"), worktree(threadOf("older"), "/w/older"), worktree(threadOf("waits"), "/w/waits")]
  const summaries = {
    "/w/apex": summaryOf("/w/apex", pull(300, { state: "draft", checks: "running" })),
    "/w/edits": summaryOf("/w/edits", pull(340, { checks: "failed" })),
    "/w/older": summaryOf("/w/older", pull(200, { state: "merged" })),
    "/w/waits": summaryOf("/w/waits", pull(371)),
  }
  const owners = [{ thread: apexThread, title: "Apex" }, ...tree.map((agent) => ({ thread: agent.child!.thread, title: agent.title, agent }))]
  const pulls = overviewPulls(owners, worktrees, summaries)
  assert.deepEqual(pulls.map((each) => [each.number, each.draft, each.checks, each.until ?? null]), [[300, true, "running", null], [340, false, "failed", null], [371, false, "passed", "checks"]], "open and draft ones, a merged one left out, the waited-on one once")
  assert.equal(pulls[2]?.title, "Pull 371", "the one a Fin waits on keeps the title its branch's summary gave")
  const reported = overviewPulls(owners, [], {})
  assert.deepEqual(reported.map((each) => [each.key, each.title ?? null, each.until]), [["acme/app#371", null, "checks"]], "with no summary held, what a Fin says it waits on is still listed")
})

test("an Apex's right rail opens on its Overview until the person picks another surface there", () => {
  boot()
  acpStore.set({ activeKey: APEX })
  const apex = apexOnScreen(railAcpStore.get())
  assert.equal(apex, apexThread, "the Thread on screen leads Fins")
  const open = { companion: "changes", dock: null, presentation: "beside" as const }
  assert.equal(shownCompanion(open, apex, undefined), APEX_COMPANION, "its Overview, over what the rail last showed")
  assert.equal(shownCompanion(open, apex, "files"), "files", "or what the person picked for this Thread")
  assert.equal(shownCompanion({ ...open, companion: null }, apex, "files"), null, "a closed rail stays closed")
  acpStore.set({ activeKey: OTHER })
  assert.equal(apexOnScreen(railAcpStore.get()), undefined, "a Thread with no Fins is no Apex")
  assert.equal(shownCompanion(open, undefined, undefined), "changes", "and keeps what the rail showed")
})

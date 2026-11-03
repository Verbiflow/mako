import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ThreadPage, ThreadRef } from "@mako/sessions"
import type { Entry } from "@mako/sessions/entries"
import type { ReportedSession } from "@mako/protocol/thread-listing"
import { HostJobs } from "@mako/host/base/host-jobs"
import type { MarkedProcess } from "@mako/host/base/marked-processes"
import { accessModeId } from "@mako/host/contracts/access"
import { childEntry, childMode, childState, type ThreadParent } from "@mako/host/contracts/agents"
import { AFTER_START, type AgentsStarted } from "@mako/host/contracts/agent-tools"
import { backgroundWork, backgroundWorkText } from "@mako/host/contracts/background-work"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { CHILDREN_BINDING, withChildren } from "@mako/host/contracts/native-agents"
import { listedAsThread, threadList } from "@mako/host/contracts/thread-list"
import { SessionIdSchema, ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { HANDED_OVER_NOTE } from "@mako/host/contracts/children"
import { END_CONFIRM_MS, lastStep } from "@mako/host/conversations/agent-runs"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { Agents, type AgentsDeps } from "@mako/host/conversations/agents"
import { FIN_LOAD, macSlots } from "@mako/host/conversations/mac-capacity"
import { uploadScope } from "@mako/host/conversations/session-uploads"
import { CLAUDE_MODES } from "@mako/host/harnesses/claude/sdk-driver"
import { CURSOR_SDK_MODES } from "@mako/host/harnesses/cursor/sdk/modes"
import { openCodeModes } from "@mako/host/harnesses/opencode/access"
import { ThreadStore } from "@mako/host/threads/store"
import { AgentsWorld, noConversations, type Script } from "./lib/agents-world.ts"

/**
 * The children engine (`npm run test:background-agents`): a child's state and
 * entry, the edge and reports in the store, and `Agents` on a host whose six
 * harnesses are scripted models: a spawn's receipt, its brief as the Apex's
 * words, the access ceiling, places, budgets, keys, a report waking its Apex
 * once, stops, waits, and a run a Thread's shell started followed to its end,
 * found by its process, while an Apex's own session never is one.
 */
const root = mkdtempSync(join(tmpdir(), "mako-agents-"))
const NOW = 1_800_000_000_000

function edge(overrides: Partial<ThreadParent> = {}): ThreadParent {
  const session = SessionIdSchema.parse(randomUUID())
  return {
    child: ThreadIdSchema.parse(randomUUID()),
    parent: ThreadIdSchema.parse(randomUUID()),
    parentSession: session,
    name: "review-the-sidebar",
    role: "worker",
    origin: "started",
    asked: { brief: { objective: "Review the sidebar" }, harness: "claude" },
    op: `start:${session}:${randomUUID()}`,
    startedBy: { kind: "agent", session },
    createdAt: NOW - 60_000,
    ...overrides,
  }
}

function report(child: ThreadParent["child"], status: "done" | "failed" | "progress" | "blocked", summary: string) {
  return { id: `report:${child}:${randomUUID()}`, child, status, summary, ownerGeneration: 1, at: NOW }
}

function statesAndEntries(): void {
  const started = edge()
  assert.deepEqual(childState(started, { source: "live", starting: "launching" }, {}), { kind: "starting", step: "launching" })
  assert.deepEqual(childState(started, { source: "live", working: true, step: "Shell npm test" }, {}), { kind: "working", step: "Shell npm test" })
  assert.deepEqual(childState(started, { source: "live", working: true }, { latest: report(started.child, "progress", "Half the rows are fixed. Next the footer.") }), { kind: "working", phase: "Half the rows are fixed." }, "a progress report is the phase it shows")
  assert.deepEqual(childState(started, { source: "live" }, { latest: report(started.child, "done", "Fixed it.") }), { kind: "ended", outcome: "done" })
  const blocked = { ...report(started.child, "blocked", "Which branch?"), question: "Main or next?" }
  assert.deepEqual(childState(started, { source: "live" }, { latest: blocked }), { kind: "blocked", question: "Main or next?", on: "lead", ask: { kind: "report", id: blocked.id } }, "a question in a report is an ask its Apex answers by the report")
  assert.deepEqual(childState({ ...started, closedAt: NOW }, { source: "live" }, {}), { kind: "ended", outcome: "stopped" }, "a closed delegation reads as stopped")
  assert.deepEqual(childState(started, { source: "live" }, {}), { kind: "idle" }, "a child between turns is idle: a message gives it its next one")
  assert.deepEqual(childState(started, { source: "followed", ended: { outcome: "unknown", at: NOW } }, {}).kind, "ended")

  const entry = childEntry(started, { source: "live", working: true, step: "Shell npm test", nativeId: "n", path: "/claude/n.jsonl", harness: "claude" }, {})
  assert.equal(entry.bindingId, CHILDREN_BINDING)
  assert.equal(entry.work, "agent", "a child is an agent entry, with no kind of its own")
  assert.deepEqual(entry.child, { thread: started.child, name: started.name, origin: "started", nativeId: "n", path: "/claude/n.jsonl", state: { kind: "working", step: "Shell npm test" } }, "its transcript opens from its Session's path; it carries its state as `childState` reads it")
  assert.equal(childEntry(started, { source: "live", working: true, conversation: "c-1" }, {}).child?.conversation, "c-1", "a live child names its conversation, which opens it live")
  assert.deepEqual(entry.state, { kind: "working", activity: "Shell npm test" })
  assert.equal(childEntry(started, { source: "live" }, { latest: report(started.child, "done", "Fixed it.") }).state.kind, "completed")
  assert.equal(childEntry(started, { source: "live", queued: { reason: "tree-running", ahead: 2 } }, {}).state.kind, "waiting")
  assert.equal(lastStep([{ type: "tool", id: "1", name: "Bash", input: JSON.stringify({ command: "npm test" }), status: "completed" }], "claude"), "Shell npm test")
}

function rosterAndLists(): void {
  const provider = { nativeId: "sub", title: "Explore", work: "agent" as const, state: { kind: "working" as const }, bindingId: "binding", provider: "claude", observedAt: NOW, stoppable: true }
  const child = childEntry(edge(), { source: "live", working: true }, {})
  const roster = withChildren({ agents: [provider], limited: false }, [child])
  assert.equal(roster?.agents.length, 2)
  assert.equal(withChildren(roster, [child]), roster, "the same children keep the same roster")
  const closed = backgroundWork({ status: "ready", connection: "hibernated" }, roster)
  assert.equal(closed?.count, 1, "a hibernated conversation still waits on its children, which are Mako's")
  assert.equal(backgroundWorkText(closed!), "an agent")
  const childRef: ThreadRef = { harness: "claude", nativeId: "h", path: "/h.jsonl", parent: { thread: randomUUID(), session: randomUUID() } }
  const own: ThreadRef = { harness: "claude", nativeId: "o", path: "/o.jsonl" }
  assert.equal(listedAsThread(childRef), false)
  assert.deepEqual(threadList([childRef, own]).map((ref) => ref.path), ["/o.jsonl"], "a child sits under its Apex, not in the rail")
}

function uploadsFollowParents(): void {
  const parent = randomUUID()
  const at = new Date(NOW - 60_000).toISOString()
  const rows: ReportedSession[] = [{ session: parent, thread: randomUUID(), conversation: "parent", harness: "codex", nativeId: "parent", title: "Parent", state: "idle", createdAt: at, activityAt: at, generation: 1 }]
  const scope = uploadScope(rows, { onBattery: false, percent: undefined, lowPower: false }, (harness, nativeId) => `/${harness}/${nativeId}`, NOW, (session) => (session === parent ? [{ harness: "cursor", nativeId: "helper" }] : []))
  assert.deepEqual(scope.sessions.map((session) => `${session.harness}:${session.nativeId}`), ["codex:parent", "cursor:helper"], "a child's Session syncs right after its parent's, under its Thread")
  assert.equal(scope.sessions[1]!.thread, scope.sessions[0]!.thread)
}

function storeKeeps(): void {
  const path = join(root, "keeps.sqlite")
  const threads = new ThreadStore(path, { now: () => Date.now() })
  const apex = threads.registerJournal({ conversationId: randomUUID(), createdAt: Date.now(), harness: "codex", bindings: [] }, { kind: "service", name: "workspace" })
  const placed = threads.registerJournal({ conversationId: randomUUID(), createdAt: Date.now(), harness: "claude", bindings: [] }, { kind: "service", name: "workspace" })
  const first = edge({ child: placed.thread, parent: apex.thread, parentSession: apex.session })
  assert.equal(threads.keepEdge(first).op, first.op)
  assert.equal(threads.keepEdge({ ...first, op: "start:other", parent: ThreadIdSchema.parse(randomUUID()) }).op, first.op, "one parent per child: the first edge stands")
  const run = { harness: "claude", nativeId: "n", device: threads.deviceId, startedAt: 1 }
  threads.keepEdge({ ...first, run: { ...run, ended: { at: 1, kind: "done" } } })
  const later = threads.keepEdge({ ...first, run: { ...run, ended: { at: 2, kind: "failed" } } })
  assert.deepEqual(later.run?.ended, { at: 1, kind: "done" }, "an end is written once")
  const told = report(first.child, "done", "Fixed it.")
  const kept = threads.keepReport(told)
  assert.ok("report" in kept && !kept.deduped)
  const again = threads.keepReport(told)
  assert.ok("report" in again && again.deduped, "a report's key makes a repeat the same report")
  assert.throws(() => threads.keepReport({ ...told, summary: "Something else." }), /conflict|different/i, "one key never names two reports")
  assert.deepEqual(threads.ancestors(first.child), [apex.thread])
  threads.close()
  const reopened = new ThreadStore(path, { now: () => Date.now() })
  assert.equal(reopened.edges().of(first.child)?.op, first.op, "edges are kept across hosts")
  assert.equal(reopened.reportsOf(first.child, 0).length, 1)
  reopened.close()
}

/** Each child does `does` with its brief; an Apex's turns start what the test asks and end. */
function world(name: string, does: Script, budget?: { running: number; started: number }) {
  return new AgentsWorld({ root: join(root, name), script: does, ...(budget && { budget }) })
}

async function startsAndWakes(): Promise<void> {
  let childTurns = 0
  const w = world("wakes", (turn) => {
    if (turn.text.includes("You're fin:")) {
      childTurns += 1
      return `Done: ${turn.harness} reviewed its part. The rest is in its transcript.`
    }
    return "Started them."
  })
  try {
    const apex = await w.apex("codex")
    const brief = { objective: "Review one part of the sidebar." }
    const answers: AgentsStarted[] = []
    for (const harness of ["claude", "cursor", "grok"]) {
      const answer = await w.agents.start(apex.caller, { brief, harness, name: `review-${harness}`, clientKey: `k-${harness}`, cwd: w.root })
      assert.ok(!("refused" in answer), JSON.stringify(answer))
      answers.push(answer)
    }
    assert.equal(answers[0]!.next, AFTER_START, "the receipt tells the Apex to end its turn, not wait")
    const again = await w.agents.start(apex.caller, { brief, harness: "claude", name: "review-claude", clientKey: "k-claude", cwd: w.root })
    assert.ok(!("refused" in again) && again.deduped && again.child === answers[0]!.child, "the same key answers the same child")
    const childConversation = answers[0]!.conversation!
    const first = w.live.snapshot(childConversation)?.requests[0]
    assert.ok(first?.text.startsWith("[mako · from your Apex (agent), not the person]"), "a child's brief says it's an agent's words")
    assert.equal(first?.actor?.kind, "agent", "and is the Apex's request, not the person's")
    await w.settle()
    assert.equal(childTurns, 3)
    const wakes = w.prompts.filter((prompt) => prompt.conversation === apex.conversation)
    assert.equal(wakes.length, 1, "three reports in one burst wake an idle apex once")
    assert.ok(wakes[0]!.text.startsWith(FROM_AGENTS))
    assert.match(wakes[0]!.text, /3 finished:/)
    assert.match(wakes[0]!.text, /0 working, 3 ended\./)
    const wake = w.live.snapshot(apex.conversation)!.requests.at(-1)!
    assert.equal(wake.actor?.kind, "agent", "a wake is an agent's request")
    const listed = await w.agents.list(apex.caller, {})
    assert.ok("children" in listed)
    assert.deepEqual(listed.children.map((strip) => strip.state.kind), ["ended", "ended", "ended"])
    assert.equal(listed.tree.started, 3)
    const read = await w.agents.read(apex.caller, { child: "review-cursor" })
    assert.ok("text" in read && /cursor reviewed its part/.test(read.text))
    const waited = await w.agents.wait(apex.caller, { timeoutMs: 50 })
    assert.ok("reports" in waited && waited.reports.length === 3 && !waited.timedOut, "a wait answers the reports already in")
    const after = await w.agents.wait(apex.caller, { timeoutMs: 50, after: waited.cursor })
    assert.ok("reports" in after && after.timedOut && !after.reports.length)
    assert.equal(w.agents.roster(apex.conversation).length, 3, "the Apex's roster has its three children")
    assert.equal(w.live.snapshot(apex.conversation)?.nativeAgents?.agents.filter((agent) => agent.child).length, 3, "and its snapshot serves them")
  } finally {
    await w.close()
  }
}

async function explicitReports(): Promise<void> {
  const w = world("explicit", async (turn) => {
    if (!turn.text.includes("You're fin:")) return "ok"
    const told = await turn.world.agents.report(turn.caller, { status: "blocked", summary: "Two schemas disagree.", question: "Keep the gateway's or the host's?", clientKey: "q1" })
    assert.ok(!("refused" in told), JSON.stringify(told))
    return "I asked my apex."
  })
  try {
    const apex = await w.apex("claude")
    const started = await w.agents.start(apex.caller, { brief: { objective: "Reconcile the schemas" }, harness: "devin", clientKey: "a", cwd: w.root })
    assert.ok(!("refused" in started))
    await w.settle()
    const reports = w.store.reportsOf(started.child!, 0)
    assert.equal(reports.length, 1, "a turn that reported gives no implicit report too")
    const wake = w.prompts.filter((prompt) => prompt.conversation === apex.conversation)
    assert.equal(wake.length, 1)
    assert.match(wake[0]!.text, /1 needs a decision:\n {2}• "[^"]+" \(Devin\) is blocked: Keep the gateway's or the host's\?/)
    const listed = await w.agents.list(apex.caller, {})
    assert.ok("children" in listed && listed.children[0]!.state.kind === "blocked")
    const own = await w.agents.report(apex.caller, { status: "done", summary: "x", clientKey: "z" })
    assert.ok("refused" in own && own.refused === "no-parent", "a Thread nobody started has no apex to report to")
  } finally {
    await w.close()
  }
}

async function macRoom(): Promise<void> {
  const GB = 1024 ** 3
  // The person's Mac as it stood when Fins took it over: 14 cores, 36 GB, 13 Fins at work and the load at 26.8.
  assert.deepEqual(macSlots({ cores: 14, memoryBytes: 36 * GB, load: 26.8 }, 13).slots, 5, "13 Fins at once is more than this Mac runs")
  assert.equal(macSlots({ cores: 14, memoryBytes: 36 * GB, load: 0 }, 0).slots, 6, "an idle 14-core Mac runs six")
  assert.equal(macSlots({ cores: 14, memoryBytes: 36 * GB, load: 8 }, 0).slots, 2, "the person's own work takes its cores first")
  assert.equal(macSlots({ cores: 14, memoryBytes: 8 * GB, load: 0 }, 0).slots, 4, "memory bounds it too")
  assert.equal(macSlots({ cores: 4, memoryBytes: 16 * GB, load: 6 }, 0).slots, 1, "a small, busy Mac still runs one at a time")
  assert.equal(macSlots({ cores: 14, memoryBytes: 36 * GB, load: 0, swapFreeBytes: 100 * 1024 ** 2 }, 0).slots, 0, "a Mac out of swap takes none")
  assert.equal(macSlots({ cores: 14, memoryBytes: 36 * GB, load: 8 }, 0).why, "14 cores, 36 GB, 8 cores of other work")

  // A 6-core Mac: room for two Fins with nothing else at work. Each working Fin's load is FIN_LOAD.
  let others = 0
  let working = 0
  const w = new AgentsWorld({
    root: join(root, "mac-room"),
    script: (turn) => turn.text.includes("You're fin:") ? (working++, turn.world.hold(turn.conversation).then(() => (working--, "stopped"))) : "ok",
    capacity: { read: async () => ({ cores: 6, memoryBytes: 16 * GB, load: working * FIN_LOAD + others }) },
  })
  try {
    const apex = await w.apex("opencode")
    const other = await w.apex("claude")
    const brief = { objective: "Hold" }
    const one = await w.agents.start(apex.caller, { brief, name: "one", clientKey: "1", cwd: w.root })
    const two = await w.agents.start(apex.caller, { brief, name: "two", clientKey: "2", cwd: w.root })
    assert.ok(!("refused" in one) && !("refused" in two) && one.mac?.slots === 2, JSON.stringify(one))
    await waitFor(() => working === 2, "both Fins at work")
    const three = await w.agents.start(apex.caller, { brief, name: "three", clientKey: "3", cwd: w.root })
    assert.ok(!("refused" in three) && three.state === "queued" && !three.child, "past this Mac's room a spawn queues, whatever the tree's budget")
    assert.equal(three.why, "This Mac is busy: it runs 2 Fins at once now (6 cores, 16 GB) and 2 are at work; it starts when one ends or the Mac frees up (0 ahead).")
    assert.deepEqual(three.mac, { working: 2, slots: 2, why: "6 cores, 16 GB" }, "the Apex sees the Mac's room in the answer")
    const four = await w.agents.start(other.caller, { brief, name: "four", clientKey: "4", cwd: w.root })
    assert.ok(!("refused" in four) && four.state === "queued" && /\(1 ahead\)/.test(four.why ?? ""), `another tree's spawn waits behind it: the Mac's room is first come, first started: ${JSON.stringify(four)}`)
    const waiting = (apexConversation: string) => w.agents.roster(apexConversation).flatMap((entry) => (entry.state.kind === "waiting" ? [entry.state.reason] : []))
    assert.deepEqual(waiting(apex.conversation), ["Queued: this Mac is busy, 0 ahead"])
    assert.deepEqual(waiting(other.conversation), ["Queued: this Mac is busy, 1 ahead"])
    // The person starts a build of their own: it takes the cores a Fin that ends would have freed.
    others = 2
    await w.agents.stop(apex.caller, { child: "one" })
    await waitFor(() => working === 1, "one ended")
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(w.store.queuedSpawns().length, 2, "a Mac busy with the person's own work starts nothing more")
    others = 0
    await w.agents.stop(apex.caller, { child: "two" })
    await waitFor(() => w.store.queuedSpawns().length === 0 && working === 2, "both waiting spawns to start once the build ended and a Fin did")
    assert.deepEqual(w.store.edges().all.map((edge) => edge.name).sort(), ["four", "one", "three", "two"], "first come, first started")
    await w.agents.stop(apex.caller, { child: "all" })
    await w.agents.stop(other.caller, { child: "all" })
  } finally {
    await w.close()
  }
}

async function refusals(): Promise<void> {
  const w = world("refusals", (turn) => turn.text.includes("You're fin:") ? turn.world.hold(turn.conversation).then(() => "stopped") : "ok", { running: 2, started: 3 })
  try {
    const apex = await w.apex("opencode")
    const brief = { objective: "Hold" }
    const place = await w.agents.start(apex.caller, { brief, place: "cloud", clientKey: "p", cwd: w.root })
    assert.ok("refused" in place && place.refused === "place-unavailable", "8.1 starts children here only")
    const device = await w.agents.start(apex.caller, { brief, place: "device:Studio", clientKey: "d", cwd: w.root })
    assert.ok("refused" in device && device.refused === "place-unavailable")
    const harness = await w.agents.start(apex.caller, { brief, harness: "nope", clientKey: "h", cwd: w.root })
    assert.ok("refused" in harness && harness.refused === "unknown-harness")
    const person = await w.agents.start({ kind: "person" }, { brief, clientKey: "x", cwd: w.root })
    assert.ok("refused" in person && person.refused === "no-parent")
    const one = await w.agents.start(apex.caller, { brief, name: "one", clientKey: "1", cwd: w.root })
    const two = await w.agents.start(apex.caller, { brief, name: "two", clientKey: "2", cwd: w.root })
    assert.ok(!("refused" in one) && !("refused" in two))
    const three = await w.agents.start(apex.caller, { brief, name: "three", clientKey: "3", cwd: w.root })
    assert.ok(!("refused" in three) && three.state === "queued" && !three.child, "past the running budget a spawn queues")
    assert.match(three.why ?? "", /runs 2 of its 2 at once/)
    assert.equal(w.agents.roster(apex.conversation).length, 3, "a queued spawn shows, saying why")
    const four = await w.agents.start(apex.caller, { brief, name: "four", clientKey: "4", cwd: w.root })
    assert.ok("refused" in four && four.refused === "budget", "past the started budget a spawn is refused, with the count, a queued one counted")
    assert.match(four.why, /started 2 of its 3 Threads and 1 more wait to/)
    const stopped = await w.agents.stop(apex.caller, { child: "one" })
    assert.deepEqual("stopped" in stopped && stopped.stopped, ["one"])
    await waitFor(() => w.store.edges().children(w.store.journalPlacement(apex.conversation)!.thread).length === 3, "the queued spawn to start when one ended")
    assert.equal(w.store.queuedSpawns().length, 0)
    const five = await w.agents.start(apex.caller, { brief, name: "five", clientKey: "5", cwd: w.root })
    assert.ok("refused" in five && five.refused === "budget")
    assert.match(five.why, /started 3 of its 3/)
    const childCaller = w.caller(two.conversation!)
    const wider = await w.agents.start(childCaller, { brief, access: "full", clientKey: "w", cwd: w.root })
    assert.ok("refused" in wider && wider.refused === "access", "a child runs at most at its Apex's access")
    const six = await w.agents.start(childCaller, { brief, name: "six", clientKey: "6", cwd: w.root })
    assert.ok("refused" in six && six.refused === "budget", "a sub-Apex's spawn spends its tree's budget")
    const all = await w.agents.stop(apex.caller, { child: "all" })
    assert.deepEqual("stopped" in all && [...all.stopped].sort(), ["three", "two"], "stopping all stops what still runs")
  } finally {
    await w.close()
  }
}

/** A child starts in its own harness's mode for its tier, and an Apex whose harness names its modes its own way has the tier its mode carries. */
async function harnessLadders(): Promise<void> {
  assert.deepEqual(childMode(openCodeModes, "auto"), { id: accessModeId("edits"), tier: "edits" }, "a tier the harness lacks takes its nearest one below")
  assert.deepEqual(childMode(CLAUDE_MODES, "deny"), { id: "dontAsk", tier: "deny" })
  assert.equal(childMode(CURSOR_SDK_MODES, "edits"), undefined)
  assert.deepEqual(childMode(undefined, "ask"), { id: accessModeId("ask"), tier: "ask" })
  const w = new AgentsWorld({
    root: join(root, "ladders"),
    script: (turn) => turn.text.includes("You're fin:") ? "done" : "ok",
    ladders: { claude: CLAUDE_MODES, cursor: CURSOR_SDK_MODES },
  })
  try {
    const apex = await w.apex("claude", "full")
    await waitFor(() => w.live.session(apex.conversation)?.currentMode === "bypassPermissions", "the Apex to open in Bypass permissions")
    const brief = { objective: "Look" }
    const cursor = await w.agents.start(apex.caller, { brief, harness: "cursor", name: "fin", clientKey: "c", cwd: w.root })
    const claude = await w.agents.start(apex.caller, { brief, harness: "claude", access: "edits", name: "ed", clientKey: "e", cwd: w.root })
    assert.ok(!("refused" in cursor) && !("refused" in claude), JSON.stringify([cursor, claude]))
    await w.settle()
    assert.equal(w.live.session(cursor.conversation!)?.currentMode, "full-access", "a Cursor child under an Apex on full runs in Cursor's one mode")
    assert.equal(w.live.session(claude.conversation!)?.currentMode, "acceptEdits")
    assert.ok(w.prompts.some((prompt) => prompt.conversation === cursor.conversation), "the Cursor child was sent its brief")
    const asks = await w.apex("claude", "ask")
    await waitFor(() => w.live.session(asks.conversation)?.currentMode === "default", "the second apex to open in Ask for approval")
    const above = await w.agents.start(asks.caller, { brief, harness: "cursor", clientKey: "a", cwd: w.root })
    assert.ok("refused" in above && above.refused === "access", "an Apex on ask can't start a child on a harness that runs only on full")
    assert.match(above.why, /Cursor runs on full, each above ask/)
  } finally {
    await w.close()
  }
}

async function stopAllUnqueues(): Promise<void> {
  const w = world("unqueues", (turn) => turn.text.includes("You're fin:") ? turn.world.hold(turn.conversation).then(() => "stopped") : "ok", { running: 1, started: 10 })
  try {
    const apex = await w.apex("grok")
    const brief = { objective: "Hold" }
    await w.agents.start(apex.caller, { brief, name: "runs", clientKey: "1", cwd: w.root })
    const waits = await w.agents.start(apex.caller, { brief, name: "waits", clientKey: "2", cwd: w.root })
    assert.ok(!("refused" in waits) && waits.state === "queued")
    const again = await w.agents.start(apex.caller, { brief, name: "waits", clientKey: "2", cwd: w.root })
    assert.ok(!("refused" in again) && again.deduped && again.state === "queued", "a repeated queued spawn is the same spawn")
    const all = await w.agents.stop(apex.caller, { child: "all" })
    assert.deepEqual("stopped" in all && [...all.stopped].sort(), ["runs", "waits"], "stopping all also drops what's queued")
    assert.equal(w.store.queuedSpawns().length, 0)
  } finally {
    await w.close()
  }
}

async function waitFor(check: () => boolean, what: string, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function fakeCatalog() {
  const sessions = new Map<string, { ref: ThreadRef; entries: Entry[] }>()
  const subscribers = new Set<(event: HostEvent) => void>()
  const catalog: AgentsDeps["catalog"] = {
    nativePath: (identity) => [...sessions.values()].find((session) => session.ref.harness === identity.harness && session.ref.nativeId === identity.nativeId)?.ref.path,
    ref: (path) => sessions.get(path)?.ref,
    async page(path, before, limit = 50) {
      const session = sessions.get(path)
      if (!session) return null
      const end = before ?? session.entries.length
      const start = Math.max(0, end - limit)
      return { ref: session.ref, entries: session.entries.slice(start, end), start, total: session.entries.length, hasEarlier: start > 0 } satisfies ThreadPage
    },
    activity: () => ({}),
    subscribe(subscriber) {
      subscribers.add(subscriber)
      return () => subscribers.delete(subscriber)
    },
    announce: () => {},
  }
  return {
    catalog,
    write(ref: ThreadRef, entries: Entry[]) {
      sessions.set(ref.path, { ref, entries })
      for (const subscriber of subscribers) subscriber({ type: "thread-ref", ref })
    },
  }
}

/** A harness CLI a Thread's shell started: found by `MAKO_SESSION_ID`, followed by its Session and process, ended once with its last reply as its report. */
async function followsShellRuns(): Promise<void> {
  const threads = new ThreadStore(join(root, "follows.sqlite"), { now: () => Date.now() })
  const apex = threads.registerJournal({ conversationId: randomUUID(), createdAt: Date.now(), harness: "codex", bindings: [] }, { kind: "service", name: "workspace" })
  const fake = fakeCatalog()
  const jobs = new HostJobs()
  const folder = realpathSync(root)
  const changed: string[] = []
  const agents = new Agents({
    store: () => threads,
    catalog: fake.catalog,
    jobs,
    live: noConversations((conversation) => changed.push(conversation)),
    startLive: () => Promise.reject(new Error("This test starts no conversation")),
    harnesses: () => ["claude"],
    runs: () => true,
    harnessLabel: () => "Claude",
    modes: () => undefined,
  })
  const shell = spawn("/bin/sh", ["-c", "sleep 30"], { cwd: folder, env: { ...process.env, MAKO_SESSION_ID: apex.session }, stdio: "ignore" })
  try {
    const nativeId = randomUUID()
    fake.write({ harness: "claude", nativeId, path: `/claude/${nativeId}.jsonl`, cwd: folder, startedAt: new Date().toISOString() }, [
      { type: "tool", id: "1", name: "Bash", input: JSON.stringify({ command: "npm test" }), status: "completed" },
    ])
    const linked = await agents.link({ kind: "agent", session: apex.session }, { harness: "claude", session: nativeId, pid: shell.pid! })
    assert.ok(!("refused" in linked), JSON.stringify(linked))
    assert.equal(linked.origin, "linked")
    const child = ThreadIdSchema.parse(linked.child)
    await waitFor(() => (agents.runs.reading(child)?.working ?? false), "the run read as working")
    const cycle = await agents.link({ kind: "agent", session: threads.thread(child)!.sessions[0]! }, { harness: "claude", session: nativeId })
    assert.ok("refused" in cycle, "a child can't take its own run, or an ancestor's, as its child")
    fake.write({ harness: "claude", nativeId, path: `/claude/${nativeId}.jsonl`, cwd: folder, startedAt: new Date().toISOString() }, [
      { type: "tool", id: "1", name: "Bash", input: JSON.stringify({ command: "npm test" }), status: "completed" },
      { type: "text", id: "2", text: "All green: the sidebar is clean." },
    ])
    shell.kill("SIGTERM")
    await waitFor(() => threads.edges().of(child)?.run?.ended !== undefined, "its end, once its process exited", END_CONFIRM_MS + 20_000)
    const reports = threads.reportsOf(child, 0)
    assert.equal(reports.length, 1, "a followed run's end is one implicit report")
    assert.match(reports[0]!.summary, /sidebar is clean/)
  } finally {
    shell.kill()
    agents.dispose()
    jobs.stop()
    threads.close()
  }
}

function sleeper(cwd: string) {
  return spawn("/bin/sh", ["-c", "sleep 60"], { cwd, stdio: "ignore" })
}

function runs(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * A run its Apex linked, then linked again in the process that resumed its chat: followed there, so the first
 * process's end isn't its end. One whose process goes is followed into the process of its Apex's shell that holds
 * its Session, and is declared ended only once its Session stays quiet. Its link's name is its title.
 */
async function relinkedRuns(): Promise<void> {
  const threads = new ThreadStore(join(root, "relinked.sqlite"), { now: () => Date.now() })
  const apex = threads.registerJournal({ conversationId: randomUUID(), createdAt: Date.now(), harness: "cursor", bindings: [] }, { kind: "service", name: "workspace" })
  const fake = fakeCatalog()
  const jobs = new HostJobs()
  const folder = realpathSync(root)
  let successor: number | undefined
  const agents = new Agents({
    store: () => threads,
    catalog: fake.catalog,
    jobs,
    live: noConversations(() => {}),
    startLive: () => Promise.reject(new Error("This test starts no conversation")),
    harnesses: () => ["cursor"],
    runs: () => true,
    harnessLabel: () => "Cursor",
    modes: () => undefined,
    processes: {
      marked: async () => (successor === undefined ? [] : [{ pid: successor, value: apex.session }]),
      holding: async (_file, pids) => new Set(pids.filter((pid) => pid === successor)),
      folders: async () => new Map(),
      startedAt: async () => Date.now(),
    },
  })
  const [first, second, third] = [sleeper(folder), sleeper(folder), sleeper(folder)]
  try {
    const nativeId = randomUUID()
    const session = (entries: Entry[]) => fake.write({ harness: "cursor", nativeId, path: `/cursor/${nativeId}/store.db`, cwd: folder, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), title: "You are a headless worker started by the coordinator" }, entries)
    session([{ type: "tool", id: "1", name: "Bash", input: JSON.stringify({ command: "npm test" }), status: "completed" }])
    const caller = { kind: "agent" as const, session: apex.session }
    const linked = await agents.link(caller, { harness: "cursor", session: nativeId, pid: first.pid!, name: "worker" })
    assert.ok(!("refused" in linked), JSON.stringify(linked))
    const child = ThreadIdSchema.parse(linked.child)
    const listed = await agents.list(caller, {})
    assert.ok("children" in listed)
    assert.equal(listed.children[0]!.title, "worker", "a link's name is its Fin's title, not its first prompt's line")
    assert.equal(threads.thread(child)?.title, "worker", "and its Thread's")
    const again = await agents.link(caller, { harness: "cursor", session: nativeId, pid: second.pid! })
    assert.ok(!("refused" in again) && again.deduped && again.child === linked.child, JSON.stringify(again))
    assert.equal(threads.edges().of(child)?.run?.process?.pid, second.pid, "a re-link follows the run in the process it names")
    first.kill("SIGTERM")
    successor = third.pid
    second.kill("SIGTERM")
    // The chat resumed in the third process writes its session as it goes.
    const writing = setInterval(() => session([{ type: "tool", id: "1", name: "Bash", input: JSON.stringify({ command: "npm test" }), status: "completed" }]), 500)
    try {
      await waitFor(() => threads.edges().of(child)?.run?.process?.pid === third.pid, "the run followed into the process holding its session", 15_000)
    } finally {
      clearInterval(writing)
    }
    assert.equal(threads.edges().of(child)?.run?.ended, undefined, "a chat resumed in another process hasn't ended")
    assert.equal(threads.reportsOf(child, 0).length, 0)
    successor = undefined
    session([
      { type: "tool", id: "1", name: "Bash", input: JSON.stringify({ command: "npm test" }), status: "completed" },
      { type: "text", id: "2", text: "All green." },
    ])
    third.kill("SIGTERM")
    await new Promise((resolve) => setTimeout(resolve, 4_500))
    assert.equal(threads.edges().of(child)?.run?.ended, undefined, "a gone process's run ends only once its session stays quiet")
    await waitFor(() => threads.edges().of(child)?.run?.ended !== undefined, "its end", END_CONFIRM_MS + 20_000)
    assert.deepEqual(threads.reportsOf(child, 0).map((told) => [told.status, told.summary]), [["done", "All green."]], "and it ends once, as its session last shows")
  } finally {
    for (const shell of [first, second, third]) shell.kill()
    agents.dispose()
    jobs.stop()
    threads.close()
  }
}

/**
 * A message to a Fin a CLI its Apex's shell started runs: the run is stopped and its own Session resumed in the
 * Fin's Thread on Mako's live driver, the message its next turn, saying its last step may have been cut short.
 */
async function messagesReachLinkedRuns(): Promise<void> {
  const fake = fakeCatalog()
  const w = new AgentsWorld({
    root: join(root, "taken-over"),
    script: (turn) => (turn.text.includes("fix the footer") ? "Footer fixed." : "ok"),
    catalog: fake.catalog,
    processes: { marked: async () => [], holding: async () => new Set(), folders: async () => new Map(), startedAt: async () => Date.now() },
  })
  const run = sleeper(w.root)
  try {
    const apex = await w.apex("claude", "full")
    const nativeId = randomUUID()
    fake.write({ harness: "claude", nativeId, path: join(w.root, "cli", `${nativeId}.jsonl`), cwd: w.root, startedAt: new Date().toISOString(), title: "You are a headless worker" }, [
      { type: "user", id: "1", text: "You are a headless worker. Fix the sidebar." },
      { type: "tool", id: "2", name: "Bash", input: JSON.stringify({ command: "npm test" }), status: "completed" },
    ])
    const linked = await w.agents.link(apex.caller, { harness: "claude", session: nativeId, pid: run.pid!, name: "cli" })
    assert.ok(!("refused" in linked), JSON.stringify(linked))
    const sent = await w.agents.send(apex.caller, { to: "cli", text: "Also fix the footer.", clientKey: "m1" })
    assert.ok(!("refused" in sent), JSON.stringify(sent))
    assert.equal(sent.delivery, "turn")
    assert.equal(runs(run.pid!), false, "its run was stopped first")
    await w.settle()
    const prompt = w.prompts.find((asked) => asked.text.includes("Also fix the footer."))
    assert.ok(prompt, "the message reached its session")
    assert.ok(prompt.text.includes(HANDED_OVER_NOTE), "saying its last step may have been cut short")
    assert.equal(w.store.journalPlacement(prompt.conversation)?.thread, linked.child, "in the Fin's own Thread")
    assert.equal(w.live.session(prompt.conversation)?.nativeId, nativeId, "resuming its own session")
    assert.deepEqual(w.store.reportsOf(ThreadIdSchema.parse(linked.child), 0).map((told) => [told.status, told.summary]), [["done", "Footer fixed."]], "the stopped run reports nothing; the turn that took the message reports how it went")
    const next = await w.agents.send(apex.caller, { to: "cli", text: "And the header.", clientKey: "m2" })
    assert.ok(!("refused" in next) && next.delivery === "turn", JSON.stringify(next))
    await w.settle()
    assert.equal(w.prompts.find((asked) => asked.text.includes("And the header."))?.conversation, prompt.conversation, "Mako drives it from then on")
  } finally {
    run.kill()
    await w.close()
  }
}

/** A Fin its Apex stops ends as stopped, in the Apex's words, and its cut turn reports nothing: the Apex asked, so it isn't woken. */
async function apexStops(): Promise<void> {
  const w = world("apex-stops", (turn) => (turn.text.includes("You're fin:") ? turn.world.hold(turn.conversation).then(() => "Cut short.") : "ok"))
  try {
    const apex = await w.apex("cursor")
    const started = await w.agents.start(apex.caller, { brief: { objective: "Hold" }, name: "slow", clientKey: "s", cwd: w.root })
    assert.ok(!("refused" in started), JSON.stringify(started))
    await waitFor(() => w.live.session(started.conversation!)?.status === "running", "the Fin to work")
    const stopped = await w.agents.stop(apex.caller, { child: "slow", reason: "restarting on another model" })
    assert.deepEqual("stopped" in stopped && stopped.stopped, ["slow"])
    await w.settle()
    assert.deepEqual(w.store.reportsOf(ThreadIdSchema.parse(started.child!), 0), [], "the turn the stop cut short reports nothing")
    assert.equal(w.prompts.filter((prompt) => prompt.conversation === apex.conversation).length, 0, "and the Apex that stopped it isn't woken")
    const listed = await w.agents.list(apex.caller, {})
    assert.ok("children" in listed)
    assert.deepEqual(listed.children[0]!.state, { kind: "ended", outcome: "stopped", reason: "restarting on another model" }, "it ended as stopped, with the Apex's reason")
  } finally {
    await w.close()
  }
}

/** An end the host wrote for a followed run whose Session is written again since isn't in the digest: the Fin reads as working. */
async function staleEndsStayOut(): Promise<void> {
  const fake = fakeCatalog()
  const w = new AgentsWorld({
    root: join(root, "stale-ends"),
    script: (turn) => (turn.text === "Hold on." ? turn.world.hold(turn.conversation).then(() => "Done holding.") : "ok"),
    catalog: fake.catalog,
    processes: { marked: async () => [], holding: async () => new Set(), folders: async () => new Map(), startedAt: async () => Date.now() },
  })
  const run = sleeper(w.root)
  try {
    const apex = await w.apex("cursor")
    w.say(apex.conversation, "Hold on.")
    await waitFor(() => w.live.session(apex.conversation)?.status === "running", "the Apex's turn to run")
    const nativeId = randomUUID()
    const session = () => fake.write({ harness: "cursor", nativeId, path: join(w.root, "cli", nativeId), cwd: w.root, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, [
      { type: "tool", id: "1", name: "Bash", input: JSON.stringify({ command: "npm test" }), status: "completed" },
    ])
    session()
    const linked = await w.agents.link(apex.caller, { harness: "cursor", session: nativeId, pid: run.pid!, name: "cli" })
    assert.ok(!("refused" in linked), JSON.stringify(linked))
    const child = ThreadIdSchema.parse(linked.child)
    run.kill("SIGTERM")
    await waitFor(() => w.store.edges().of(child)?.run?.ended !== undefined, "its end", END_CONFIRM_MS + 20_000)
    assert.equal(w.store.reportsOf(child, 0).at(-1)?.status, "failed")
    session()
    w.release(apex.conversation)
    await w.settle()
    assert.equal(w.prompts.filter((prompt) => prompt.conversation === apex.conversation && prompt.text.includes(FROM_AGENTS)).length, 0, "no digest says it ended while its session is written")
    session()
    const listed = await w.agents.list(apex.caller, {})
    assert.ok("children" in listed)
    assert.equal(listed.children[0]!.state.kind, "working", "it reads as working")
  } finally {
    run.kill()
    await w.close()
  }
}

/**
 * A Fin whose turn ends while its own Fins work, or while the move it asked for waits, hasn't finished: it reads as
 * working on what it waits for, its Apex isn't woken, and its result is the turn after that work ends.
 */
async function waitingFins(): Promise<void> {
  const helpers: string[] = []
  let moving = false
  const w = new AgentsWorld({
    root: join(root, "waiting-fins"),
    movePending: () => moving,
    script: async (turn) => {
      if (turn.text.includes("You're fin:capy")) {
        for (const name of ["one", "two"]) {
          const started = await turn.world.agents.start(turn.caller, { brief: { objective: `Part ${name}` }, name, clientKey: name, cwd: turn.world.root })
          if (!("refused" in started) && started.conversation) helpers.push(started.conversation)
        }
        return "Nothing is finished yet."
      }
      if (turn.text.includes("You're fin:one") || turn.text.includes("You're fin:two")) return turn.world.hold(turn.conversation).then(() => "My part is done.")
      if (turn.text.includes("You're fin:mover")) {
        moving = true
        return "Moving to the worktree; I'll carry on there."
      }
      if (turn.text.includes("Carry on in the worktree.")) return "Moved and finished the work."
      if (turn.text.includes(FROM_AGENTS) && turn.text.includes("My part is done")) return "Both parts are done: all good."
      return "ok"
    },
  })
  try {
    const apex = await w.apex("claude")
    const capy = await w.agents.start(apex.caller, { brief: { objective: "Split the UX review" }, name: "capy", clientKey: "capy", cwd: w.root })
    assert.ok(!("refused" in capy), JSON.stringify(capy))
    await waitFor(() => helpers.length === 2 && w.live.session(capy.conversation!)?.status === "ready" && w.live.held(capy.conversation!)?.requests.at(-1)?.status === "completed", "capy's turn to end")
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const child = ThreadIdSchema.parse(capy.child!)
    assert.deepEqual(w.store.reportsOf(child, 0), [], "a turn that ends on its own Fins' work isn't its result")
    assert.equal(w.prompts.filter((prompt) => prompt.conversation === apex.conversation).length, 0, "and doesn't wake its Apex")
    const listed = await w.agents.list(apex.caller, {})
    assert.ok("children" in listed)
    assert.deepEqual(listed.children[0]!.state, { kind: "working", step: "Waiting for its 2 Fins (one, two)" }, "it reads as working on what it waits for")
    assert.equal(listed.tree.running, 2, "but holds no place its own Fins need: only they run against the budgets")
    for (const helper of helpers) w.release(helper)
    await w.settle()
    assert.deepEqual(w.store.reportsOf(child, 0).map((told) => [told.status, told.summary]), [["done", "Both parts are done: all good."]], "its result is the turn after its Fins' work")
    const wakes = w.prompts.filter((prompt) => prompt.conversation === apex.conversation)
    assert.equal(wakes.length, 1)
    assert.match(wakes[0]!.text, /Both parts are done/)
    assert.doesNotMatch(wakes[0]!.text, /Nothing is finished yet/)

    const mover = await w.agents.start(apex.caller, { brief: { objective: "Move and work" }, name: "mover", clientKey: "mover", cwd: w.root })
    assert.ok(!("refused" in mover), JSON.stringify(mover))
    await waitFor(() => w.live.held(mover.conversation!)?.requests.at(-1)?.status === "completed", "mover's turn to end")
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    assert.deepEqual(w.store.reportsOf(ThreadIdSchema.parse(mover.child!), 0), [], "a turn that ends on the move it asked for isn't its result")
    const moved = await w.agents.list(apex.caller, {})
    assert.ok("children" in moved)
    assert.deepEqual(moved.children.find((strip) => strip.name === "mover")!.state, { kind: "working", step: "Waiting for its move into its own worktree" })
    moving = false
    w.say(mover.conversation!, "Carry on in the worktree.")
    await w.settle()
    assert.deepEqual(w.store.reportsOf(ThreadIdSchema.parse(mover.child!), 0).map((told) => [told.status, told.summary]), [["done", "Moved and finished the work."]])
  } finally {
    await w.close()
  }
}

/** A Fin runs on the model its spawn names, else its Apex's own on the Apex's harness, else its harness's default; its strip shows it. */
async function finModels(): Promise<void> {
  const w = new AgentsWorld({
    root: join(root, "models"),
    script: (turn) => (turn.text.includes("You're fin:") ? "done" : "ok"),
    defaults: { claude: { model: "claude-sonnet-5", options: { effort: "medium" } } },
  })
  try {
    const apex = await w.apex("cursor", "full", { model: "claude-opus-5-5", options: { effort: "high" } })
    const brief = { objective: "Look" }
    const same = await w.agents.start(apex.caller, { brief, name: "same", clientKey: "s", cwd: w.root })
    const other = await w.agents.start(apex.caller, { brief, harness: "claude", name: "other", clientKey: "o", cwd: w.root })
    const named = await w.agents.start(apex.caller, { brief, harness: "cursor", model: "gpt-6", reasoning: "low", name: "named", clientKey: "n", cwd: w.root })
    assert.ok(!("refused" in same) && !("refused" in other) && !("refused" in named), JSON.stringify([same, other, named]))
    const asked = (answer: AgentsStarted) => w.live.snapshot(answer.conversation!)?.requests[0]?.tuning
    assert.deepEqual(asked(same), { model: "claude-opus-5-5", options: { effort: "high" } }, "a Fin on its Apex's harness runs on the Apex's model and reasoning, not the harness's default")
    assert.deepEqual(asked(other), { model: "claude-sonnet-5", options: { effort: "medium" } }, "one on another harness runs on that harness's default")
    assert.deepEqual(asked(named), { model: "gpt-6", options: { effort: "low" } })
    await w.settle()
    const listed = await w.agents.list(apex.caller, {})
    assert.ok("children" in listed)
    assert.deepEqual(listed.children.map((strip) => [strip.name, strip.model]), [["same", "claude-opus-5-5"], ["other", "claude-sonnet-5"], ["named", "gpt-6"]], "each strip shows its model")
    assert.deepEqual(w.agents.roster(apex.conversation).map((entry) => entry.model), ["claude-opus-5-5", "claude-sonnet-5", "gpt-6"], "and so does each Fin's row")
  } finally {
    await w.close()
  }
}

/**
 * An Apex's own harness carries `MAKO_SESSION_ID` and writes its new session before its driver names it: that
 * session is the Apex's, never a run its shell started, or each of its turns would end as a report that wakes it.
 * A session its shell starts once it runs is one.
 */
async function ownSessionIsNoChild(): Promise<void> {
  const folder = join(root, "own-session")
  const fake = fakeCatalog()
  /** The Apex's harness, started in its folder with its Session in its environment. */
  const marked: MarkedProcess[] = []
  const at = () => new Date().toISOString()
  const w: AgentsWorld = new AgentsWorld({
    root: folder,
    script: () => "ok",
    catalog: fake.catalog,
    processes: {
      marked: async () => marked,
      holding: async () => new Set(),
      folders: async (pids) => new Map(pids.map((pid) => [pid, folder])),
      startedAt: async () => Date.now(),
    },
    async starting(conversation, harness) {
      const session = w.store.journalPlacement(conversation)?.session
      assert.ok(session, "an Apex has its Session before its harness starts")
      marked.push({ pid: process.pid, value: session })
      fake.write({ harness, nativeId: `native-${conversation}`, path: `/opencode/native-${conversation}`, cwd: folder, startedAt: at() }, [])
      await w.agents.runs.discovered()
    },
  })
  try {
    const apex = await w.apex("opencode")
    await waitFor(() => w.live.session(apex.conversation)?.nativeId !== undefined, "the Apex's harness to name its session")
    assert.equal(w.store.edges().byRun("opencode", `native-${apex.conversation}`), undefined, "an Apex's own session isn't its child")
    const nativeId = randomUUID()
    fake.write({ harness: "opencode", nativeId, path: `/opencode/${nativeId}`, cwd: folder, startedAt: at() }, [])
    await w.agents.runs.discovered()
    assert.equal(w.store.edges().byRun("opencode", nativeId)?.origin, "discovered", "a session its shell started is its child")
  } finally {
    await w.close()
  }
}

try {
  statesAndEntries()
  rosterAndLists()
  uploadsFollowParents()
  storeKeeps()
  await startsAndWakes()
  await explicitReports()
  await refusals()
  await macRoom()
  await harnessLadders()
  await stopAllUnqueues()
  await followsShellRuns()
  await relinkedRuns()
  await messagesReachLinkedRuns()
  await finModels()
  await apexStops()
  await staleEndsStayOut()
  await waitingFins()
  await ownSessionIsNoChild()
  console.log("agents engine: ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}

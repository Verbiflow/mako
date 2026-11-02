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
import { accessModeId } from "@mako/host/contracts/access"
import { childEntry, childMode, childState, type ThreadParent } from "@mako/host/contracts/agents"
import { AFTER_START, type AgentsStarted } from "@mako/host/contracts/agent-tools"
import { backgroundWork, backgroundWorkText } from "@mako/host/contracts/background-work"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { CHILDREN_BINDING, withChildren } from "@mako/host/contracts/native-agents"
import { listedAsThread, threadList } from "@mako/host/contracts/thread-list"
import { SessionIdSchema, ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { lastStep } from "@mako/host/conversations/agent-runs"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { Agents, type AgentsDeps } from "@mako/host/conversations/agents"
import { uploadScope } from "@mako/host/conversations/session-uploads"
import { CLAUDE_MODES } from "@mako/host/harnesses/claude/sdk-driver"
import { CURSOR_SDK_MODES } from "@mako/host/harnesses/cursor/sdk/modes"
import { openCodeModes } from "@mako/host/harnesses/opencode/access"
import { ThreadStore } from "@mako/host/threads/store"
import { AgentsWorld, noConversations, type Script } from "./lib/agents-world.ts"

/**
 * The children engine (`npm run test:background-agents`): a child's state and
 * entry, the edge and reports in the store, and `Agents` on a host whose six
 * harnesses are scripted models: a spawn's receipt, its brief as the lead's
 * words, the access ceiling, places, budgets, keys, a report waking its lead
 * once, stops, waits, and a run a Thread's shell started followed to its end.
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
  assert.deepEqual(childState(started, { source: "live" }, { latest: { ...report(started.child, "blocked", "Which branch?"), question: "Main or next?" } }), { kind: "blocked", question: "Main or next?", on: "lead" })
  assert.deepEqual(childState({ ...started, closedAt: NOW }, { source: "live" }, {}), { kind: "ended", outcome: "stopped" }, "a closed delegation reads as stopped")
  assert.deepEqual(childState(started, { source: "live" }, {}), { kind: "idle" }, "a child between turns is idle: a message gives it its next one")
  assert.deepEqual(childState(started, { source: "followed", ended: { outcome: "unknown", at: NOW } }, {}).kind, "ended")

  const entry = childEntry(started, { source: "live", working: true, step: "Shell npm test", nativeId: "n", path: "/claude/n.jsonl", harness: "claude" }, {})
  assert.equal(entry.bindingId, CHILDREN_BINDING)
  assert.equal(entry.work, "agent", "a child is an agent entry, with no kind of its own")
  assert.deepEqual(entry.child, { thread: started.child, origin: "started", nativeId: "n", path: "/claude/n.jsonl", state: { kind: "working", step: "Shell npm test" } }, "its transcript opens from its Session's path; it carries its state as `childState` reads it")
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
  assert.deepEqual(threadList([childRef, own]).map((ref) => ref.path), ["/o.jsonl"], "a child sits under its lead, not in the rail")
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
  const lead = threads.registerJournal({ conversationId: randomUUID(), createdAt: Date.now(), harness: "codex", bindings: [] }, { kind: "service", name: "workspace" })
  const placed = threads.registerJournal({ conversationId: randomUUID(), createdAt: Date.now(), harness: "claude", bindings: [] }, { kind: "service", name: "workspace" })
  const first = edge({ child: placed.thread, parent: lead.thread, parentSession: lead.session })
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
  assert.deepEqual(threads.ancestors(first.child), [lead.thread])
  threads.close()
  const reopened = new ThreadStore(path, { now: () => Date.now() })
  assert.equal(reopened.edges().of(first.child)?.op, first.op, "edges are kept across hosts")
  assert.equal(reopened.reportsOf(first.child, 0).length, 1)
  reopened.close()
}

/** Each child does `does` with its brief; a lead's turns start what the test asks and end. */
function world(name: string, does: Script, budget?: { running: number; started: number }) {
  return new AgentsWorld({ root: join(root, name), script: does, ...(budget && { budget }) })
}

async function startsAndWakes(): Promise<void> {
  let childTurns = 0
  const w = world("wakes", (turn) => {
    if (turn.text.includes("child:")) {
      childTurns += 1
      return `Done: ${turn.harness} reviewed its part. The rest is in its transcript.`
    }
    return "Started them."
  })
  try {
    const lead = await w.lead("codex")
    const brief = { objective: "Review one part of the sidebar." }
    const answers: AgentsStarted[] = []
    for (const harness of ["claude", "cursor", "grok"]) {
      const answer = await w.agents.start(lead.caller, { brief, harness, name: `review-${harness}`, clientKey: `k-${harness}`, cwd: w.root })
      assert.ok(!("refused" in answer), JSON.stringify(answer))
      answers.push(answer)
    }
    assert.equal(answers[0]!.next, AFTER_START, "the receipt tells the lead to end its turn, not wait")
    const again = await w.agents.start(lead.caller, { brief, harness: "claude", name: "review-claude", clientKey: "k-claude", cwd: w.root })
    assert.ok(!("refused" in again) && again.deduped && again.child === answers[0]!.child, "the same key answers the same child")
    const childConversation = answers[0]!.conversation!
    const first = w.live.snapshot(childConversation)?.requests[0]
    assert.ok(first?.text.startsWith("[mako · from your lead (agent), not the person]"), "a child's brief says it's an agent's words")
    assert.equal(first?.actor?.kind, "agent", "and is the lead's request, not the person's")
    await w.settle()
    assert.equal(childTurns, 3)
    const wakes = w.prompts.filter((prompt) => prompt.conversation === lead.conversation)
    assert.equal(wakes.length, 1, "three reports in one burst wake an idle lead once")
    assert.ok(wakes[0]!.text.startsWith(FROM_AGENTS))
    assert.match(wakes[0]!.text, /3 finished:/)
    assert.match(wakes[0]!.text, /0 working, 3 ended\./)
    const wake = w.live.snapshot(lead.conversation)!.requests.at(-1)!
    assert.equal(wake.actor?.kind, "agent", "a wake is an agent's request")
    const listed = await w.agents.list(lead.caller, {})
    assert.ok("children" in listed)
    assert.deepEqual(listed.children.map((strip) => strip.state.kind), ["ended", "ended", "ended"])
    assert.equal(listed.tree.started, 3)
    const read = await w.agents.read(lead.caller, { child: "review-cursor" })
    assert.ok("text" in read && /cursor reviewed its part/.test(read.text))
    const waited = await w.agents.wait(lead.caller, { timeoutMs: 50 })
    assert.ok("reports" in waited && waited.reports.length === 3 && !waited.timedOut, "a wait answers the reports already in")
    const after = await w.agents.wait(lead.caller, { timeoutMs: 50, after: waited.cursor })
    assert.ok("reports" in after && after.timedOut && !after.reports.length)
    assert.equal(w.agents.roster(lead.conversation).length, 3, "the lead's roster has its three children")
    assert.equal(w.live.snapshot(lead.conversation)?.nativeAgents?.agents.filter((agent) => agent.child).length, 3, "and its snapshot serves them")
  } finally {
    await w.close()
  }
}

async function explicitReports(): Promise<void> {
  const w = world("explicit", async (turn) => {
    if (!turn.text.includes("child:")) return "ok"
    const told = await turn.world.agents.report(turn.caller, { status: "blocked", summary: "Two schemas disagree.", question: "Keep the gateway's or the host's?", clientKey: "q1" })
    assert.ok(!("refused" in told), JSON.stringify(told))
    return "I asked my lead."
  })
  try {
    const lead = await w.lead("claude")
    const started = await w.agents.start(lead.caller, { brief: { objective: "Reconcile the schemas" }, harness: "devin", clientKey: "a", cwd: w.root })
    assert.ok(!("refused" in started))
    await w.settle()
    const reports = w.store.reportsOf(started.child!, 0)
    assert.equal(reports.length, 1, "a turn that reported gives no implicit report too")
    const wake = w.prompts.filter((prompt) => prompt.conversation === lead.conversation)
    assert.equal(wake.length, 1)
    assert.match(wake[0]!.text, /1 needs a decision:\n {2}• "[^"]+" \(Devin\) is blocked: Keep the gateway's or the host's\?/)
    const listed = await w.agents.list(lead.caller, {})
    assert.ok("children" in listed && listed.children[0]!.state.kind === "blocked")
    const own = await w.agents.report(lead.caller, { status: "done", summary: "x", clientKey: "z" })
    assert.ok("refused" in own && own.refused === "no-parent", "a Thread nobody started has no lead to report to")
  } finally {
    await w.close()
  }
}

async function refusals(): Promise<void> {
  const w = world("refusals", (turn) => turn.text.includes("child:") ? turn.world.hold(turn.conversation).then(() => "stopped") : "ok", { running: 2, started: 3 })
  try {
    const lead = await w.lead("opencode")
    const brief = { objective: "Hold" }
    const place = await w.agents.start(lead.caller, { brief, place: "cloud", clientKey: "p", cwd: w.root })
    assert.ok("refused" in place && place.refused === "place-unavailable", "8.1 starts children here only")
    const device = await w.agents.start(lead.caller, { brief, place: "device:Studio", clientKey: "d", cwd: w.root })
    assert.ok("refused" in device && device.refused === "place-unavailable")
    const harness = await w.agents.start(lead.caller, { brief, harness: "nope", clientKey: "h", cwd: w.root })
    assert.ok("refused" in harness && harness.refused === "unknown-harness")
    const person = await w.agents.start({ kind: "person" }, { brief, clientKey: "x", cwd: w.root })
    assert.ok("refused" in person && person.refused === "no-parent")
    const one = await w.agents.start(lead.caller, { brief, name: "one", clientKey: "1", cwd: w.root })
    const two = await w.agents.start(lead.caller, { brief, name: "two", clientKey: "2", cwd: w.root })
    assert.ok(!("refused" in one) && !("refused" in two))
    const three = await w.agents.start(lead.caller, { brief, name: "three", clientKey: "3", cwd: w.root })
    assert.ok(!("refused" in three) && three.state === "queued" && !three.child, "past the running budget a spawn queues")
    assert.match(three.why ?? "", /runs 2 of its 2 at once/)
    assert.equal(w.agents.roster(lead.conversation).length, 3, "a queued spawn shows, saying why")
    const four = await w.agents.start(lead.caller, { brief, name: "four", clientKey: "4", cwd: w.root })
    assert.ok("refused" in four && four.refused === "budget", "past the started budget a spawn is refused, with the count, a queued one counted")
    assert.match(four.why, /started 2 of its 3 Threads and 1 more wait to/)
    const stopped = await w.agents.stop(lead.caller, { child: "one" })
    assert.deepEqual("stopped" in stopped && stopped.stopped, ["one"])
    await waitFor(() => w.store.edges().children(w.store.journalPlacement(lead.conversation)!.thread).length === 3, "the queued spawn to start when one ended")
    assert.equal(w.store.queuedSpawns().length, 0)
    const five = await w.agents.start(lead.caller, { brief, name: "five", clientKey: "5", cwd: w.root })
    assert.ok("refused" in five && five.refused === "budget")
    assert.match(five.why, /started 3 of its 3/)
    const childCaller = w.caller(two.conversation!)
    const wider = await w.agents.start(childCaller, { brief, access: "full", clientKey: "w", cwd: w.root })
    assert.ok("refused" in wider && wider.refused === "access", "a child runs at most at its lead's access")
    const six = await w.agents.start(childCaller, { brief, name: "six", clientKey: "6", cwd: w.root })
    assert.ok("refused" in six && six.refused === "budget", "a sub-lead's spawn spends its tree's budget")
    const all = await w.agents.stop(lead.caller, { child: "all" })
    assert.deepEqual("stopped" in all && [...all.stopped].sort(), ["three", "two"], "stopping all stops what still runs")
  } finally {
    await w.close()
  }
}

/** A child starts in its own harness's mode for its tier, and a lead whose harness names its modes its own way has the tier its mode carries. */
async function harnessLadders(): Promise<void> {
  assert.deepEqual(childMode(openCodeModes, "auto"), { id: accessModeId("edits"), tier: "edits" }, "a tier the harness lacks takes its nearest one below")
  assert.deepEqual(childMode(CLAUDE_MODES, "deny"), { id: "dontAsk", tier: "deny" })
  assert.equal(childMode(CURSOR_SDK_MODES, "edits"), undefined)
  assert.deepEqual(childMode(undefined, "ask"), { id: accessModeId("ask"), tier: "ask" })
  const w = new AgentsWorld({
    root: join(root, "ladders"),
    script: (turn) => turn.text.includes("child:") ? "done" : "ok",
    ladders: { claude: CLAUDE_MODES, cursor: CURSOR_SDK_MODES },
  })
  try {
    const lead = await w.lead("claude", "full")
    await waitFor(() => w.live.session(lead.conversation)?.currentMode === "bypassPermissions", "the lead to open in Bypass permissions")
    const brief = { objective: "Look" }
    const cursor = await w.agents.start(lead.caller, { brief, harness: "cursor", name: "fin", clientKey: "c", cwd: w.root })
    const claude = await w.agents.start(lead.caller, { brief, harness: "claude", access: "edits", name: "ed", clientKey: "e", cwd: w.root })
    assert.ok(!("refused" in cursor) && !("refused" in claude), JSON.stringify([cursor, claude]))
    await w.settle()
    assert.equal(w.live.session(cursor.conversation!)?.currentMode, "full-access", "a Cursor child under a lead on full runs in Cursor's one mode")
    assert.equal(w.live.session(claude.conversation!)?.currentMode, "acceptEdits")
    assert.ok(w.prompts.some((prompt) => prompt.conversation === cursor.conversation), "the Cursor child was sent its brief")
    const asks = await w.lead("claude", "ask")
    await waitFor(() => w.live.session(asks.conversation)?.currentMode === "default", "the second lead to open in Ask for approval")
    const above = await w.agents.start(asks.caller, { brief, harness: "cursor", clientKey: "a", cwd: w.root })
    assert.ok("refused" in above && above.refused === "access", "a lead on ask can't start a child on a harness that runs only on full")
    assert.match(above.why, /Cursor runs on full, each above ask/)
  } finally {
    await w.close()
  }
}

async function stopAllUnqueues(): Promise<void> {
  const w = world("unqueues", (turn) => turn.text.includes("child:") ? turn.world.hold(turn.conversation).then(() => "stopped") : "ok", { running: 1, started: 10 })
  try {
    const lead = await w.lead("grok")
    const brief = { objective: "Hold" }
    await w.agents.start(lead.caller, { brief, name: "runs", clientKey: "1", cwd: w.root })
    const waits = await w.agents.start(lead.caller, { brief, name: "waits", clientKey: "2", cwd: w.root })
    assert.ok(!("refused" in waits) && waits.state === "queued")
    const again = await w.agents.start(lead.caller, { brief, name: "waits", clientKey: "2", cwd: w.root })
    assert.ok(!("refused" in again) && again.deduped && again.state === "queued", "a repeated queued spawn is the same spawn")
    const all = await w.agents.stop(lead.caller, { child: "all" })
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
  const lead = threads.registerJournal({ conversationId: randomUUID(), createdAt: Date.now(), harness: "codex", bindings: [] }, { kind: "service", name: "workspace" })
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
  const shell = spawn("/bin/sh", ["-c", "sleep 30"], { cwd: folder, env: { ...process.env, MAKO_SESSION_ID: lead.session }, stdio: "ignore" })
  try {
    const nativeId = randomUUID()
    fake.write({ harness: "claude", nativeId, path: `/claude/${nativeId}.jsonl`, cwd: folder, startedAt: new Date().toISOString() }, [
      { type: "tool", id: "1", name: "Bash", input: JSON.stringify({ command: "npm test" }), status: "completed" },
    ])
    const linked = await agents.link({ kind: "agent", session: lead.session }, { harness: "claude", session: nativeId, pid: shell.pid! })
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
    await waitFor(() => threads.edges().of(child)?.run?.ended !== undefined, "its end, once its process exited", 10_000)
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

try {
  statesAndEntries()
  rosterAndLists()
  uploadsFollowParents()
  storeKeeps()
  await startsAndWakes()
  await explicitReports()
  await refusals()
  await harnessLadders()
  await stopAllUnqueues()
  await followsShellRuns()
  console.log("agents engine: ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}

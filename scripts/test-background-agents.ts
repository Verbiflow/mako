import { runCases } from "./lib/cases.ts"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mock } from "node:test"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ThreadRef } from "@mako/sessions"
import type { Entry } from "@mako/sessions/entries"
import { threadToken } from "@mako/sessions/thread-references"
import type { ReportedSession } from "@mako/protocol/thread-listing"
import { HostJobs } from "@mako/host/base/host-jobs"
import type { MarkedProcess } from "@mako/host/base/marked-processes"
import { accessModeId } from "@mako/host/contracts/access"
import { THREAD_LIST_CAP } from "@mako/host/contracts/thread-list"
import { childEntry, childMode, childState, modeWithin, type ThreadParent } from "@mako/host/contracts/agents"
import { AFTER_START, type AgentsStarted } from "@mako/host/contracts/agent-tools"
import { backgroundWork, backgroundWorkText } from "@mako/host/contracts/background-work"
import { AFTER_LIMIT, CHILDREN_BINDING, withChildren } from "@mako/host/contracts/native-agents"
import { listedAsThread, threadList } from "@mako/host/contracts/thread-list"
import { SessionIdSchema, ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { HANDED_OVER_NOTE, listedFins } from "@mako/host/contracts/children"
import { END_CONFIRM_MS, lastStep, PROCESS_READS, type ProcessReads } from "@mako/host/conversations/agent-runs"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { namedUuid } from "@mako/host/conversations/cloud-moves"
import type { LiveRequest } from "@mako/host/contracts/live-conversations"
import { Agents, settingsIn } from "@mako/host/conversations/agents"
import { macLoad } from "@mako/host/conversations/mac-capacity"
import { uploadScope } from "@mako/host/conversations/session-uploads"
import { CLAUDE_MODES } from "@mako/host/harnesses/claude/sdk-driver"
import { CURSOR_SDK_MODES } from "@mako/host/harnesses/cursor/sdk/modes"
import { openCodeModes } from "@mako/host/harnesses/opencode/access"
import { ThreadStore } from "@mako/host/threads/store"
import { AgentsWorld, fakeCatalog, noConversations, type Heard, type Script } from "./lib/agents-world.ts"
import { cloudWords, placeFull, type FinPolicy } from "@mako/host/contracts/fin-tuning"
import { recordedCatalog } from "./model-catalogs.ts"

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
  assert.equal(backgroundWorkText(closed!), "1 Fin", "a child is a Fin in every surface's words")
  const childRef: ThreadRef = { harness: "claude", nativeId: "h", path: "/h.jsonl", parent: { thread: randomUUID(), session: randomUUID() } }
  const own: ThreadRef = { harness: "claude", nativeId: "o", path: "/o.jsonl" }
  assert.equal(listedAsThread(childRef), false)
  assert.deepEqual(threadList([childRef, own]).map((ref) => ref.path), ["/o.jsonl"], "a child sits under its Apex, not in the rail")
}

function uploadsFollowParents(): void {
  const parent = randomUUID()
  const at = new Date(NOW - 60_000).toISOString()
  const thread = randomUUID()
  const row = (session: string, nativeId: string): ReportedSession => ({ session, thread, conversation: nativeId, harness: "codex", nativeId, title: "Parent", state: "idle", createdAt: at, activityAt: at, generation: 1 })
  const rows = [row(parent, "parent"), row(randomUUID(), "earlier")]
  let looks = 0
  const children = new Map([[thread, [{ harness: "cursor", nativeId: "helper" }]]])
  const scope = uploadScope(rows, { onBattery: false, percent: undefined, lowPower: false }, (harness, nativeId) => { if (nativeId === "helper") looks += 1; return `/${harness}/${nativeId}` }, NOW, children)
  assert.equal(looks, 1, "a Thread's children are walked once, however many Sessions it has")
  assert.deepEqual(scope.sessions.filter((session) => session.nativeId !== "earlier").map((session) => `${session.harness}:${session.nativeId}`), ["codex:parent", "cursor:helper"], "a child's Session syncs right after its parent's, under its Thread")
  assert.equal(scope.sessions[1]!.thread, scope.sessions[0]!.thread)
}

/** Two connections' own counters start alike, so a read-only store's version has to show that it reopened on a newer file. */
function readOnlyStoreVersion(): void {
  const path = join(root, "read-only-version.sqlite")
  const journal = () => ({ conversationId: randomUUID(), createdAt: Date.now(), harness: "codex", bindings: [] })
  const who = { kind: "service", name: "workspace" } as const
  const first = new ThreadStore(path, { now: () => Date.now() })
  const apex = first.registerJournal(journal(), who)
  first.close()
  const reader = new ThreadStore(path, { now: () => Date.now(), readOnly: true })
  const before = reader.version()
  assert.equal(reader.version(), before, "reading doesn't move it")
  const writer = new ThreadStore(path, { now: () => Date.now() })
  const placed = writer.registerJournal(journal(), who)
  writer.keepEdge(edge({ child: placed.thread, parent: apex.thread, parentSession: apex.session, run: { harness: "codex", nativeId: "fin-new", device: writer.deviceId, startedAt: 1 } }))
  writer.close()
  assert.notEqual(reader.version(), before, "a new Fin moves it, on a reopened connection too")
  assert.deepEqual(reader.childSessions().get(apex.thread), [{ harness: "codex", nativeId: "fin-new" }], "and it reads that Fin")
  reader.close()
}

function storeKeeps(): void {
  const path = join(root, "keeps.sqlite")
  const threads = new ThreadStore(path, { now: () => Date.now() })
  const apex = threads.registerJournal({ conversationId: randomUUID(), createdAt: Date.now(), harness: "codex", bindings: [] }, { kind: "service", name: "workspace" })
  const placed = threads.registerJournal({ conversationId: randomUUID(), createdAt: Date.now(), harness: "claude", bindings: [] }, { kind: "service", name: "workspace" })
  const first = edge({ child: placed.thread, parent: apex.thread, parentSession: apex.session })
  const before = threads.version()
  assert.equal(threads.version(), before, "reading doesn't move the store's version")
  assert.equal(threads.keepEdge(first).op, first.op)
  assert.notEqual(threads.version(), before, "a new child does")
  assert.equal(threads.keepEdge({ ...first, op: "start:other", parent: ThreadIdSchema.parse(randomUUID()) }).op, first.op, "one parent per child: the first edge stands")
  const run = { harness: "claude", nativeId: "n", device: threads.deviceId, startedAt: 1 }
  threads.keepEdge({ ...first, run: { ...run, ended: { at: 1, kind: "done" } } })
  const later = threads.keepEdge({ ...first, run: { ...run, ended: { at: 2, kind: "failed" } } })
  assert.deepEqual(later.run?.ended, { at: 1, kind: "done" }, "an end is written once")
  assert.deepEqual(threads.childSessions().get(apex.thread), [{ harness: "claude", nativeId: "n" }], "a child without a claim still names its run")
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

async function finLimit(): Promise<void> {
  const GB = 1024 ** 3
  // The person's Mac as it stood when Fins took it over: 14 cores, 36 GB, 13 Fins at work and no core idle.
  assert.deepEqual(macLoad({ cores: 14, memoryBytes: 36 * GB, busyCores: 14 }, 13), { why: "14 cores, 36 GB, 14 cores busy", busy: true }, "13 Fins at once is more than this Mac takes easily")
  assert.deepEqual(macLoad({ cores: 14, memoryBytes: 36 * GB, busyCores: 0 }, 0), { why: "14 cores, 36 GB" }, "an idle Mac isn't busy")
  assert.deepEqual(macLoad({ cores: 14, memoryBytes: 36 * GB, busyCores: 12 }, 2), { why: "14 cores, 36 GB, 12 cores busy", busy: true }, "the person's own work counts first")
  assert.deepEqual(macLoad({ cores: 14, memoryBytes: 36 * GB, busyCores: 9 }, 1), { why: "14 cores, 36 GB, 9 cores busy" }, "five idle cores are room for another Fin")
  assert.deepEqual(macLoad({ cores: 14, memoryBytes: 36 * GB }, 0), { why: "14 cores, 36 GB" }, "no reading of its cores yet says nothing of them")
  assert.equal(macLoad({ cores: 14, memoryBytes: 36 * GB, busyCores: 14 }, 8).busy, true, "a full Mac is said whatever a count of Fins would account for")
  assert.equal(macLoad({ cores: 14, memoryBytes: 36 * GB, busyCores: 0, swapFreeBytes: 100 * 1024 ** 2 }, 0).busy, true, "a Mac out of swap is busy")

  // Each place has its own bound: a device its count, the cloud the person's plan and spend, never a device's count.
  assert.equal(placeFull({ place: "device", atOnce: 16 }, 15), undefined)
  assert.equal(placeFull({ place: "device", atOnce: 16 }, 16), "16 of the 16 Fins this device runs at once are at work")
  assert.equal(placeFull({ place: "cloud" }, 500), undefined, "a cloud with no plan bound holds nothing: each Fin has a machine of its own")
  assert.equal(placeFull({ place: "cloud", atOnce: 40 }, 40), "40 of the 40 cloud Fins the person's plan runs at once are at work")
  assert.equal(placeFull({ place: "cloud", atOnce: 40, dailySpendCents: 2_000, spentTodayCents: 2_000 }, 3), "today's cloud spend reached the person's ceiling of $20.00")
  assert.equal(cloudWords({}), "By your plan")
  assert.equal(cloudWords({ atOnce: 8, dailySpendCents: 2_000 }), "8 at once · $20.00 a day")

  // A busy Mac and a limit of two: the Mac only warns, and the limit refuses unless the Apex asks to wait.
  let working = 0
  const w = new AgentsWorld({
    root: join(root, "fin-limit"),
    script: (turn) => turn.text.includes("You're fin:") ? (working++, turn.world.hold(turn.conversation).then(() => (working--, "stopped"))) : "ok",
    capacity: { read: async () => ({ cores: 6, memoryBytes: 16 * GB, busyCores: 6 }) },
    finLimit: () => 2,
  })
  try {
    const apex = await w.apex("opencode")
    const other = await w.apex("claude")
    const brief = { objective: "Hold" }
    const one = await w.agents.start(apex.caller, { brief, name: "one", clientKey: "1", cwd: w.root })
    assert.ok(!("refused" in one) && one.state !== "queued", JSON.stringify(one))
    assert.match(one.mac ?? "", /^This Mac is busy \(6 cores, 16 GB, 6 cores busy\): it starts anyway/, "a busy Mac is said, and it starts")
    const two = await w.agents.start(apex.caller, { brief, name: "two", clientKey: "2", cwd: w.root })
    assert.ok(!("refused" in two) && two.state !== "queued", JSON.stringify(two))
    await waitFor(() => working === 2, "both Fins at work")
    const refused = await w.agents.start(apex.caller, { brief, name: "three", clientKey: "3-refused", cwd: w.root })
    assert.ok("refused" in refused && refused.refused === "budget", "past the limit a start is refused, never queued unasked")
    assert.equal(refused.why, "2 of the 2 Fins this device runs at once are at work. Pass queue: true to start it when one ends, or after: to start it after one of yours.")
    const heard = w.events.length
    const three = await w.agents.start(apex.caller, { brief, name: "three", queue: true, clientKey: "3", cwd: w.root })
    assert.ok(!("refused" in three) && three.state === "queued" && !three.child, "with queue it waits")
    // The sidebar, pips and crew card read the Apex's conversation: it hears a spawn held as it hears a Fin start.
    await waitFor(() => w.events.slice(heard).some((event) => JSON.stringify(event).includes("Queued: 0 ahead, your limit of Fins at once is in use")), "the Apex's conversation to hear the spawn queued")
    const listed = await w.agents.list(apex.caller, {})
    assert.ok("children" in listed)
    assert.deepEqual(listed.children.map((strip) => [strip.name, strip.state.kind]), [["one", "working"], ["two", "working"], ["three", "queued"]], "agents_list shows a queued Fin")
    const read = await w.agents.read(apex.caller, { child: "fin:three" })
    assert.ok(!("refused" in read) && read.state.kind === "queued" && /your limit of Fins at once is in use/.test(read.text), `agents_read reads a queued Fin: ${JSON.stringify(read)}`)
    assert.equal(three.why, "2 of the 2 Fins this device runs at once are at work; it starts when one ends (0 ahead).")
    assert.deepEqual(three.atOnce, { working: 2, of: 2 }, "the answer carries the limit")
    const four = await w.agents.start(other.caller, { brief, name: "four", queue: true, clientKey: "4", cwd: w.root })
    assert.ok(!("refused" in four) && four.state === "queued" && /\(1 ahead\)/.test(four.why ?? ""), `another tree's spawn waits behind it: first come, first started: ${JSON.stringify(four)}`)
    const waiting = (apexConversation: string) => w.agents.roster(apexConversation).flatMap((entry) => (entry.state.kind === "waiting" ? [entry.state.reason] : []))
    assert.deepEqual(waiting(apex.conversation), ["Queued: 0 ahead, your limit of Fins at once is in use"])
    assert.deepEqual(waiting(other.conversation), ["Queued: 1 ahead, your limit of Fins at once is in use"])
    await w.agents.stop(apex.caller, { child: "one" })
    await waitFor(() => w.store.queuedSpawns().length === 1 && working === 2, "the first waiting spawn to start once one ended")
    assert.ok(w.store.edges().byOp(`start:${w.store.journalPlacement(apex.conversation)!.session}:3`), "first come, first started")
    await w.agents.stop(apex.caller, { child: "two" })
    await waitFor(() => w.store.queuedSpawns().length === 0 && working === 2, "the second once another ended")
    assert.deepEqual(w.store.edges().all.map((edge) => edge.name).sort(), ["four", "one", "three", "two"])
    await w.agents.stop(apex.caller, { child: "all" })
    await w.agents.stop(other.caller, { child: "all" })
  } finally {
    await w.close()
  }

  // A simulator this Mac lends another place's Thread takes a Fin's place: one pool, so the Mac never runs more than it can.
  let lentHere = 1
  let lending = 0
  const lender = new AgentsWorld({
    root: join(root, "fin-lent"),
    script: (turn) => turn.text.includes("You're fin:") ? (lending++, turn.world.hold(turn.conversation).then(() => (lending--, "stopped"))) : "ok",
    finLimit: () => 2,
    lent: () => lentHere,
  })
  try {
    const apex = await lender.apex("claude")
    const brief = { objective: "Hold" }
    const one = await lender.agents.start(apex.caller, { brief, name: "one", clientKey: "1", cwd: lender.root })
    assert.ok(!("refused" in one) && one.state !== "queued", JSON.stringify(one))
    await waitFor(() => lending === 1, "the first Fin at work")
    assert.equal(lender.agents.workingHere(), 1, "what this device advertises as its own work leaves out what it lends")
    const two = await lender.agents.start(apex.caller, { brief, name: "two", queue: true, clientKey: "2", cwd: lender.root })
    assert.ok(!("refused" in two) && two.state === "queued", `the lent simulator holds the second place: ${JSON.stringify(two)}`)
    lentHere = 0
    lender.agents.capacityChanged()
    await waitFor(() => lending === 2, "the place the lease held goes to the waiting Fin once the lease ends")
    await lender.agents.stop(apex.caller, { child: "all" })
  } finally {
    await lender.close()
  }

  // The person's ceiling across every place holds over a place with room.
  let held = 0
  const capped = new AgentsWorld({
    root: join(root, "fin-ceiling"),
    script: (turn) => turn.text.includes("You're fin:") ? (held++, turn.world.hold(turn.conversation).then(() => (held--, "stopped"))) : "ok",
    finLimit: () => 10,
    finCeiling: () => 1,
  })
  try {
    const apex = await capped.apex("claude")
    const first = await capped.agents.start(apex.caller, { brief: { objective: "Hold" }, name: "first", clientKey: "1", cwd: capped.root })
    assert.ok(!("refused" in first) && first.state !== "queued")
    await waitFor(() => held === 1, "the first Fin at work")
    const second = await capped.agents.start(apex.caller, { brief: { objective: "Hold" }, name: "second", clientKey: "2", cwd: capped.root })
    assert.ok("refused" in second && second.why.startsWith("1 of the person's 1 Fins at once across every place are at work."), JSON.stringify(second))
    await capped.agents.stop(apex.caller, { child: "all" })
  } finally {
    await capped.close()
  }
}

/**
 * A freed place goes to the next waiting Fin at once, event-driven: a stop, a turn's end, or a raised number starts
 * the first waiter that fits, first come first started across Apexes. With no room watch each start can come only
 * from the event that freed its place, so one that comes at all came before the next look. One whose `after` isn't
 * finished is passed over, and one whose harness hangs as it starts holds its place without holding up the rest.
 */
async function slotsGoAtOnce(): Promise<void> {
  const launched = new Map<string, number>()
  const done = new Map<string, number>()
  let release: (() => void) | undefined
  let limit = 2
  let w!: AgentsWorld
  w = new AgentsWorld({
    root: join(root, "slots"),
    noRoomWatch: true,
    finLimit: () => limit,
    starting: async (conversation) => {
      launched.set(conversation, performance.now())
      if (conversation === stuck) await new Promise<void>((resolve) => (release = resolve))
    },
    script: async (turn) => {
      if (!turn.text.includes("You're fin:")) return "ok"
      if (turn.text.includes("Quick")) {
        done.set(turn.conversation, performance.now())
        return "Done."
      }
      await turn.world.hold(turn.conversation)
      return "stopped"
    },
  })
  let stuck = ""
  try {
    const one = await w.apex("claude")
    const two = await w.apex("codex")
    const key = (apex: { conversation: string }, clientKey: string) => namedUuid(`start:${w.store.journalPlacement(apex.conversation)!.session}:${clientKey}`)
    const hold = { objective: "Hold" }
    for (const name of ["a", "b"]) assert.ok(!("refused" in await w.agents.start(one.caller, { brief: hold, name, clientKey: name, cwd: w.root })))
    await waitFor(() => launched.has(key(one, "a")) && launched.has(key(one, "b")), "two Fins at work")
    stuck = key(two, "s")
    // In line: g waits for b too; s's harness hangs as it starts; then c, which finishes at once, and d.
    const queued = [
      await w.agents.start(one.caller, { brief: hold, name: "g", after: ["b"], queue: true, clientKey: "g", cwd: w.root }),
      await w.agents.start(two.caller, { brief: hold, name: "s", queue: true, clientKey: "s", cwd: w.root }),
      await w.agents.start(one.caller, { brief: { objective: "Quick" }, name: "c", queue: true, clientKey: "c", cwd: w.root }),
      await w.agents.start(two.caller, { brief: hold, name: "d", queue: true, clientKey: "d", cwd: w.root }),
    ]
    assert.ok(queued.every((answer) => !("refused" in answer) && answer.state === "queued"), JSON.stringify(queued))
    const latency: number[] = []
    // A stop frees a place: s goes, past g, whose b still works.
    let freed = performance.now()
    await w.agents.stop(one.caller, { child: "a" })
    await waitFor(() => launched.has(stuck), "s to start once a stopped")
    latency.push(launched.get(stuck)! - freed)
    assert.equal(launched.has(key(one, "g")), false, "g waits for b, without holding up s")
    // Another: b's stop holds g, and c goes though s is still coming up.
    freed = performance.now()
    await w.agents.stop(one.caller, { child: "b" })
    await waitFor(() => launched.has(key(one, "c")), "c to start though s hangs")
    latency.push(launched.get(key(one, "c"))! - freed)
    // c's turn ends: d, another Apex's, takes its place.
    await waitFor(() => launched.has(key(two, "d")), "d to start once c finished")
    latency.push(launched.get(key(two, "d"))! - done.get(key(one, "c"))!)
    assert.equal(launched.has(key(one, "g")), false, "g, whose b was stopped, never starts")
    // A raised number takes what waits at once, with no Fin ending.
    await w.agents.start(two.caller, { brief: hold, name: "e", queue: true, clientKey: "e", cwd: w.root })
    limit = 3
    freed = performance.now()
    w.agents.capacityChanged()
    await waitFor(() => launched.has(key(two, "e")), "e to start once the number rose")
    latency.push(launched.get(key(two, "e"))! - freed)
    console.log(`slot to launch: ${latency.map((ms) => `${ms.toFixed(1)} ms`).join(", ")}`)
    release?.()
    await w.agents.stop(one.caller, { child: "all" })
    await w.agents.stop(two.caller, { child: "all" })
  } finally {
    release?.()
    await w.close()
  }
}

/**
 * Queued starts launching side by side, before their edges are written: two of one name under one Apex take two
 * names, a stop during a start's preparation cancels it, and one that can't start stays, saying why, until its Apex
 * has heard, never dropped unseen.
 */
async function launchesBeforeTheirEdge(): Promise<void> {
  const gates = new Map<string, () => void>()
  const preparing: string[] = []
  let limit = 0
  const w = new AgentsWorld({
    root: join(root, "pre-edge"),
    finLimit: () => limit,
    preparing: async (options) => {
      const name = options.parent!.name
      preparing.push(name)
      if (name === "bad") throw new Error("its worktree couldn't be made")
      await new Promise<void>((resolve) => gates.set(name, resolve))
    },
    script: async (turn) => {
      if (turn.text.includes("You're fin:")) await turn.world.hold(turn.conversation)
      return "ok"
    },
  })
  const open = () => {
    for (const [name, gate] of gates) {
      gates.delete(name)
      gate()
    }
  }
  try {
    const apex = await w.apex("claude")
    const thread = () => w.store.journalPlacement(apex.conversation)!.thread
    const briefs = (name: string) => w.prompts.filter((prompt) => prompt.text.includes(`You're fin:${name},`)).length
    for (const clientKey of ["first", "second"]) {
      const queued = await w.agents.start(apex.caller, { brief: { objective: "Check" }, name: "check", queue: true, clientKey, cwd: w.root })
      assert.ok(!("refused" in queued) && queued.state === "queued", JSON.stringify(queued))
    }
    limit = 2
    w.agents.capacityChanged()
    await waitFor(() => preparing.length === 2, "both starts preparing at once")
    assert.deepEqual(preparing, ["check", "check-2"], "two of one name, launching side by side, take two names")
    open()
    await waitFor(() => w.store.queuedSpawns().length === 0 && w.store.edges().children(thread()).length === 2, "both to start")
    assert.deepEqual(w.store.edges().children(thread()).map((edge) => edge.name).sort(), ["check", "check-2"])
    await waitFor(() => briefs("check") + briefs("check-2") === 2, "a brief each")

    // A stop while it prepares: it never starts, whatever its preparation does after.
    limit = 3
    preparing.length = 0
    const late = w.agents.start(apex.caller, { brief: { objective: "Hold" }, name: "late", queue: true, clientKey: "late", cwd: w.root })
    await waitFor(() => preparing.includes("late"), "late preparing")
    const stopped = await w.agents.stop(apex.caller, { child: "late" })
    assert.deepEqual("stopped" in stopped && stopped.stopped, ["late"])
    open()
    const answer = await late
    assert.ok("refused" in answer && /stopped it before it started/.test(answer.why), `its start says it was stopped: ${JSON.stringify(answer)}`)
    assert.equal(w.store.edges().children(thread()).some((edge) => edge.name === "late" && !edge.closedAt), false, "a Fin stopped as it prepared has no open Thread")
    assert.equal(briefs("late"), 0, "and was never sent its brief")
    assert.equal(w.store.queuedSpawns().length, 0)

    // One that can't start: it stays in line saying why, wakes its Apex, and goes once its Apex has heard.
    limit = 2
    const bad = await w.agents.start(apex.caller, { brief: { objective: "Bad" }, name: "bad", queue: true, clientKey: "bad", cwd: w.root })
    assert.ok(!("refused" in bad) && bad.state === "queued", JSON.stringify(bad))
    limit = 3
    w.agents.capacityChanged()
    // Its Apex hears once the digest is in its queue, which can come before the row is read.
    await waitFor(() => w.store.queuedSpawns().length === 0 || w.agents.roster(apex.conversation).some((entry) => entry.state.kind === "waiting" && (entry.state.reason ?? "").startsWith("Not started: its worktree couldn't be made")), "the refusal to show on its row")
    await waitFor(() => w.store.queuedSpawns().length === 0, "it to go once its Apex heard", 15_000)
    const told = /"bad" \(Claude\) failed: It didn't start: its worktree couldn't be made/
    await waitFor(() => w.prompts.some((prompt) => prompt.conversation === apex.conversation && told.test(prompt.text)), "its Apex to hear why it didn't start")
    assert.equal(w.store.queuedSpawns().length, 0, "and it goes once its Apex heard")
    await w.agents.stop(apex.caller, { child: "all" })
  } finally {
    open()
    await w.close()
  }
}

/**
 * A Fin shown stopped holds its place until its harness has stopped: with one place, a Fin waiting behind one whose
 * cancel is slow never starts while that turn still runs, so two turns never write in one worktree at once, and it
 * starts from the cancel finishing: after it, with no room watch to start it otherwise.
 */
async function stopHoldsUntilCancelled(): Promise<void> {
  let release: () => void = () => {}
  const active = new Set<string>()
  let overlapped = false
  let cancelled = 0
  const w = new AgentsWorld({
    root: join(root, "slow-cancel"),
    noRoomWatch: true,
    finLimit: () => 1,
    // Only the first stop is slow; the ones after go at once.
    cancelling: () => (cancelled ? undefined : new Promise<void>((resolve) => (release = () => { cancelled = Date.now(); resolve() }))),
    script: async (turn) => {
      if (!turn.text.includes("You're fin:")) return "ok"
      if (active.size) overlapped = true
      active.add(turn.conversation)
      await turn.world.hold(turn.conversation)
      active.delete(turn.conversation)
      return "stopped"
    },
  })
  try {
    const apex = await w.apex("claude")
    const brief = { objective: "Edit the shared file" }
    await w.agents.start(apex.caller, { brief, name: "first", clientKey: "first", cwd: w.root })
    await waitFor(() => active.size === 1, "the first at work")
    const second = await w.agents.start(apex.caller, { brief, name: "second", queue: true, clientKey: "second", cwd: w.root })
    assert.ok(!("refused" in second) && second.state === "queued")
    const stopping = w.agents.stop(apex.caller, { child: "first" })
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(w.store.queuedSpawns().length, 1, "the second waits while the first's harness is still stopping")
    assert.equal(overlapped, false, "no two turns in one worktree at once")
    release()
    await stopping
    await waitFor(() => active.size === 1 && w.store.queuedSpawns().length === 0, "the second to start once the first stopped")
    assert.equal(overlapped, false, "the second started only after the first's turn ended")
    const started = w.prompts.find((prompt) => prompt.text.includes("You're fin:second,"))!.at
    assert.ok(started >= cancelled, "and from the cancel finishing")
    await w.agents.stop(apex.caller, { child: "all" })
  } finally {
    release()
    await w.close()
  }
}

/**
 * A shell-linked run Mako stops holds its place until its process has exited, its kill's grace included: one that
 * ignores SIGTERM keeps writing for five seconds, and the Fin waiting for its place starts only once it's gone.
 */
async function followedStopHoldsUntilExit(): Promise<void> {
  const fake = fakeCatalog()
  const w = new AgentsWorld({
    root: join(root, "followed-stop"),
    finLimit: () => 1,
    catalog: fake.catalog,
    script: async (turn) => {
      if (turn.text.includes("You're fin:")) {
        writeFileSync(join(turn.world.root, "shared.txt"), "next")
        await turn.world.hold(turn.conversation)
      }
      return "ok"
    },
  })
  // A run its Apex's shell started, deaf to SIGTERM, writing the shared file every 10 ms until it's killed. Each write
  // replaces the file whole: one that truncated it first was read empty between the two, 170 reads in 20,000.
  const shell = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});const fs=require('node:fs');const put=()=>{fs.writeFileSync('shared.tmp','linked');fs.renameSync('shared.tmp','shared.txt')};put();console.log('ready');setInterval(put,10)"], { cwd: w.root, detached: true, stdio: ["ignore", "pipe", "ignore"] })
  await new Promise<void>((resolve) => shell.stdout!.once("data", () => resolve()))
  let exited = 0
  shell.once("exit", () => (exited = performance.now()))
  try {
    const apex = await w.apex("claude", "full")
    const nativeId = randomUUID()
    fake.write({ harness: "claude", nativeId, path: join(w.root, "linked.jsonl"), cwd: w.root, startedAt: new Date().toISOString() }, [{ type: "tool", id: "one", name: "Bash", input: "{}", status: "completed" }])
    const linked = await w.agents.link(apex.caller, { harness: "claude", session: nativeId, pid: shell.pid!, name: "linked" })
    assert.ok(!("refused" in linked), JSON.stringify(linked))
    await waitFor(() => w.agents.diagnostics().running === 1, "the linked run counted")
    const queued = await w.agents.start(apex.caller, { name: "next", clientKey: "next", cwd: w.root, queue: true, brief: { objective: "Edit the shared file" } })
    assert.ok(!("refused" in queued) && queued.state === "queued", JSON.stringify(queued))
    await w.agents.stop(apex.caller, { child: "linked" })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(w.prompts.length, 0, "a stopped run still exiting keeps its place")
    assert.equal(readFileSync(join(w.root, "shared.txt"), "utf8"), "linked")
    await waitFor(() => w.prompts.some((prompt) => prompt.text.includes("You're fin:next,")), "next to start once the linked run is gone", 12_000)
    const started = w.prompts.find((prompt) => prompt.text.includes("You're fin:next,"))!.at
    assert.ok(exited > 0, "the linked run had exited before next started")
    assert.ok(started - (Date.now() - (performance.now() - exited)) >= 0, "next started after the linked run's exit")
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(readFileSync(join(w.root, "shared.txt"), "utf8"), "next", "and nothing overwrote its file after")
    await w.agents.stop(apex.caller, { child: "all" })
  } finally {
    shell.kill("SIGKILL")
    await w.close()
  }
}

/** Identity reads as the host's own, except that while `on` a process's start can't be read, on any platform. */
const unreadable = { on: false }
const identityReads: ProcessReads = {
  ...PROCESS_READS,
  matches: (pid, startedAt, signal) => (unreadable.on ? Promise.reject(new Error("its start time can't be read")) : PROCESS_READS.matches!(pid, startedAt, signal)),
}

/** A world with one place, a run its Apex's shell started linked into it (deaf to SIGTERM, writing shared.txt every 10 ms) and a Fin queued behind it. */
async function linkedWriter(name: string, detached: boolean) {
  const fake = fakeCatalog()
  const w = new AgentsWorld({
    root: join(root, name),
    finLimit: () => 1,
    catalog: fake.catalog,
    processes: identityReads,
    script: async (turn) => {
      if (turn.text.includes("You're fin:")) {
        writeFileSync(join(turn.world.root, "shared.txt"), "next")
        await turn.world.hold(turn.conversation)
      }
      return "ok"
    },
  })
  const shell = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});const fs=require('node:fs');const put=()=>{fs.writeFileSync('shared.tmp','linked');fs.renameSync('shared.tmp','shared.txt')};put();console.log('ready');setInterval(put,10)"], { cwd: w.root, detached, stdio: ["ignore", "pipe", "ignore"] })
  await new Promise<void>((resolve) => shell.stdout!.once("data", () => resolve()))
  const apex = await w.apex("claude", "full")
  const nativeId = randomUUID()
  fake.write({ harness: "claude", nativeId, path: join(w.root, "linked.jsonl"), cwd: w.root, startedAt: new Date().toISOString() }, [{ type: "tool", id: "one", name: "Bash", input: "{}", status: "completed" }])
  const linked = await w.agents.link(apex.caller, { harness: "claude", session: nativeId, pid: shell.pid!, name: "linked" })
  assert.ok(!("refused" in linked), JSON.stringify(linked))
  await waitFor(() => w.agents.diagnostics().running === 1, "the linked run counted")
  const queued = await w.agents.start(apex.caller, { name: "next", clientKey: "next", cwd: w.root, queue: true, brief: { objective: "Edit the shared file" } })
  assert.ok(!("refused" in queued) && queued.state === "queued", JSON.stringify(queued))
  const started = () => w.prompts.some((prompt) => prompt.text.includes("You're fin:next,"))
  return { w, shell, apex, linked, started }
}

/** Counts Mako's TERM and KILL to `pid` or its group, passing every call on. */
function signalsTo(pid: number) {
  const kill = process.kill
  const sent: string[] = []
  // SAFETY: the stand-in takes process.kill's arguments and returns what it returns for every call.
  process.kill = ((target: number, signal?: string | number) => {
    if (Math.abs(target) === pid && (signal === "SIGTERM" || signal === "SIGKILL")) sent.push(`${target} ${signal}`)
    return kill(target, signal)
  }) as typeof process.kill
  return { sent, restore: () => (process.kill = kill) }
}

/**
 * A link's look at the pid it names: a stalled read of a running process is read again, one that stays unreadable
 * says so, and only a process that's gone is called gone.
 */
async function linkTellsUnreadableFromGone(): Promise<void> {
  let failures = 0
  const fake = fakeCatalog()
  const w = new AgentsWorld({
    root: join(root, "link-reads"),
    catalog: fake.catalog,
    processes: {
      ...PROCESS_READS,
      startedAt: (pid, signal) => (failures-- > 0 ? Promise.reject(new Error("ps ran past its limit")) : PROCESS_READS.startedAt(pid, signal)),
    },
    script: () => "ok",
  })
  const shell = spawn("/bin/sh", ["-c", "sleep 60"], { detached: true, stdio: "ignore" })
  try {
    const apex = await w.apex("claude", "full")
    const write = (nativeId: string) => fake.write({ harness: "claude", nativeId, path: join(w.root, `${nativeId}.jsonl`), cwd: w.root, startedAt: new Date().toISOString() }, [{ type: "tool", id: "one", name: "Bash", input: "{}", status: "completed" }])
    const stalled = randomUUID()
    write(stalled)
    failures = 2
    const linked = await w.agents.link(apex.caller, { harness: "claude", session: stalled, pid: shell.pid! })
    assert.ok(!("refused" in linked), `two stalled reads of a running process aren't its end: ${JSON.stringify(linked)}`)
    const unreadable = randomUUID()
    write(unreadable)
    failures = Infinity
    const refused = await w.agents.link(apex.caller, { harness: "claude", session: unreadable, pid: shell.pid! })
    assert.ok("refused" in refused && refused.refused === "unavailable", JSON.stringify(refused))
    assert.match(refused.why, new RegExp(`Process ${shell.pid} is running, but Mako couldn't read when it started \\(ps ran past its limit\\)`))
    const exited = spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" })
    await new Promise((resolve) => exited.once("exit", resolve))
    const gone = await w.agents.link(apex.caller, { harness: "claude", session: unreadable, pid: exited.pid! })
    assert.ok("refused" in gone && gone.refused === "unknown-child", JSON.stringify(gone))
    assert.match(gone.why, new RegExp(`No process ${exited.pid} runs on this device`))
    failures = 0
  } finally {
    shell.kill("SIGKILL")
    await w.close()
  }
}

/**
 * A stopped run whose identity can't be read is neither gone nor proven its own: it keeps its place, Mako
 * sends it nothing and says it couldn't confirm it stopped, and once its identity reads again the stop goes on.
 */
async function followedStopUnknownIdentity(): Promise<void> {
  const { w, shell, apex, linked, started } = await linkedWriter("followed-unknown", false)
  const signals = signalsTo(shell.pid!)
  try {
    unreadable.on = true
    await w.agents.stop(apex.caller, { child: "linked" })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(started(), false, "unknown identity is not gone: the next Fin waits")
    assert.equal(readFileSync(join(w.root, "shared.txt"), "utf8"), "linked")
    assert.equal(signals.sent.length, 0, `a process not proven its own is sent nothing: ${signals.sent.join(", ")}`)
    const row = w.agents.roster(apex.conversation).find((entry) => entry.child?.thread === linked.child)
    assert.match(JSON.stringify(row?.child?.state), /couldn't confirm linked stopped; it may still be running/, JSON.stringify(row?.child?.state))
  } finally {
    unreadable.on = false
  }
  try {
    await waitFor(started, "next to start once the run was proven, killed and seen gone", 12_000)
    assert.ok(shell.exitCode !== null || shell.signalCode !== null, "after the linked run exited")
    assert.ok(signals.sent.some((sent) => sent.endsWith("SIGKILL")), `once its identity read, the stop went on: ${signals.sent.join(", ")}`)
    await w.agents.stop(apex.caller, { child: "all" })
  } finally {
    signals.restore()
    shell.kill("SIGKILL")
    await w.close()
  }
}

/**
 * A stop the next host recovers whose pid is another process now (its start time differs): while that can't be read
 * it keeps the place and signals nothing; once it reads, the place goes, and the other process is never signalled.
 */
async function followedStopStaleIdentity(): Promise<void> {
  const { w, shell, linked } = await linkedWriter("followed-stale", true)
  const edge = w.store.edges().of(linked.child!)!
  const at = Date.now() - 6_000
  const process0 = edge.run!.process!
  w.store.keepEdge({ ...edge, closedAt: at, run: { ...edge.run!, process: { ...process0, startedAt: process0.startedAt! - 60_000 }, stopping: { at }, ended: { at, kind: "stopped" } } })
  await w.close()
  const signals = signalsTo(shell.pid!)
  let next: AgentsWorld | undefined
  try {
    unreadable.on = true
    next = new AgentsWorld({ root: w.root, catalog: fakeCatalog().catalog, processes: identityReads, finLimit: () => 1, script: () => "ok" })
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(signals.sent.length, 0, `a recovered stop whose identity can't be read signals nothing: ${signals.sent.join(", ")}`)
    assert.equal(next.agents.runs.isTerminating(linked.child!), true, "and keeps its place")
    unreadable.on = false
    await waitFor(() => !next!.agents.runs.isTerminating(linked.child!), "the place to go once the pid reads as another process's", 5_000)
    assert.equal(signals.sent.length, 0, `the process now under that pid is never signalled: ${signals.sent.join(", ")}`)
    assert.equal(shell.exitCode, null, "and it still runs")
  } finally {
    unreadable.on = false
    signals.restore()
    shell.kill("SIGKILL")
    await next?.close()
  }
}

/**
 * A stopped run that outlives its kill (its signals refused) is never taken as gone: past its grace it keeps its place
 * and its Fin says Mako couldn't stop it, and the place goes only once it has actually exited.
 */
async function followedStopStuck(): Promise<void> {
  const { w, shell, apex, linked, started } = await linkedWriter("followed-stuck", true)
  const kill = process.kill
  try {
    // Mako's TERM and KILL are refused, as for a process it may not signal; its liveness checks still read it.
    // SAFETY: the stand-in takes process.kill's arguments and returns what it returns for every call it passes on.
    process.kill = ((pid: number, signal?: string | number) => {
      if ((pid === shell.pid || pid === -shell.pid!) && (signal === "SIGTERM" || signal === "SIGKILL")) throw Object.assign(new Error("permission denied"), { code: "EPERM" })
      return kill(pid, signal)
    }) as typeof process.kill
    await w.agents.stop(apex.caller, { child: "linked" })
    await new Promise((resolve) => setTimeout(resolve, 7_500))
    assert.equal(started(), false, "past its grace it still keeps its place")
    const row = w.agents.roster(apex.conversation).find((entry) => entry.child?.thread === linked.child)
    assert.match(JSON.stringify(row?.child?.state), /couldn't stop it: its process \(\d+\) is still running/, `its Fin says Mako couldn't stop it: ${JSON.stringify(row?.child?.state)}`)
  } finally {
    process.kill = kill
  }
  try {
    shell.kill("SIGKILL")
    await waitFor(started, "next to start once it actually exited", 5_000)
    await w.agents.stop(apex.caller, { child: "all" })
  } finally {
    shell.kill("SIGKILL")
    await w.close()
  }
}

/**
 * One entry per Fin, by its op, and every Apex hears its line move: a queued Fin whose edge is written while its
 * launch is still coming up shows once, as its edge; and when one Apex's refused start leaves the line, another
 * Apex's waiting Fin hears its place move up without doing anything.
 */
async function queueProjection(): Promise<void> {
  let limit = 1
  let hold: (() => void) | undefined
  let failing = ""
  const w = new AgentsWorld({
    root: join(root, "projection"),
    finLimit: () => limit,
    preparing: (options) => {
      if (options.parent?.name === failing) throw new Error("its worktree couldn't be made")
    },
    replying: async (options) => {
      if (options.conversationId === holdFor) await new Promise<void>((resolve) => (hold = resolve))
    },
    script: async (turn) => {
      if (turn.text.includes("You're fin:")) await turn.world.hold(turn.conversation)
      return "ok"
    },
  })
  let holdFor = ""
  try {
    const a = await w.apex("claude")
    const b = await w.apex("codex")
    const brief = { objective: "Hold" }
    const key = (apex: { conversation: string }, clientKey: string) => namedUuid(`start:${w.store.journalPlacement(apex.conversation)!.session}:${clientKey}`)
    await w.agents.start(a.caller, { brief, name: "first", clientKey: "first", cwd: w.root })
    await waitFor(() => w.prompts.some((prompt) => prompt.text.includes("You're fin:first,")), "the first at work")
    // A queued Fin launching: its edge is written, its start not yet answered.
    holdFor = key(a, "next")
    const queued = await w.agents.start(a.caller, { brief, name: "next", queue: true, clientKey: "next", cwd: w.root })
    assert.ok(!("refused" in queued) && queued.state === "queued", JSON.stringify(queued))
    await w.agents.stop(a.caller, { child: "first" })
    await waitFor(() => hold !== undefined && w.store.edges().all.some((edge) => edge.name === "next"), "next's edge written while its start answers")
    const listed = await w.agents.list(a.caller, {})
    assert.ok("children" in listed)
    assert.deepEqual(listed.children.filter((strip) => strip.name === "next").length, 1, `one entry for a Fin whose launch is still answering: ${JSON.stringify(listed.children.map((strip) => [strip.name, strip.state.kind]))}`)
    assert.equal(w.agents.roster(a.conversation).filter((entry) => entry.child?.name === "next").length, 1, "and one on its Apex's roster")
    hold!()
    await waitFor(() => w.store.queuedSpawns().length === 0, "next to settle")

    // A's queued start fails to prepare while the device stays full; B's Fin waits behind it, then moves up once A heard.
    failing = "doomed"
    await w.agents.start(a.caller, { brief, name: "doomed", queue: true, clientKey: "doomed", cwd: w.root })
    await w.agents.start(b.caller, { brief, name: "behind", queue: true, clientKey: "behind", cwd: w.root })
    // What B's conversation shows, as its windows read it: only what it was told.
    const reason = () => w.live.snapshot(b.conversation)?.nativeAgents?.agents.find((entry) => entry.child?.name === "behind")?.state
    await waitFor(() => reason()?.kind === "waiting", "B's conversation to show its waiting Fin")
    assert.deepEqual(reason(), { kind: "waiting", reason: "Queued: 1 ahead, your limit of Fins at once is in use" })
    limit = 2
    w.agents.capacityChanged()
    limit = 1
    // Its row goes as the digest enters its Apex's queue, which can come before the row is read: the Apex's word is the proof.
    await waitFor(() => w.store.queuedSpawns().length === 1, "doomed to go once its Apex heard", 15_000)
    await waitFor(() => w.prompts.some((prompt) => prompt.conversation === a.conversation && /"doomed" \(\w+\) failed: It didn't start/.test(prompt.text)), "A to hear why doomed didn't start")
    await waitFor(() => JSON.stringify(reason()) === JSON.stringify({ kind: "waiting", reason: "Queued: 0 ahead, your limit of Fins at once is in use" }), `the other Apex's line to move up with it: ${JSON.stringify(reason())}`, 3_000)
    await w.agents.stop(a.caller, { child: "all" })
    await w.agents.stop(b.caller, { child: "all" })
  } finally {
    hold?.()
    await w.close()
  }
}

/**
 * An Apex behind a launch hears its place move the moment that launch's edge is written, not when the launch answers:
 * A's next takes a place with its reply held, and B's waiting Fin, which was behind it, reads 0 ahead at once.
 */
async function edgeWriteMovesTheLine(): Promise<void> {
  let limit = 1
  let hold: (() => void) | undefined
  let holdFor = ""
  const w = new AgentsWorld({
    root: join(root, "edge-moves-line"),
    finLimit: () => limit,
    replying: async (options) => {
      if (options.conversationId === holdFor) await new Promise<void>((resolve) => (hold = resolve))
    },
    script: async (turn) => {
      if (turn.text.includes("You're fin:")) await turn.world.hold(turn.conversation)
      return "ok"
    },
  })
  try {
    const a = await w.apex("claude")
    const b = await w.apex("codex")
    const brief = { objective: "Hold" }
    await w.agents.start(a.caller, { brief, name: "first", clientKey: "first", cwd: w.root })
    await waitFor(() => w.prompts.some((prompt) => prompt.text.includes("You're fin:first,")), "the first at work")
    holdFor = namedUuid(`start:${w.store.journalPlacement(a.conversation)!.session}:next`)
    await w.agents.start(a.caller, { brief, name: "next", queue: true, clientKey: "next", cwd: w.root })
    await w.agents.start(b.caller, { brief, name: "behind", queue: true, clientKey: "behind", cwd: w.root })
    const shown = () => w.live.snapshot(b.conversation)?.nativeAgents?.agents.find((entry) => entry.child?.name === "behind")?.state
    await waitFor(() => JSON.stringify(shown()) === JSON.stringify({ kind: "waiting", reason: "Queued: 1 ahead, your limit of Fins at once is in use" }), "B to show its Fin behind A's")
    limit = 2
    w.agents.capacityChanged()
    await waitFor(() => hold !== undefined && w.store.edges().all.some((edge) => edge.name === "next"), "next's edge written, its start not answered")
    await waitFor(() => JSON.stringify(shown()) === JSON.stringify({ kind: "waiting", reason: "Queued: 0 ahead, your limit of Fins at once is in use" }), `B to hear its place move while next's start still answers: ${JSON.stringify(shown())}`, 2_000)
    assert.ok(hold !== undefined, "next's reply was still held")
    hold!()
    await w.agents.stop(a.caller, { child: "all" })
    await w.agents.stop(b.caller, { child: "all" })
  } finally {
    hold?.()
    await w.close()
  }
}

/**
 * `after`: a Fin starts once the Fins it names finish, queued ones too, whatever the limit; one that fails or is
 * stopped holds it and wakes its Apex to decide, and it's dropped once the Apex heard.
 */
async function afterOrder(): Promise<void> {
  // Lint fails once what's to start after it has queued, so the order of the two is the test's, not the clock's.
  let lintMay: () => void = () => {}
  const lintGate = new Promise<void>((resolve) => (lintMay = resolve))
  const w = world("after", async (turn) => {
    if (!turn.text.includes("You're fin:")) return "ok"
    if (turn.text.includes("Lint it")) {
      await lintGate
      await turn.world.agents.report(turn.caller, { status: "failed", summary: "Lint found 3 errors.", clientKey: "lint" })
      return "Lint failed."
    }
    if (turn.text.includes("Hold")) await turn.world.hold(turn.conversation)
    return "Done."
  })
  try {
    const apex = await w.apex("claude")
    const fin = (name: string) => w.store.edges().children(w.store.journalPlacement(apex.conversation)!.thread).find((edge) => edge.name === name)
    const build = await w.agents.start(apex.caller, { brief: { objective: "Hold the build" }, name: "build", clientKey: "build", cwd: w.root })
    assert.ok(!("refused" in build), JSON.stringify(build))
    const deploy = await w.agents.start(apex.caller, { brief: { objective: "Deploy it" }, name: "deploy", after: ["build"], clientKey: "deploy", cwd: w.root })
    assert.ok(!("refused" in deploy) && deploy.state === "queued" && !deploy.child, JSON.stringify(deploy))
    assert.deepEqual(deploy.after, ["build"])
    assert.equal(deploy.why, "It starts once build finishes; if one fails or is stopped it doesn't start, and you're woken to decide.")
    const announce = await w.agents.start(apex.caller, { brief: { objective: "Announce it" }, name: "announce", after: ["fin:deploy"], clientKey: "announce", cwd: w.root })
    assert.ok(!("refused" in announce) && announce.state === "queued" && announce.after?.[0] === "deploy", "a queued spawn can be waited on too")
    const waiting = () => w.agents.roster(apex.conversation).flatMap((entry) => (entry.state.kind === "waiting" ? [entry.state.reason] : []))
    assert.deepEqual(waiting(), ["Starts after build finishes", "Starts after deploy finishes"], "the crew card says what each waits on")
    const many = await w.agents.start(apex.caller, { brief: { objective: "x" }, after: Array.from({ length: AFTER_LIMIT + 1 }, (_, at) => `fin-${at}`), clientKey: "many", cwd: w.root })
    assert.ok("refused" in many && many.refused === "conflict" && w.store.queuedSpawns().length === 2, "more than a queued state carries is refused before anything is kept")
    const unknown = await w.agents.start(apex.caller, { brief: { objective: "x" }, after: ["nobody"], clientKey: "x", cwd: w.root })
    assert.ok("refused" in unknown && unknown.refused === "unknown-child")
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(fin("deploy"), undefined, "nothing starts before what it's after finished")
    w.release(build.conversation!)
    await waitFor(() => fin("announce") !== undefined, "deploy, then announce, to start in order")
    await w.settle()
    for (const name of ["build", "deploy", "announce"]) {
      const read = await w.agents.read(apex.caller, { child: name })
      assert.ok("state" in read && read.state.kind === "ended" && read.state.outcome === "done", `${name} finished: ${JSON.stringify(read)}`)
    }
    const at = (name: string) => fin(name)!.createdAt ?? 0
    assert.ok(at("build") <= at("deploy") && at("deploy") <= at("announce"), "each started after the one before it")

    // A Fin that fails holds what was to start after it: the Apex is woken to decide, and the spawn is dropped.
    const lint = await w.agents.start(apex.caller, { brief: { objective: "Lint it" }, name: "lint", clientKey: "lint", cwd: w.root })
    assert.ok(!("refused" in lint))
    const ship = await w.agents.start(apex.caller, { brief: { objective: "Ship it" }, name: "ship", after: ["lint"], clientKey: "ship", cwd: w.root })
    assert.ok(!("refused" in ship) && ship.state === "queued", JSON.stringify(ship))
    lintMay()
    await w.settle()
    assert.equal(fin("ship"), undefined, "it never started")
    assert.equal(w.store.queuedSpawns().length, 0, "dropped once its Apex heard")
    const wake = w.prompts.filter((prompt) => prompt.conversation === apex.conversation).map((prompt) => prompt.text).join("\n")
    assert.match(wake, /"ship" \(Claude\) failed: It didn't start: it was to start after lint, which failed/, "its Apex is told why, to decide")
    const late = await w.agents.start(apex.caller, { brief: { objective: "Ship it" }, name: "ship", after: ["lint"], clientKey: "ship-2", cwd: w.root })
    assert.ok("refused" in late && late.refused === "conflict" && /lint failed/.test(late.why), "after a Fin that already failed is refused at once")

    // Stopping a queued spawn by name drops it, and what waited on it is held the same way.
    const hold = await w.agents.start(apex.caller, { brief: { objective: "Hold again" }, name: "hold", clientKey: "hold", cwd: w.root })
    assert.ok(!("refused" in hold))
    await w.agents.start(apex.caller, { brief: { objective: "Second" }, name: "second", after: ["hold"], clientKey: "second", cwd: w.root })
    await w.agents.start(apex.caller, { brief: { objective: "Third" }, name: "third", after: ["second"], clientKey: "third", cwd: w.root })
    const stopped = await w.agents.stop(apex.caller, { child: "second" })
    assert.deepEqual("stopped" in stopped && stopped.stopped, ["second"])
    await waitFor(() => w.store.queuedSpawns().length === 0, "third to be dropped once its Apex heard second was stopped")
    // Heard once its digest is in the Apex's queue; the digest reaches the harness as the queue sends it.
    const told = /"third" \(Claude\) failed: It didn't start: it was to start after second, which was stopped \(it never started\)/
    await waitFor(() => w.prompts.some((prompt) => prompt.conversation === apex.conversation && told.test(prompt.text)), "its Apex to be told why")
    await w.agents.stop(apex.caller, { child: "all" })
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
    const unasked = await w.agents.start(apex.caller, { brief, name: "three", clientKey: "3-unasked", cwd: w.root })
    assert.ok("refused" in unasked && unasked.refused === "budget" && /runs 2 of its 2 Threads at once\. Pass queue: true/.test(unasked.why), "past the running budget a spawn is refused unless it asks to wait")
    const three = await w.agents.start(apex.caller, { brief, name: "three", queue: true, clientKey: "3", cwd: w.root })
    assert.ok(!("refused" in three) && three.state === "queued" && !three.child, "past the running budget a spawn that asks to wait queues")
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
    assert.match(five.why, /lifetime.*agents_send/, "finishing a Fin cannot free a lifetime start; reuse one")
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

/**
 * A harness with no mode at or below what a Fin was asked on (Cursor runs on full only) doesn't refuse a start its
 * Apex could make: with no harness named, the Fin goes to the person's next harness that offers that access; named,
 * it runs on the harness's nearest mode within its Apex's own access. Only a mode wider than the Apex's is refused.
 */
async function accessFits(): Promise<void> {
  assert.deepEqual(modeWithin(CURSOR_SDK_MODES, "edits", "full"), { id: "full-access", tier: "full" })
  assert.equal(modeWithin(CURSOR_SDK_MODES, "edits", "auto"), undefined, "never wider than the Apex's own")
  assert.equal(modeWithin(CURSOR_SDK_MODES, "deny", "full"), undefined, "deny is only deny")
  const w = new AgentsWorld({
    root: join(root, "access-fits"),
    script: (turn) => turn.text.includes("You're fin:") ? "done" : "ok",
    ladders: { claude: CLAUDE_MODES, cursor: CURSOR_SDK_MODES },
    catalogs: { claude: recordedCatalog("claude")!.models, cursor: recordedCatalog("cursor")!.models },
    order: ["cursor", "claude"],
  })
  try {
    // The start that was refused: a Cursor Apex on full asks for a Fin on edits and names no harness.
    const apex = await w.apex("cursor", "full")
    await waitFor(() => w.live.session(apex.conversation)?.currentMode === "full-access", "the Apex to open in Cursor's full access")
    const brief = { objective: "Label half the snippets" }
    const moved = await w.agents.start(apex.caller, { brief, access: "edits", name: "label-a", clientKey: "a", cwd: w.root })
    assert.ok(!("refused" in moved), JSON.stringify(moved))
    assert.equal(w.live.session(moved.conversation!)?.harness, "claude", "on the person's next harness that offers edits")
    assert.match(moved.note ?? "", /^Cursor runs only on full, above the edits it was asked on, so it runs on Claude, the person's next harness, on edits\./)
    const named = await w.agents.start(apex.caller, { brief, harness: "cursor", access: "edits", name: "label-b", clientKey: "b", cwd: w.root })
    assert.ok(!("refused" in named), JSON.stringify(named))
    assert.equal(w.live.session(named.conversation!)?.harness, "cursor", "a harness the Apex named stays")
    assert.match(named.note ?? "", /^Cursor runs only on full, so it runs on full rather than the edits it was asked on, within this Thread's own full\./)
    await w.settle()
    assert.equal(w.live.session(moved.conversation!)?.currentMode, "acceptEdits")
    assert.equal(w.live.session(named.conversation!)?.currentMode, "full-access")
    const edits = await w.apex("claude", "edits")
    await waitFor(() => w.live.session(edits.conversation)?.currentMode === "acceptEdits", "the second Apex to open on edits")
    const wider = await w.agents.start(edits.caller, { brief, harness: "cursor", clientKey: "w", cwd: w.root })
    assert.ok("refused" in wider && wider.refused === "access", "an Apex on edits can't hand a Fin Cursor's full")
    assert.match(wider.why, /^Cursor runs on full, each above edits and above this Thread's own edits, so a Fin there would have more access than you\./)
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
    const waits = await w.agents.start(apex.caller, { brief, name: "waits", queue: true, clientKey: "2", cwd: w.root })
    assert.ok(!("refused" in waits) && waits.state === "queued")
    const again = await w.agents.start(apex.caller, { brief, name: "waits", queue: true, clientKey: "2", cwd: w.root })
    assert.ok(!("refused" in again) && again.deduped && again.state === "queued", "a repeated queued spawn is the same spawn")
    await w.agents.start(apex.caller, { brief, name: "later", queue: true, clientKey: "3", cwd: w.root })
    const one = await w.agents.stop(apex.caller, { child: "fin:later" })
    assert.deepEqual("stopped" in one && one.stopped, ["later"], "a queued Fin stops by its name, before it starts")
    assert.deepEqual(w.agents.roster(apex.conversation).map((entry) => entry.child?.name).sort(), ["runs", "waits"], "and its Apex's roster drops it")
    const all = await w.agents.stop(apex.caller, { child: "all" })
    assert.deepEqual("stopped" in all && [...all.stopped].sort(), ["runs", "waits"], "stopping all also drops what's queued")
    assert.equal(w.store.queuedSpawns().length, 0)
  } finally {
    await w.close()
  }
}

/**
 * A queued start whose record this Mako can't read whole (an older Mako's) never goes quietly: its Apex is told it
 * didn't start and why, and it's dropped once it heard; one that doesn't say whose it is goes with a warning.
 */
async function unreadableQueuedStarts(): Promise<void> {
  const w = world("unreadable-queue", () => "ok")
  try {
    const apex = await w.apex("claude")
    const placed = w.store.journalPlacement(apex.conversation)!
    const lead = { session: placed.session, thread: placed.thread, conversation: apex.conversation }
    w.store.queueSpawn({ op: `start:${placed.session}:old`, tree: placed.thread, at: Date.now(), record: JSON.stringify({ lead, input: { name: "old", brief: "a brief before briefs were objects" }, harness: "claude", slots: 6 }) })
    w.store.queueSpawn({ op: "start:nobody:lost", tree: placed.thread, at: Date.now(), record: "{\"input\":" })
    w.agents.resume()
    await waitFor(() => w.store.queuedSpawns().length === 0, "both unreadable starts to leave the queue")
    await w.settle()
    const wake = w.prompts.filter((prompt) => prompt.conversation === apex.conversation).map((prompt) => prompt.text).join("\n")
    assert.match(wake, /"old" \(Claude\) failed: It didn't start: Mako couldn't read what was queued for it/, `its Apex is told: ${wake}`)
  } finally {
    await w.close()
  }
}

/**
 * A host that wrote a Fin's edge and died before taking its row off the queue, then a build that can't read that row:
 * the edge is the start, so the Fin holds its place and goes on, and its Apex hears no "It didn't start".
 */
async function startedFinsOldQueueRow(): Promise<void> {
  const w = new AgentsWorld({
    root: join(root, "started-old-row"),
    script: (turn) => turn.text.includes("You're fin:") ? turn.world.hold(turn.conversation).then(() => "stopped") : "ok",
    finLimit: () => 1,
  })
  try {
    const apex = await w.apex("claude")
    const placed = w.store.journalPlacement(apex.conversation)!
    const lead = { session: placed.session, thread: placed.thread, conversation: apex.conversation }
    const started = await w.agents.start(apex.caller, { brief: { objective: "Hold" }, name: "kept", clientKey: "kept", cwd: w.root })
    assert.ok(!("refused" in started), JSON.stringify(started))
    await waitFor(() => w.store.edges().all.some((edge) => edge.name === "kept"), "its edge")
    const edge = w.store.edges().all.find((each) => each.name === "kept")!
    w.store.queueSpawn({ op: edge.op, tree: placed.thread, at: Date.now(), record: JSON.stringify({ lead, input: { name: "kept", brief: "a brief before briefs were objects" }, harness: "claude", slots: 6 }) })
    w.agents.resume()
    await waitFor(() => w.store.queuedSpawns().length === 0, "the row its start left to leave the queue, the only place in use")
    assert.ok(w.store.edges().byOp(edge.op), "its edge stays")
    await w.agents.stop(apex.caller, { child: "all" })
    await w.settle()
    const wake = w.prompts.filter((prompt) => prompt.conversation === apex.conversation).map((prompt) => prompt.text).join("\n")
    assert.doesNotMatch(wake, /didn't start/, `a Fin that started isn't said not to have: ${wake}`)
  } finally {
    await w.close()
  }
}

/**
 * What a Fin costs is read from the processes its harness runs, owned by its conversation's active binding: one that
 * switched harness is sampled by its new binding, and counted as the harness it runs on now.
 */
async function finsAtWorkByBinding(): Promise<void> {
  const looks: { mix: Readonly<Record<string, number>>; fins?: readonly { conversation: string; harness: string }[] }[] = []
  const every = HostJobs.prototype.every
  let look: (() => void | Promise<void>) | undefined
  HostJobs.prototype.every = function (this: HostJobs, name, everyMs, run, options) {
    if (name === "read this device's capacity") look = run
    return every.call(this, name, everyMs, run, options)
  }
  const w = new AgentsWorld({
    root: join(root, "fins-by-binding"),
    script: (turn) => (turn.text.includes("You're fin:") ? turn.world.hold(turn.conversation).then(() => "stopped") : "ok"),
    observeCapacity: async (_working, mix, fins) => void looks.push({ mix, ...(fins && { fins }) }),
  })
  HostJobs.prototype.every = every
  try {
    const apex = await w.apex("claude")
    const started = await w.agents.start(apex.caller, { brief: { objective: "Hold" }, harness: "cursor", name: "switched", clientKey: "s", cwd: w.root })
    assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
    await waitFor(() => w.live.session(started.conversation!)?.status === "running", "the Fin at work")
    await look!()
    assert.deepEqual(looks.at(-1), { mix: { cursor: 1 }, fins: [{ conversation: started.conversation, harness: "cursor" }] }, "its first binding is its conversation's own")
    // Its harness switched: a new binding, on Codex, is the active one.
    const snapshot = w.live.snapshot.bind(w.live)
    const moved = "7a0d6c3e-9a51-4c2e-8f6b-1d2e3f4a5b6c"
    w.live.snapshot = (id) => {
      const real = snapshot(id)
      if (id !== started.conversation || !real?.control) return real
      return { ...real, control: { ...real.control, activeBindingId: moved, bindings: [...real.control.bindings, { ...real.control.bindings[0]!, id: moved, provider: "codex" }] } }
    }
    await look!()
    assert.deepEqual(looks.at(-1), { mix: { codex: 1 }, fins: [{ conversation: moved, harness: "codex" }] }, "it's sampled by the binding its processes run under, as the harness it runs on now")
    w.live.snapshot = snapshot
    await w.agents.stop(apex.caller, { child: "all" })
  } finally {
    HostJobs.prototype.every = every
    await w.close()
  }
}

/** A stopped Fin's own queued Fins wait for it, whatever room there is, and start once it resumes. */
/** A Fin's activity time moves with every token: alone it tells no one, or one Fin resends its Apex's whole roster to each conversation of its Thread. */
async function activityTellsNoOne(): Promise<void> {
  let began = false
  const w = world("activity", (turn) => {
    if (!turn.text.includes("You're fin:")) return "Started it."
    began = true
    return turn.world.hold(turn.conversation).then(() => "Done: it's finished.")
  })
  try {
    const apex = await w.apex("codex")
    const started = await w.agents.start(apex.caller, { brief: { objective: "Keep working." }, harness: "claude", name: "busy", clientKey: "k-busy", cwd: w.root })
    assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
    const fin = started.conversation
    await waitFor(() => began, "the Fin's turn began")
    // Its turn began: that's a move, which the first look below would tell.
    w.agents.moved(fin)
    const told: string[] = []
    const childrenChanged = w.live.childrenChanged.bind(w.live)
    w.live.childrenChanged = (id, progressOnly) => { told.push(id); childrenChanged(id, progressOnly) }
    const held = w.live.held.bind(w.live)
    let activityAt = Date.now()
    w.live.held = (id) => { const reading = held(id); return reading && id === fin ? { ...reading, activityAt } : reading }
    const before = w.agents.roster(apex.conversation)
    for (let tick = 0; tick < 20; tick += 1) {
      activityAt += 200
      w.agents.moved(fin)
    }
    assert.equal(told.length, 0, "twenty activity ticks tell its Apex nothing")
    assert.equal(w.agents.roster(apex.conversation), before, "and leave the roster the same roster")
    const childrenBefore = told.length
    w.release(fin)
    await w.settle()
    assert.ok(told.length > childrenBefore, "a Fin that really moved still tells its Apex")
    assert.equal(w.agents.roster(apex.conversation).find((entry) => entry.child?.name === "busy")?.state.kind === "working", false, "and the roster shows it")
  } finally {
    await w.close()
  }
}

/**
 * A Fin's progress, and a change of how it stands, go to its Apex Thread's newest Session alone, by the store's order,
 * and never read another back from its journal. One Apex of 14 Sessions, 13 closed, took every step 14 times.
 */
async function progressGoesWhereItsRead(): Promise<void> {
  const w = world("progress", (turn) => (turn.text.includes("You're fin:") ? turn.world.hold(turn.conversation).then(() => "Done: it's finished.") : "Started it."))
  try {
    const apex = await w.apex("codex")
    const started = await w.agents.start(apex.caller, { brief: { objective: "Keep working." }, harness: "claude", name: "busy", clientKey: "k-busy", cwd: w.root })
    assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
    await waitFor(() => w.agents.roster(apex.conversation).some((entry) => entry.child?.thread === started.child), "its Apex's roster has it")
    const store = w.store
    const apexThread = store.journalPlacement(apex.conversation)!.thread
    assert.ok(started.child, "the Fin has a Thread")
    const edge = store.edges().of(started.child)!
    // Older Sessions of the Apex's Thread: one closed in memory, one let go of, one in memory and running, before its own.
    const older = { closed: randomUUID(), released: randomUUID(), running: randomUUID() }
    const sessionOf = (conversation: string) => `session-of-${conversation}`
    const thread = store.thread.bind(store)
    mock.method(store, "thread", (id: Parameters<typeof store.thread>[0]) => {
      const real = thread(id)
      return real && id === apexThread ? { ...real, sessions: [...Object.values(older).map(sessionOf), ...real.sessions] } : real
    })
    const conversationsOf = store.conversationsOf.bind(store)
    mock.method(store, "conversationsOf", (session: string) => {
      const conversation = Object.values(older).find((each) => sessionOf(each) === session)
      return conversation ? [conversation] : conversationsOf(session)
    })
    const held = w.live.held.bind(w.live)
    const apexHeld = held(apex.conversation)!
    mock.method(w.live, "held", (id: string) => {
      if (id === older.closed) return { ...apexHeld, session: { ...apexHeld.session, id, status: "closed" } }
      if (id === older.running) return { ...apexHeld, session: { ...apexHeld.session, id, status: "running" } }
      return id === older.released ? undefined : held(id)
    })
    const told: [string, boolean][] = []
    mock.method(w.live, "childrenChanged", (id: string, progressOnly?: boolean) => void told.push([id, progressOnly ?? false]))
    const entries = w.agents["entries"]
    const now = entries.get(edge.child) ?? w.agents.roster(apex.conversation).find((entry) => entry.child?.thread === edge.child)!
    const moveFrom = (before: typeof now) => {
      entries.set(edge.child, before)
      told.length = 0
      w.agents["childMoved"](edge, true)
      return told
    }
    assert.deepEqual(moveFrom({ ...now, title: `${now.title} before`, observedAt: now.observedAt - 1 }).map(([id]) => id), [apex.conversation], "a step goes to the newest Session alone, not one running before it")
    assert.ok(told.every(([, progress]) => progress), "as progress")
    assert.deepEqual(moveFrom({ ...now, state: { kind: now.state.kind === "waiting" ? "working" : "waiting" } }).map(([id]) => id), [apex.conversation], "so does a change of how it stands")
    assert.ok(told.every(([, progress]) => !progress), "at once, not as progress")
    // A Session after the Apex's own is the newest: the order is the store's, not whose the Fin is.
    const newer = randomUUID()
    mock.method(store, "thread", (id: Parameters<typeof store.thread>[0]) => {
      const real = thread(id)
      return real && id === apexThread ? { ...real, sessions: [...Object.values(older).map(sessionOf), ...real.sessions, sessionOf(newer)] } : real
    })
    mock.method(store, "conversationsOf", (session: string) => {
      const conversation = [...Object.values(older), newer].find((each) => sessionOf(each) === session)
      return conversation ? [conversation] : conversationsOf(session)
    })
    assert.deepEqual(moveFrom({ ...now, title: `${now.title} again`, observedAt: now.observedAt - 1 }).map(([id]) => id), [newer], "a step goes to the Session made last")
  } finally {
    mock.restoreAll()
    await w.close()
  }
}

/**
 * A Fin's start, end or change of how it stands goes to its Apex Thread's newest Session alone, as its progress does: an
 * older Session in memory keeps its Fins as it last heard them, its Fins no longer hold it there, and one let go of
 * isn't read back in for them, by the move or by its wakes. Read in, it takes them as they stand. On 2026-11-07 a window
 * took 62 whole rosters in ten minutes for each of 13 Sessions besides the newest.
 */
async function finsMoveInTheNewestSession(): Promise<void> {
  const w = new AgentsWorld({
    root: join(root, "newest-session"),
    script: (turn) => (turn.text.includes("You're fin:") ? turn.world.hold(turn.conversation).then(() => "Done: it's finished.") : "Started them."),
  })
  try {
    const apex = await w.apex("codex")
    const fins: { child: string; conversation: string }[] = []
    for (const name of ["one", "two"]) {
      const started = await w.agents.start(apex.caller, { brief: { objective: "Keep working." }, harness: "claude", name, clientKey: `k-${name}`, cwd: w.root, wake: "never" })
      assert.ok(!("refused" in started) && started.conversation && started.child, JSON.stringify(started))
      fins.push({ child: started.child, conversation: started.conversation })
    }
    const kindIn = (conversation: string, fin: number) => w.live.held(conversation)?.nativeAgents?.agents.find((agent) => agent.child?.thread === fins[fin]!.child)?.state.kind
    await waitFor(() => kindIn(apex.conversation, 0) === "working" && kindIn(apex.conversation, 1) === "working", "the Apex's Session has both at work")

    // A new tab of the Apex's Thread is its newest Session; the Apex's own is older now.
    const apexThread = w.store.journalPlacement(apex.conversation)!.thread
    const tab = w.store.createSession({ operationId: randomUUID(), thread: apexThread, actor: w.store.person() })
    const newest = randomUUID()
    await w.live.start("codex", w.root, { conversationId: newest, session: tab.session, initialRequest: { id: randomUUID(), text: "And this?", attachments: [] } })
    await waitFor(() => w.live.held(newest)?.requests[0]?.status === "completed", "the new tab's first turn ends")
    assert.equal(w.agents.showsFins(newest), true, "the newest Session hears its Thread's Fins")
    assert.equal(w.agents.showsFins(apex.conversation), false, "an older one doesn't")
    const rostersTo = (from: number, conversation: string) => w.events.slice(from).filter((event) => event.type === "live-batch" && event.batch.id === conversation && event.batch.nativeAgents !== undefined).length

    // A Fin ends with the older Session in memory: the newest hears it, the older keeps what it last heard.
    let from = w.events.length
    w.release(fins[0]!.conversation)
    await waitFor(() => kindIn(newest, 0) !== undefined && kindIn(newest, 0) !== "working", "the newest Session hears the first Fin end")
    assert.ok(rostersTo(from, newest) > 0, "every window is sent it, in the newest Session's batch")
    assert.equal(kindIn(apex.conversation, 0), "working", "an older Session in memory isn't told")
    assert.equal(rostersTo(from, apex.conversation), 0, "and no window is sent its roster")
    // The person closes it, and it goes from memory while a Fin of its Thread still works.
    await w.live.close(apex.conversation)
    await waitFor(() => w.live["records"].release(apex.conversation), "the closed Session goes from memory")
    assert.equal(kindIn(newest, 1), "working")

    // The other ends with it let go of: nothing reads it back in, neither the move nor the wake its end refreshes.
    from = w.events.length
    w.release(fins[1]!.conversation)
    await waitFor(() => kindIn(newest, 1) !== undefined && kindIn(newest, 1) !== "working", "the newest Session hears the second Fin end")
    await w.settle(300)
    assert.equal(w.live.held(apex.conversation), undefined, "the older Session wasn't read back in")
    assert.equal(rostersTo(from, apex.conversation), 0)

    // Read back in, closed, it takes its Fins as they stand.
    assert.equal(w.live.snapshot(apex.conversation)?.session.status, "closed", "the closed Session reads back in")
    for (const fin of [0, 1]) assert.equal(kindIn(apex.conversation, fin), kindIn(newest, fin), "with its Fins as they stand")
  } finally {
    await w.close()
  }
}

/**
 * An open ask always surfaces: whichever Session of a Fin's Thread waits on an approval, the older or the newer, beside
 * one left idle, is what the Fin's standing says, here (its Apex's roster and the person's ask) and on another device
 * (the row it draws from the account's list), and the answer reaches the Session that asked. A Fin read one Session
 * alone, the one its host first found, so an approval in another tab was nobody's to see.
 */
async function anySessionAsks(): Promise<void> {
  for (const asker of ["newer", "older"] as const) {
    const w = world(`asks-${asker}`, (turn) => (turn.text.includes("You're fin:") ? "Done: it's finished." : "Started it."))
    try {
      const apex = await w.apex("codex")
      const started = await w.agents.start(apex.caller, { brief: { objective: "Finish." }, harness: "claude", name: "asker", clientKey: "k-asker", cwd: w.root })
      assert.ok(!("refused" in started) && started.conversation && started.child, JSON.stringify(started))
      await waitFor(() => w.live.held(started.conversation!)?.requests[0]?.status === "completed", "the Fin's first turn ends")
      // A new tab of the Fin's Thread, idle once its first turn ends: its newest Session.
      const tab = w.store.createSession({ operationId: randomUUID(), thread: ThreadIdSchema.parse(started.child), actor: w.store.person() })
      const newer = randomUUID()
      await w.live.start("claude", w.root, { conversationId: newer, session: tab.session, initialRequest: { id: randomUUID(), text: "Anything else?", attachments: [] } })
      await waitFor(() => w.live.held(newer)?.requests[0]?.status === "completed", "the new tab's first turn ends")
      const entry = () => w.agents.roster(apex.conversation).find((agent) => agent.child?.thread === started.child)
      assert.notEqual(entry()?.child?.state?.kind, "blocked", `${asker}: nothing asks yet`)
      const asking = asker === "newer" ? newer : started.conversation!
      const answered = w.ask(asking, "Run the migration?")
      await waitFor(() => entry()?.child?.state?.kind === "blocked", `${asker}: its Apex's roster says the ${asker} Session asks, not that the other is idle`)
      const ask = w.agents.personAsk(apex.conversation)
      assert.equal(ask?.line, "Approve: Run the migration?", `${asker}: the person is asked it`)
      // Another device draws the Fin from the account's list of the Apex: it asks there too.
      const listed = listedFins(w.agents.roster(apex.conversation))?.find((fin) => fin.thread === started.child)
      assert.equal(listed?.state.kind, "blocked", `${asker}: the row another device draws from says it asks`)
      // The answer goes to the Session that asked.
      const respond = await w.agents.respond(apex.conversation, { fin: ask!.fin, ask: ask!.ask.id, request: randomUUID(), allow: true })
      assert.ok(!("refused" in respond), JSON.stringify(respond))
      await answered
      assert.equal(w.live.waitingOn(asking), undefined, `${asker}: the answer reached the Session that asked`)
    } finally {
      await w.close()
    }
  }
}

/**
 * A Fin's older Session waiting on the person for something that's neither an approval nor a question (its subagent
 * waits, with nothing more to say: needs-you, by the protocol's `asks`) is what the Fin stands on, beside a newer one
 * idle, and it's the person's, never its Apex's to answer. An approval in the older Session beside a newer one that
 * needs the person still reaches its Apex, and its answer the Session that asked.
 */
async function aSessionNeedsYou(): Promise<void> {
  const w = world("needs-you", (turn) => (turn.text.includes("You're fin:") ? "Done: it's finished." : "Started it."))
  try {
    const apex = await w.apex("codex")
    const started = await w.agents.start(apex.caller, { brief: { objective: "Finish." }, harness: "claude", name: "needing", clientKey: "k-needing", cwd: w.root })
    assert.ok(!("refused" in started) && started.conversation && started.child, JSON.stringify(started))
    const older = started.conversation
    await waitFor(() => w.live.held(older)?.requests[0]?.status === "completed", "the Fin's first turn ends")
    const tab = w.store.createSession({ operationId: randomUUID(), thread: ThreadIdSchema.parse(started.child), actor: w.store.person() })
    const newer = randomUUID()
    await w.live.start("claude", w.root, { conversationId: newer, session: tab.session, initialRequest: { id: randomUUID(), text: "Anything else?", attachments: [] } })
    await waitFor(() => w.live.held(newer)?.requests[0]?.status === "completed", "the new tab's first turn ends")
    const entry = () => w.agents.roster(apex.conversation).find((agent) => agent.child?.thread === started.child)
    const waits = (conversation: string, kind: "waiting" | "completed") =>
      w.live.observe({ type: "live-agent", id: conversation, agent: { nativeId: "sub", title: "Explore", work: "agent", stoppable: true, state: { kind } } })
    waits(older, "waiting")
    assert.equal(w.live.workOf(older)?.status, "waiting", "the older Session waits on the person")
    assert.equal(w.live.waitingOn(older), undefined, "for nothing it names")
    await waitFor(() => entry()?.child?.state?.kind === "blocked", "its Apex's roster says the Fin waits, not that its newer Session is idle")
    const state = entry()?.child?.state
    assert.equal(state?.kind === "blocked" ? state.on : undefined, "person", "on the person, not its Apex")
    assert.equal(entry()?.child?.conversation, older, "read from the Session that waits")
    waits(older, "completed")
    await waitFor(() => entry()?.child?.state?.kind !== "blocked", "and no longer, once it doesn't")

    // The older Session asks for an approval while the newer one needs the person: the approval is its Apex's to hear,
    // and its answer reaches the older Session.
    waits(newer, "waiting")
    const answered = w.ask(older, "Run the migration?")
    await waitFor(() => w.agents.personAsk(apex.conversation)?.ask.kind === "approval", "the approval is asked")
    const ask = w.agents.personAsk(apex.conversation)!
    const respond = await w.agents.respond(apex.conversation, { fin: ask.fin, ask: ask.ask.id, request: randomUUID(), allow: true })
    assert.ok(!("refused" in respond), JSON.stringify(respond))
    await answered
    assert.equal(w.live.waitingOn(older), undefined, "the answer reached the Session that asked")
  } finally {
    await w.close()
  }
}

/** A list reads what the listing and the store hold, never a journal: one Fin's search once read 74 back at once. */
async function listsReadNoJournal(): Promise<void> {
  const rows: ThreadRef[] = []
  const lists: (string | undefined)[] = []
  const w = new AgentsWorld({
    root: join(root, "lists"),
    script: (turn) => (turn.text.includes("You're fin:") ? "Done: it's finished." : "Started them."),
    // As the catalog lists: filtered, newest first, and only then capped.
    references: {
      list: ({ harness } = {}) => {
        lists.push(harness)
        return rows.filter((row) => !harness || row.harness === harness).sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "")).slice(0, THREAD_LIST_CAP)
      },
      transcriptArtifact: async () => null,
    },
  })
  try {
    const apex = await w.apex("codex")
    const fins: string[] = []
    for (const name of ["one", "two", "three"]) {
      const started = await w.agents.start(apex.caller, { brief: { objective: "Finish." }, harness: "claude", name, clientKey: `k-${name}`, cwd: w.root })
      assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
      fins.push(started.conversation)
    }
    await w.settle()
    const records = w.live["records"]
    const loaded = () => w.live.residency().memory.loads.reduce((sum, load) => sum + load.count, 0)
    const quiet = async <Answer>(what: string, list: () => Promise<Answer>): Promise<Answer> => {
      for (const fin of fins.slice(1)) records.release(fin)
      const before = loaded()
      const answer = await list()
      assert.equal(loaded(), before, `${what} reads no journal`)
      return answer
    }
    const asFin = w.caller(fins[0]!)
    for (const scope of [undefined, "tree", "apexes", "threads"] as const) await quiet(`an Apex's ${scope ?? "children"} list`, () => w.agents.list(apex.caller, { ...(scope && { scope }) }))
    for (const scope of [undefined, "tree", "apexes", "crew", "threads"] as const) await quiet(`a Fin's ${scope ?? "children"} list`, () => w.agents.list(asFin, { ...(scope && { scope }) }))
    await quiet("a Fin's search of Threads", () => w.agents.list(asFin, { scope: "threads", query: "anything" }))

    // What a Fin may reach is exactly what it could: its tree's Sessions, unloaded or not, and nothing outside it.
    const nativeOf = (conversation: string) => w.live.nativeIds(conversation)[0]
    const sibling = nativeOf(fins[1]!)
    assert.ok(sibling, "a released Fin's harness Session is still listed")
    assert.equal(w.live.held(fins[1]!), undefined, "with nothing of it in memory")
    assert.deepEqual([...w.live.nativeIds(fins[1]!)], w.live.snapshot(fins[1]!)?.control?.bindings.flatMap((binding) => (binding.nativeId ? [{ provider: binding.provider, nativeId: binding.nativeId }] : [])), "and the listing says what the journal does")
    records.release(fins[1]!)
    const row = (harness: string, nativeId: string): ThreadRef => ({ harness, nativeId, path: `/rail/${nativeId}.jsonl`, title: `Thread ${nativeId}`, updatedAt: new Date(NOW).toISOString() })
    rows.push(row(sibling.provider, sibling.nativeId), row("codex", "somebody-elses"))
    for (let at = 0; at < 2_000; at += 1) rows.push(row("codex", `other-${at}`))
    lists.length = 0
    const found = await quiet("a Fin's search over 2,000 rows", () => w.agents.list(asFin, { scope: "threads" }))
    assert.ok(found && "threads" in found, JSON.stringify(found))
    assert.deepEqual(found.threads.map((thread) => thread.ref).filter((ref) => ref.includes(sibling.nativeId)).length, 1, "a Fin of its tree is in reach")
    assert.equal(found.threads.some((thread) => thread.ref.includes("somebody-elses")), false, "a Thread outside it isn't")
    assert.equal(new Set(lists).size, lists.length, `each list is read once a search, not once a row (${lists.length})`)

    // A row another harness's newer Sessions would push past the cap: a Fin's sibling, known by its provider's identity.
    const days = (ago: number) => new Date(NOW - ago * 86_400_000).toISOString()
    const chats = `chats:${sibling.nativeId}`
    rows.length = 0
    rows.push({ ...row(sibling.provider, sibling.nativeId), identity: chats, updatedAt: days(30) })
    rows.push({ ...row(sibling.provider, "not-of-this-tree"), identity: "chats:not-of-this-tree", updatedAt: days(30) })
    for (let at = 0; at < THREAD_LIST_CAP; at += 1) rows.push({ ...row("codex", `newer-${at}`), updatedAt: days(1) })
    assert.notEqual(sibling.provider, "codex", "the sibling's harness isn't the one filling the list")
    const named = (id: string, what: string) => quiet(what, () => w.agents.list(asFin, { scope: "threads", query: threadToken(sibling.provider, id).slice(1) }))
    const refsOf = (answer: Awaited<ReturnType<typeof named>>) => (answer && "threads" in answer ? answer.threads.map((thread) => thread.ref) : [])
    assert.deepEqual(refsOf(await named(chats, "a Fin naming its sibling")), [threadToken(sibling.provider, chats).slice(1)], "its sibling is in reach by its identity, whatever fills the list")
    assert.equal(refsOf(await named(chats.slice(0, 14), "a Fin shortening its sibling's id")).length, 1, "and by a short id only it has")
    assert.deepEqual(refsOf(await named("chats:not-of-this-tree", "a Fin naming a stranger")), [], "a row of the same harness outside its tree isn't")
    assert.deepEqual(refsOf(await named("chats:", "a Fin's id two rows could mean")), [], "nor an id that could mean either")
  } finally {
    await w.close()
  }
}

async function stoppedApexHolds(): Promise<void> {
  let working = 0
  const w = new AgentsWorld({
    root: join(root, "stopped-apex"),
    script: (turn) => turn.text.includes("You're fin:") || turn.text.includes("Carry on") ? (working++, turn.world.hold(turn.conversation).then(() => (working--, "stopped"))) : "ok",
    finLimit: () => 2,
  })
  try {
    const person = await w.apex("claude")
    const brief = { objective: "Hold" }
    const lead = await w.agents.start(person.caller, { brief, name: "lead", clientKey: "lead", cwd: w.root })
    assert.ok(!("refused" in lead) && lead.conversation, JSON.stringify(lead))
    await waitFor(() => working === 1, "the lead at work")
    const leadCaller = w.caller(lead.conversation)
    await w.agents.start(leadCaller, { brief, name: "helper", clientKey: "helper", cwd: w.root })
    await waitFor(() => working === 2, "its helper at work")
    const later = await w.agents.start(leadCaller, { brief, name: "later", queue: true, clientKey: "later", cwd: w.root })
    assert.ok(!("refused" in later) && later.state === "queued", JSON.stringify(later))
    const waiting = () => w.agents.roster(lead.conversation!).flatMap((entry) => (entry.state.kind === "waiting" ? [entry.state.reason] : []))

    await w.agents.stop(person.caller, { child: "lead" })
    await w.agents.stop(leadCaller, { child: "helper" })
    await waitFor(() => working === 0 || w.store.queuedSpawns().length === 0, "both places free")
    await w.settle()
    assert.equal(w.store.queuedSpawns().length, 1, "a stopped Apex's queued Fin doesn't start in the room its stop left")
    assert.deepEqual(waiting(), ["Waiting: its Apex was stopped"])

    const sent = await w.agents.send(person.caller, { to: "lead", text: "Carry on.", clientKey: "resume" })
    assert.ok(!("refused" in sent), JSON.stringify(sent))
    await waitFor(() => w.store.queuedSpawns().length === 0 && working === 2, "the queued Fin to start once its Apex resumed")
    assert.ok(w.store.edges().all.some((edge) => edge.name === "later"))
    await w.agents.stop(leadCaller, { child: "all" })
    await w.agents.stop(person.caller, { child: "all" })
  } finally {
    await w.close()
  }
}

/**
 * A Fin's reading is taken of every Fin there is, on every capacity look, Sessions report and roster: it reads a journal
 * in for none of them. It did, and on a Mac with 90 Fins the memory sweep let go of them and the next look loaded them
 * back, 5.6 journals a second, on the host's thread.
 */
async function finReadingsLoadNothing(): Promise<void> {
  const first = world("readings-load-nothing", () => "done")
  let next: AgentsWorld | undefined
  try {
    const apex = await first.apex("claude")
    await first.agents.start(apex.caller, { brief: { objective: "Finish" }, name: "done", clientKey: "done", cwd: first.root })
    await first.settle()
    const [edge] = first.store.edges().all
    assert.ok(edge, "its edge")
    const fin = first.store.thread(edge.child)!.sessions.flatMap((session) => first.store.conversationsOf(session)).at(-1)!
    await first.close()
    // Its harness gone with the host that ran it, it can be let go of, as the memory budget's sweep does.
    next = new AgentsWorld({ root: first.root, script: () => "ok" })
    if (next.live.loaded(fin)) assert.ok(next.live["records"].release(fin), "let go of")
    assert.equal(next.live.loaded(fin), false, "it's on disk")
    const listed = await next.agents.list(apex.caller, {})
    assert.ok("tree" in listed && listed.children.length === 1, JSON.stringify(listed))
    assert.equal(next.live.loaded(fin), false, "listing it leaves it there")
    await next.agents["observe"](true)
    assert.equal(next.live.loaded(fin), false, "and so does a look at this device's capacity")
    next.live.summaries()
    assert.equal(next.live.loaded(fin), false, "and a roster")
  } finally {
    await next?.close()
    await first.close().catch(() => {})
  }
}

/** What a Fin shows it runs with: a request on the binding it left says nothing of the one it's on, loaded or not. */
function settingsFollowTheBinding(): void {
  const asked = (model: string, on?: string, target?: string): LiveRequest => ({
    id: randomUUID(),
    text: "Go",
    attachments: [],
    status: "completed",
    tuning: { model },
    ...(on && { nativeRun: { bindingId: on, runId: "run" } }),
    ...(target && { targetBindingId: target }),
  })
  const snapshot = (requests: LiveRequest[], settings?: { model: string }, activeBindingId?: string): Parameters<typeof settingsIn>[0] => ({
    requests,
    session: { ...(settings && { settings }) },
    ...(activeBindingId && { control: { activeBindingId, bindings: [] } }),
  })
  const moved = { model: "destination" }
  assert.deepEqual(settingsIn(snapshot([asked("source", "before")], moved, "after")), moved, "after a move, the source's last model isn't this one's")
  assert.deepEqual(settingsIn(snapshot([asked("source", "before"), asked("chosen here", "after")], moved, "after")), { model: "chosen here" }, "a model asked of this binding is still the first word")
  assert.deepEqual(settingsIn(snapshot([asked("source", "before"), asked("waiting", undefined, "after")], moved, "after")), { model: "waiting" }, "as is one on its way to it")
  assert.deepEqual(settingsIn(snapshot([asked("before bindings")], moved, "after")), { model: "before bindings" }, "a request that names no binding reads as it did")
  assert.deepEqual(settingsIn(snapshot([asked("only")], moved)), { model: "only" }, "and so does a conversation with none")
}

async function waitFor(check: () => boolean, what: string, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
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
    continueOn: () => Promise.reject(new Error("This test moves no conversation")),
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
    continueOn: () => Promise.reject(new Error("This test moves no conversation")),
    startLive: () => Promise.reject(new Error("This test starts no conversation")),
    harnesses: () => ["cursor"],
    runs: () => true,
    harnessLabel: () => "Cursor",
    modes: () => undefined,
    processes: {
      marked: async () => (successor === undefined ? [] : [{ pid: successor, value: apex.session }]),
      holding: async (_file, pids) => new Set(pids.filter((pid) => pid === successor)),
      folders: async () => new Map(),
      startedAt: PROCESS_READS.startedAt,
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
    processes: { marked: async () => [], holding: async () => new Set(), folders: async () => new Map(), startedAt: PROCESS_READS.startedAt },
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
    processes: { marked: async () => [], holding: async () => new Set(), folders: async () => new Map(), startedAt: PROCESS_READS.startedAt },
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
    assert.equal(w.store.reportsOf(child, 0).at(-1)?.status, "blocked", "a run whose process ended unexplained is a cut its Apex decides on")
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
/**
 * What a Fin runs on: its Apex's model on the Apex's harness, the person's own choices on another (Settings › Fins,
 * then what they last used there), Mako's pick only after those, and what a spawn names held to the harness's catalog.
 * On `main` before this, a Fin on another harness ran on that harness's default and a named model went unchecked.
 */
async function finModels(): Promise<void> {
  const claude = recordedCatalog("claude")!.models
  const codex = recordedCatalog("codex")!.models
  const cursor = recordedCatalog("cursor")!.models
  const w = new AgentsWorld({
    root: join(root, "models"),
    script: (turn) => (turn.text.includes("You're fin:") ? "done" : "ok"),
    defaults: { claude: { model: "claude-opus-5-5", options: { effort: "high", fast: false } }, codex: { model: "gpt-6.1-sol", options: { effort: "medium", serviceTier: "default" } } },
    catalogs: { claude, codex, cursor },
    fins: { chosen: { cursor: { model: "gpt-4o" } }, used: { claude: { model: "claude-sonnet-5", options: { effort: "medium" } } } },
  })
  try {
    const apex = await w.apex("cursor", "full", { model: "claude-opus-5-5[context=300k,effort=xhigh,fast=true]" })
    const brief = { objective: "Look" }
    const same = await w.agents.start(apex.caller, { brief, name: "same", clientKey: "s", cwd: w.root })
    const other = await w.agents.start(apex.caller, { brief, harness: "claude", name: "other", clientKey: "o", cwd: w.root })
    const told = await w.agents.start(apex.caller, { brief, harness: "codex", reasoning: "high", name: "told", clientKey: "t", cwd: w.root })
    const named = await w.agents.start(apex.caller, { brief, harness: "claude", model: "opus 5.5", reasoning: "max", fast: true, name: "named", clientKey: "n", cwd: w.root })
    assert.ok(!("refused" in same) && !("refused" in other) && !("refused" in told) && !("refused" in named), JSON.stringify([same, other, told, named]))
    const asked = (answer: AgentsStarted) => w.live.snapshot(answer.conversation!)?.requests[0]?.tuning
    assert.deepEqual(asked(same), { model: "claude-opus-5-5", options: { context: "300k", effort: "xhigh", fast: "true" } }, "a Fin on its Apex's harness runs on the Apex's model, reasoning and fast lane, past a Fins default Cursor no longer lists")
    assert.match(same.note ?? "", /Your Fins default for Cursor, gpt-4o, isn't listed by Cursor anymore: it runs on Claude Opus 5\.5 instead\./, "and the Apex hears the default was passed over")
    assert.equal(same.runsOn, "Claude Opus 5.5 · Extra High · Fast")
    assert.deepEqual(asked(other), { model: "claude-sonnet-5", options: { effort: "medium" } }, "one on another harness runs on what the person last used there, not the harness's default")
    assert.deepEqual(asked(told), { model: "gpt-6.1-sol", options: { effort: "high", serviceTier: "default" } }, "\"Codex on high\": Codex's model for the person, on high")
    assert.deepEqual(asked(named), { model: "claude-opus-5-5", options: { effort: "max", fast: true } }, "a named model, level and fast lane, read leniently")
    const unknown = await w.agents.start(apex.caller, { brief, harness: "claude", model: "gpt-6", name: "unknown", clientKey: "u", cwd: w.root })
    assert.ok("refused" in unknown && unknown.refused === "unknown-model" && /Claude has no model "gpt-6"\. Its models: Opus 5\.5 \(claude-opus-5-5\)/.test(unknown.why), JSON.stringify(unknown))
    const levelless = await w.agents.start(apex.caller, { brief, harness: "claude", model: "haiku", reasoning: "high", name: "levelless", clientKey: "l", cwd: w.root })
    assert.ok("refused" in levelless && /Haiku 4\.5 on Claude has no reasoning levels/.test(levelless.why), JSON.stringify(levelless))
    await w.settle()
    const listed = await w.agents.list(apex.caller, {})
    assert.ok("children" in listed)
    assert.deepEqual(
      listed.children.map((strip) => [strip.name, strip.runsOn]),
      [["same", "Claude Opus 5.5 · Extra High · Fast"], ["other", "Sonnet 5 · Medium"], ["told", "GPT-6.1-Sol · High"], ["named", "Opus 5.5 · Max · Fast"]],
      "each strip says its model, reasoning and fast lane"
    )
    const rows = w.agents.roster(apex.conversation)
    assert.deepEqual(rows.map((entry) => entry.runsOn && [entry.runsOn.model, entry.runsOn.reasoning, entry.runsOn.fast ?? false]), [["Claude Opus 5.5", "Extra High", true], ["Sonnet 5", "Medium", false], ["GPT-6.1-Sol", "High", false], ["Opus 5.5", "Max", true]], "and so does each Fin's row")
    assert.match(rows[0]!.runsOn?.note ?? "", /gpt-4o, isn't listed by Cursor anymore/, "the row keeps why its model isn't the Fins default")
  } finally {
    await w.close()
  }
}

/**
 * The person's rules for Fins, in their words: every Thread reads them once before the person's next message, and
 * again only when they change; a Fin started by one runs on its harness and model and says so; work no rule fits goes
 * to their `otherwise`; what the person named in chat still wins; a rule that isn't there is refused with the ones that are.
 */
async function finRules(): Promise<void> {
  const catalogs = { claude: recordedCatalog("claude")!.models, codex: recordedCatalog("codex")!.models, cursor: recordedCatalog("cursor")!.models }
  let policy: FinPolicy = {
    rules: [
      { id: "backend", when: "Anything that isn't frontend: APIs,\n  migrations, tests", target: { harness: "codex", settings: { model: "gpt-6.1-sol", options: { effort: "high", plan: true } } } },
      { id: "ui", when: "UI and CSS", target: { harness: "claude" } },
    ],
    otherwise: { harness: "cursor", settings: { model: "composer-2.5", options: { fast: "true" } } },
  }
  const heard: Heard[] = []
  const w = new AgentsWorld({
    root: join(root, "rules"),
    script: (turn) => (turn.text.includes("You're fin:") ? "done" : "ok"),
    defaults: { codex: { model: "gpt-6.1-sol", options: { effort: "medium", serviceTier: "default" } } },
    catalogs,
    policy: () => policy,
    heard: (each) => heard.push(each),
  })
  try {
    const apex = await w.apex("claude", "full", { model: "claude-opus-5-5", options: { effort: "max" } })
    const said = async (text: string) => {
      w.say(apex.conversation, text)
      await waitFor(() => heard.some((each) => each.conversation === apex.conversation && each.text.includes(text)), `the Apex hearing "${text}"`)
      return heard.findLast((each) => each.conversation === apex.conversation && each.text.includes(text))!.text
    }
    const first = await said("Split the work up.")
    assert.match(first, /The person's rules for picking a Fin's harness and model, first fit wins\. Pass its number as agents_start's rule/)
    assert.match(first, /\n1\. Anything that isn't frontend: APIs, migrations, tests → Codex · GPT-6\.1-Sol · High\n2\. UI and CSS → Claude, on the model the person uses there\nNone fits: Cursor · Composer 2\.5 · Fast \(leave rule out\)\./, "one short line each, in the person's words")
    assert.doesNotMatch(await said("And the docs?"), /The person's rules/, "read once, not on every message")
    policy = { ...policy, rules: policy.rules.slice(0, 1) }
    assert.match(await said("One more."), /\n1\. Anything that isn't frontend[^\n]*\nNone fits:/, "and again once they change")

    const brief = { objective: "Look" }
    const asked = (answer: AgentsStarted) => ({ harness: w.live.session(answer.conversation!)?.harness, tuning: w.live.snapshot(answer.conversation!)?.requests[0]?.tuning })
    policy = { ...policy, rules: [...policy.rules, { id: "ui", when: "UI and CSS", target: { harness: "claude" } }] }
    const backend = await w.agents.start(apex.caller, { brief, rule: 1, name: "backend", clientKey: "b", cwd: w.root })
    const ui = await w.agents.start(apex.caller, { brief, rule: 2, name: "ui", clientKey: "u", cwd: w.root })
    const unsure = await w.agents.start(apex.caller, { brief, name: "unsure", clientKey: "x", cwd: w.root })
    const named = await w.agents.start(apex.caller, { brief, rule: 1, harness: "claude", name: "named", clientKey: "n", cwd: w.root })
    const told = await w.agents.start(apex.caller, { brief, harness: "codex", reasoning: "low", name: "told", clientKey: "t", cwd: w.root })
    for (const answer of [backend, ui, unsure, named, told]) assert.ok(!("refused" in answer), JSON.stringify(answer))
    const ok = (answer: typeof backend): AgentsStarted => {
      assert.ok(!("refused" in answer), JSON.stringify(answer))
      return answer
    }
    assert.deepEqual(asked(ok(backend)), { harness: "codex", tuning: { model: "gpt-6.1-sol", options: { effort: "high" } } }, "rule 1's harness and model, never its plan mode")
    assert.equal(ok(backend).rule, "Rule 1 · Anything that isn't frontend: APIs, migrations, tests")
    assert.deepEqual(asked(ok(ui)), { harness: "claude", tuning: { model: "claude-opus-5-5", options: { effort: "max" } } }, "a rule that names only a harness runs as the person does there: here, the Apex's own model")
    assert.deepEqual(asked(ok(unsure)), { harness: "cursor", tuning: { model: "composer-2.5", options: { fast: "true" } } }, "work no rule fits goes to the person's otherwise")
    assert.equal(ok(unsure).rule, "No rule fit")
    assert.deepEqual(asked(ok(named)), { harness: "claude", tuning: { model: "claude-opus-5-5", options: { effort: "max" } } }, "a harness the person named wins over the rule's, whose model is for its own harness")
    assert.equal(ok(named).rule, "Rule 1 · Anything that isn't frontend: APIs, migrations, tests", "and the rule is still what it followed")
    assert.equal(asked(ok(told)).harness, "codex")
    assert.equal(ok(told).rule, undefined, "a harness named with no rule follows none, and never the otherwise")
    const missing = await w.agents.start(apex.caller, { brief, rule: 7, name: "missing", clientKey: "m", cwd: w.root })
    assert.ok("refused" in missing && missing.refused === "unknown-rule" && /has 2 rules, so there's no rule 7: 1\. Anything that isn't frontend.* 2\. UI and CSS/s.test(missing.why), JSON.stringify(missing))
    await w.settle()
    const rows = w.agents.roster(apex.conversation)
    assert.deepEqual(rows.map((row) => row.runsOn?.rule), ["Rule 1 · Anything that isn't frontend: APIs, migrations, tests", "Rule 2 · UI and CSS", "No rule fit", "Rule 1 · Anything that isn't frontend: APIs, migrations, tests", undefined], "each row says the rule it followed")
    const listed = await w.agents.list(apex.caller, {})
    assert.ok("children" in listed && listed.children[0]?.rule === "Rule 1 · Anything that isn't frontend: APIs, migrations, tests")
    const lead = await w.agents.start(apex.caller, { brief, role: "lead", harness: "claude", name: "lead", clientKey: "l", cwd: w.root })
    assert.ok(!("refused" in lead))
    assert.match(w.live.snapshot(lead.conversation!)?.requests[0]?.text ?? "", /The person's rules for picking a Fin's harness/, "an Apex of its own reads the rules with its brief")
  } finally {
    await w.close()
  }
}

/**
 * A Fin never starts on a harness whose account is at its limit without saying so. Its Apex named no harness: it
 * starts on the person's next harness with room, and the answer and its row say why. Named, or with nowhere to go:
 * refused with the reset and the person's fallbacks. On the code before this, all five started on Claude and stopped.
 */
async function limitedHarnesses(): Promise<void> {
  const until = Date.now() + 3 * 3_600_000
  const claude = recordedCatalog("claude")!.models
  const codex = recordedCatalog("codex")!.models
  const cursor = recordedCatalog("cursor")!.models
  const limit = { account: "ada@example.com", until, instead: "ada-team@example.com" }
  const w = new AgentsWorld({
    root: join(root, "limited"),
    script: (turn) => (turn.text.includes("You're fin:") ? "done" : "ok"),
    defaults: { codex: { model: "gpt-6.1-sol", options: { effort: "medium", serviceTier: "default" } } },
    catalogs: { claude, codex, cursor },
    limits: { claude: limit, cursor: { account: "ada", until: null } },
    order: ["claude", "cursor", "codex", "grok"],
  })
  try {
    const apex = await w.apex("claude", "full", { model: "claude-opus-5-5", options: { effort: "high" } })
    const brief = { objective: "Look" }
    const moved = await w.agents.start(apex.caller, { brief, name: "moved", clientKey: "m", cwd: w.root })
    assert.ok(!("refused" in moved), JSON.stringify(moved))
    assert.equal(w.live.session(moved.conversation!)?.harness, "codex", "past Claude and Cursor, both at their limit, to the person's next harness with room (Grok has no catalog here)")
    assert.deepEqual(moved.limited, { harness: "claude", until, instead: "ada-team@example.com" })
    assert.match(moved.note ?? "", /^Claude is at its limit on ada@example\.com until \S.*, so it runs on Codex, the person's next harness\. ada-team@example\.com, another Claude account, has room: the person can switch to it in Settings › Agents\.$/)
    await w.settle()
    assert.match(w.agents.roster(apex.conversation)[0]?.runsOn?.note ?? "", /at its limit on ada@example\.com/, "its row says why it isn't on Claude")
    const named = await w.agents.start(apex.caller, { brief, harness: "claude", name: "named", clientKey: "n", cwd: w.root })
    assert.ok("refused" in named && named.refused === "limited", JSON.stringify(named))
    assert.match(named.why, /Claude is at its limit on ada@example\.com until .*, so a Fin there would stop at once\. ada-team@example\.com, another Claude account, has room.*Leave harness and model out to start it on Codex, the person's next harness, or name another\. Or wait for the reset/)
    const model = await w.agents.start(apex.caller, { brief, model: "opus 5.5", name: "model", clientKey: "o", cwd: w.root })
    assert.ok("refused" in model && model.refused === "limited", "a model the Apex named is Claude's: it isn't moved to another harness's")
    const fine = await w.agents.start(apex.caller, { brief, harness: "codex", name: "fine", clientKey: "f", cwd: w.root })
    assert.ok(!("refused" in fine) && fine.limited === undefined && !fine.note, "a harness with room starts as asked, saying nothing")
  } finally {
    await w.close()
  }
  const nowhere = new AgentsWorld({
    root: join(root, "limited-nowhere"),
    script: () => "ok",
    catalogs: { claude: recordedCatalog("claude")!.models },
    limits: { claude: { account: "ada", until } },
    order: ["claude"],
  })
  try {
    const apex = await nowhere.apex("claude", "full")
    const refused = await nowhere.agents.start(apex.caller, { brief: { objective: "Look" }, name: "stuck", clientKey: "s", cwd: nowhere.root })
    assert.ok("refused" in refused && refused.refused === "limited" && /No other harness here has room either/.test(refused.why), JSON.stringify(refused))
  } finally {
    await nowhere.close()
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
  await runCases([
    statesAndEntries,
    rosterAndLists,
    uploadsFollowParents,
    storeKeeps,
    readOnlyStoreVersion,
    startsAndWakes,
    explicitReports,
    refusals,
    finLimit,
    afterOrder,
    slotsGoAtOnce,
    launchesBeforeTheirEdge,
    stopHoldsUntilCancelled,
    followedStopHoldsUntilExit,
    linkTellsUnreadableFromGone,
    followedStopUnknownIdentity,
    followedStopStaleIdentity,
    followedStopStuck,
    queueProjection,
    edgeWriteMovesTheLine,
    harnessLadders,
    accessFits,
    stopAllUnqueues,
    unreadableQueuedStarts,
    finReadingsLoadNothing,
    settingsFollowTheBinding,
    startedFinsOldQueueRow,
    finsAtWorkByBinding,
    stoppedApexHolds,
    listsReadNoJournal,
    activityTellsNoOne,
    progressGoesWhereItsRead,
    finsMoveInTheNewestSession,
    anySessionAsks,
    aSessionNeedsYou,
    followsShellRuns,
    relinkedRuns,
    messagesReachLinkedRuns,
    finModels,
    limitedHarnesses,
    finRules,
    apexStops,
    staleEndsStayOut,
    waitingFins,
    ownSessionIsNoChild,
  ])
  console.log("agents engine: ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}

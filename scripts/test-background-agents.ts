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
import { childEntry, childMode, childState, modeWithin, type ThreadParent } from "@mako/host/contracts/agents"
import { AFTER_START, type AgentsStarted } from "@mako/host/contracts/agent-tools"
import { backgroundWork, backgroundWorkText } from "@mako/host/contracts/background-work"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { AFTER_LIMIT, CHILDREN_BINDING, withChildren } from "@mako/host/contracts/native-agents"
import { listedAsThread, threadList } from "@mako/host/contracts/thread-list"
import { SessionIdSchema, ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { HANDED_OVER_NOTE } from "@mako/host/contracts/children"
import { END_CONFIRM_MS, lastStep } from "@mako/host/conversations/agent-runs"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { Agents, type AgentsDeps } from "@mako/host/conversations/agents"
import { macLoad } from "@mako/host/conversations/mac-capacity"
import { uploadScope } from "@mako/host/conversations/session-uploads"
import { CLAUDE_MODES } from "@mako/host/harnesses/claude/sdk-driver"
import { CURSOR_SDK_MODES } from "@mako/host/harnesses/cursor/sdk/modes"
import { openCodeModes } from "@mako/host/harnesses/opencode/access"
import { ThreadStore } from "@mako/host/threads/store"
import { AgentsWorld, noConversations, type Heard, type Script } from "./lib/agents-world.ts"
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

async function finLimit(): Promise<void> {
  const GB = 1024 ** 3
  // The person's Mac as it stood when Fins took it over: 14 cores, 36 GB, 13 Fins at work and the load at 26.8.
  assert.deepEqual(macLoad({ cores: 14, memoryBytes: 36 * GB, load: 26.8 }, 13), { why: "14 cores, 36 GB", busy: true }, "13 Fins at once is more than this Mac takes easily")
  assert.deepEqual(macLoad({ cores: 14, memoryBytes: 36 * GB, load: 0 }, 0), { why: "14 cores, 36 GB" }, "an idle Mac isn't busy")
  assert.deepEqual(macLoad({ cores: 14, memoryBytes: 36 * GB, load: 12 }, 2), { why: "14 cores, 36 GB, 8 cores of other work", busy: true }, "the person's own work counts first")
  assert.equal(macLoad({ cores: 14, memoryBytes: 36 * GB, load: 0, swapFreeBytes: 100 * 1024 ** 2 }, 0).busy, true, "a Mac out of swap is busy")

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
    capacity: { read: async () => ({ cores: 6, memoryBytes: 16 * GB, load: 20 }) },
    finLimit: () => 2,
  })
  try {
    const apex = await w.apex("opencode")
    const other = await w.apex("claude")
    const brief = { objective: "Hold" }
    const one = await w.agents.start(apex.caller, { brief, name: "one", clientKey: "1", cwd: w.root })
    assert.ok(!("refused" in one) && one.state !== "queued", JSON.stringify(one))
    assert.match(one.mac ?? "", /^This Mac is busy \(6 cores, 16 GB, 20 cores of other work\): it starts anyway/, "a busy Mac is said, and it starts")
    const two = await w.agents.start(apex.caller, { brief, name: "two", clientKey: "2", cwd: w.root })
    assert.ok(!("refused" in two) && two.state !== "queued", JSON.stringify(two))
    await waitFor(() => working === 2, "both Fins at work")
    const refused = await w.agents.start(apex.caller, { brief, name: "three", clientKey: "3-refused", cwd: w.root })
    assert.ok("refused" in refused && refused.refused === "budget", "past the limit a start is refused, never queued unasked")
    assert.equal(refused.why, "2 of the 2 Fins this device runs at once are at work. Pass queue: true to start it when one ends, or after: to start it after one of yours.")
    const three = await w.agents.start(apex.caller, { brief, name: "three", queue: true, clientKey: "3", cwd: w.root })
    assert.ok(!("refused" in three) && three.state === "queued" && !three.child, "with queue it waits")
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
 * `after`: a Fin starts once the Fins it names finish, queued ones too, whatever the limit; one that fails or is
 * stopped holds it and wakes its Apex to decide, and it's dropped once the Apex heard.
 */
async function afterOrder(): Promise<void> {
  const w = world("after", async (turn) => {
    if (!turn.text.includes("You're fin:")) return "ok"
    if (turn.text.includes("Lint it")) {
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
    assert.ok(!("refused" in ship) && ship.state === "queued")
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
    assert.match(w.prompts.filter((prompt) => prompt.conversation === apex.conversation).at(-1)?.text ?? "", /"third" \(Claude\) failed: It didn't start: it was to start after second, which was stopped \(it never started\)/)
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
  statesAndEntries()
  rosterAndLists()
  uploadsFollowParents()
  storeKeeps()
  await startsAndWakes()
  await explicitReports()
  await refusals()
  await finLimit()
  await afterOrder()
  await harnessLadders()
  await accessFits()
  await stopAllUnqueues()
  await followsShellRuns()
  await relinkedRuns()
  await messagesReachLinkedRuns()
  await finModels()
  await limitedHarnesses()
  await finRules()
  await apexStops()
  await staleEndsStayOut()
  await waitingFins()
  await ownSessionIsNoChild()
  console.log("agents engine: ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}

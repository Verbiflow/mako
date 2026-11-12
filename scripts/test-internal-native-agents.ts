import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { build } from "esbuild"
import { z } from "zod"
import { CodexProvider, ThreadRefSchema, type ThreadRef } from "@mako/sessions"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import type { CodexJsonObject } from "@mako/sessions/codex-records"
import { ThreadParentSchema, type AgentCaller } from "@mako/host/contracts/agents"
import { SessionIdSchema } from "@mako/host/contracts/thread-identity"
import { HostJobs } from "@mako/host/base/host-jobs"
import { AgentRuns } from "@mako/host/conversations/agent-runs"
import { AgentsWorld, fakeCatalog } from "./lib/agents-world.ts"

// Captured origin metadata; fixture IDs, paths and discovery timestamps are isolated.
// Encrypted review contents and unavailable approval action IDs are not reconstructed.
const guardian = { thread_source: "guardian_review", source: { subagent: { other: "guardian" } }, originator: "mako", parent_thread_id: "11111111-1111-4111-8111-111111111111" }
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
async function reached(promise: Promise<void>) {
  let timer: NodeJS.Timeout | undefined
  try { await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("native fixture boundary was not reached")), 10_000) })]) }
  finally { clearTimeout(timer) }
}
async function fixture(root: string, metadata: CodexJsonObject = guardian): Promise<ThreadRef> {
  const id = randomUUID(), path = join(root, ".codex", "sessions", `rollout-2026-11-09T04-29-56-${id}.jsonl`)
  mkdirSync(join(root, ".codex", "sessions"), { recursive: true })
  writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id, cwd: root, timestamp: new Date().toISOString(), ...metadata } }) + "\n")
  const info = statSync(path)
  const provider = new CodexProvider(new NativeStores(true), root)
  const ref = await provider.peek({ path, bytes: info.size, mtimeMs: info.mtimeMs }) ?? (await provider.read(path))?.ref
  assert.ok(ref)
  return ref
}
function stale(ref: ThreadRef): ThreadRef { const { nativeAgent: _nativeAgent, ...before } = ref; return before }
function world(root: string, fake = fakeCatalog(), marked: { pid: number; value: string }[] = []) {
  return new AgentsWorld({ root, script: (turn) => {
    if (turn.text.includes("You're fin:real-failure,")) turn.world.endWith(turn.conversation, { fail: "real managed worker failed" })
    return "ok"
  }, catalog: fake.catalog, processes: {
    marked: async () => marked, holding: async () => new Set([process.pid]),
    folders: async () => new Map([[process.pid, root]]), startedAt: async () => Date.now(),
  } })
}
function agentSession(caller: AgentCaller): string {
  assert.ok("session" in caller)
  return caller.session
}
function historical(w: AgentsWorld, caller: AgentCaller, ref: ThreadRef, name = "guardian-review") {
  const actor = { kind: "agent" as const, session: SessionIdSchema.parse(agentSession(caller)) }
  const parent = w.store.sessionPlacement(actor.session)!.thread, child = w.store.place(stale(ref), actor).thread, at = Date.now() - 5_000
  const edge = w.store.keepEdge({ child, parent, parentSession: actor.session, name, role: "worker", origin: "discovered", asked: { brief: { objective: name }, harness: "codex" }, op: `discovered:codex:${ref.nativeId}`, startedBy: actor, createdAt: at, run: { harness: "codex", nativeId: ref.nativeId, device: w.store.deviceId, startedAt: at, ended: { at: at + 1, kind: "unknown", detail: "Its process ended without saying how it went." } } })
  const id = `report:${child}:cut:run:${at}`
  w.store.keepReport({ id, child, status: "blocked", implicit: true, summary: "Its run was cut short", question: "Continue or Stop?", ownerGeneration: 1, at: at + 1 })
  return { edge, report: id }
}
function keptEdge(root: string, child: string) {
  const db = new DatabaseSync(join(root, "threads.sqlite"), { readOnly: true })
  try {
    const row = z.object({ record: z.string() }).parse(db.prepare("SELECT record FROM thread_parents WHERE child_thread = ?").get(child))
    return ThreadParentSchema.parse(JSON.parse(row.record))
  } finally { db.close() }
}
async function discovery(root: string) {
  const fake = fakeCatalog(), marked: { pid: number; value: string }[] = [], w = world(root, fake, marked)
  try {
    const apex = await w.apex("codex", "full"); await w.settle(); marked.push({ pid: process.pid, value: agentSession(apex.caller) })
    const ref = await fixture(root); fake.write(ref, []); await w.agents.runs.discovered()
    assert.equal(w.store.edges().byRun("codex", ref.nativeId), undefined, "an internal guardian is not an ordinary discovered Fin")
    assert.deepEqual(ref.nativeAgent, { kind: "internal-review", role: "guardian", source: "guardian_review", parentNativeId: guardian.parent_thread_id, originator: "mako" })
    assert.deepEqual(ThreadRefSchema.parse(ref).nativeAgent, ref.nativeAgent, "origin survives the persisted/wire schema")
    const older = await fixture(root, { source: guardian.source, parent_thread_id: guardian.parent_thread_id })
    assert.equal(older.nativeAgent?.kind, "internal-review", "native guardian source also identifies older recordings")
    const partial = await fixture(root, { ...guardian, parent_thread_id: 42, originator: null })
    assert.equal(partial.nativeAgent?.kind, "internal-review", "an unrelated malformed field does not erase a known internal source")
    const child = await fixture(root, { ...guardian, thread_source: "subagent" })
    assert.equal(child.nativeAgent?.kind, "internal-review", "the native child reader preserves origin too")
    assert.equal(child.childOf?.nativeId, guardian.parent_thread_id)
    const linked = await w.agents.runs.adopt({ parentSession: agentSession(apex.caller), ref: stale(ref), origin: "linked", startedBy: { kind: "agent", session: SessionIdSchema.parse(agentSession(apex.caller)) } })
    assert.ok("refused" in linked && linked.refused === "unsupported", "a stale link cannot override current native origin")
  } finally { await w.close() }
}
async function admission(root: string) {
  const fake = fakeCatalog(), gate = deferred(), entered = deferred(), marked: { pid: number; value: string }[] = []
  const w = new AgentsWorld({ root, script: () => "ok", catalog: fake.catalog, processes: {
    marked: async () => { entered.resolve(); await gate.promise; return marked }, holding: async () => new Set([process.pid]),
    folders: async () => new Map([[process.pid, root]]), startedAt: async () => Date.now(),
  } })
  try {
    const apex = await w.apex("codex", "full"); await w.settle(); marked.push({ pid: process.pid, value: agentSession(apex.caller) })
    const ref = await fixture(root); fake.write(stale(ref), []); await reached(entered.promise)
    fake.write(ref, []); gate.resolve(); await w.agents.runs.discovered()
    assert.equal(w.store.edges().byRun("codex", ref.nativeId), undefined, "metadata arriving during process discovery wins at adoption")
  } finally { gate.resolve(); await w.close() }
}
async function ending(root: string) {
  const fake = fakeCatalog(), gate = deferred(), entered = deferred(), read = fake.catalog.page
  fake.catalog.page = async (...args) => { entered.resolve(); await gate.promise; return read(...args) }
  const w = world(root, fake)
  try {
    const apex = await w.apex("codex", "full"); await w.settle(); const ref = await fixture(root); fake.write(stale(ref), [])
    const adopting = w.agents.runs.adopt({ parentSession: agentSession(apex.caller), ref: stale(ref), origin: "discovered", startedBy: { kind: "agent", session: SessionIdSchema.parse(agentSession(apex.caller)) } })
    await reached(entered.promise); const child = w.store.edges().byRun("codex", ref.nativeId)!.child
    fake.write(ref, []); gate.resolve(); await adopting; await w.settle()
    assert.equal(w.store.edges().of(child), undefined)
    assert.equal(w.store.reportsOf(child, 0).length, 0, "a late unknown end creates no report after classification")
    assert.equal(w.agents.runs.following(), 0)
  } finally { gate.resolve(); await w.close() }
}
async function restart(root: string) {
  let fake = fakeCatalog(), w = world(root, fake)
  const apex = await w.apex("codex", "full"); await w.settle(); const ref = await fixture(root), old = historical(w, apex.caller, ref)
  w.store.keepEdge({ ...old.edge, run: { ...old.edge.run!, nativeAgent: { kind: "unknown", role: "unclassified" } } })
  await w.close()
  const gate = deferred(), entered = deferred(); fake = fakeCatalog(); fake.write(stale(ref), [])
  w = new AgentsWorld({ root, script: () => "ok", budget: { running: 2, started: 1 }, resumeInSlices: true, catalog: { ...fake.catalog, readRef: async () => { entered.resolve(); await gate.promise; return ref } } })
  try {
    await reached(entered.promise); assert.equal(w.prompts.length, 0, "no legacy cut is replayed ahead of native classification")
    gate.resolve(); await w.resumed; await w.settle()
    assert.equal(w.store.edges().of(old.edge.child), undefined)
    assert.equal(w.store.reportsOf(old.edge.child, 0)[0]?.id, old.report, "history is retained, not answered or deleted")
    assert.equal(keptEdge(root, old.edge.child).run?.nativeAgent?.kind, "internal-review")
    assert.deepEqual(keptEdge(root, old.edge.child).run?.ended, old.edge.run?.ended, "no new exit or Stop is invented")
    assert.equal(w.prompts.length, 0, "no guardian decision or synthetic completion reaches the Apex")
    const caller = w.caller(apex.conversation)
    const listed = await w.agents.list(caller, {})
    assert.ok("tree" in listed)
    assert.deepEqual(listed.tree, { running: 0, started: 0, of: { running: 2, started: 1 } }, "an internal review consumes neither running room nor the lifetime start budget")
    const real = await w.agents.start(caller, { name: "real-after-review", clientKey: "real", cwd: root, brief: { objective: "Do actual delegated work" } })
    assert.ok(!("refused" in real), "the internal review did not spend the real Fin's admission")
    assert.equal(real.tree.started, 1)
    const refused = await w.agents.start(caller, { name: "one-too-many", clientKey: "second", cwd: root, brief: { objective: "Do other delegated work" } })
    assert.ok("refused" in refused && refused.refused === "budget", "real delegated work still spends the unchanged lifetime budget")
    await w.settle()
  } finally { gate.resolve(); await w.close() }
  w = world(root)
  try {
    await w.settle()
    assert.equal(w.store.edges().of(old.edge.child), undefined)
    assert.equal(w.prompts.length, 0, "classification survives restart without native metadata")
  } finally { await w.close() }
}
async function realWorkers(root: string) {
  const fake = fakeCatalog(), w = world(root, fake)
  try {
    const apex = await w.apex("codex", "full"); await w.settle()
    const ref = await fixture(root, { thread_source: "future_worker", source: { subagent: { other: "unknown-role" } }, parent_thread_id: guardian.parent_thread_id })
    const result = await w.agents.runs.adopt({ parentSession: agentSession(apex.caller), ref, origin: "discovered", name: "Guardian review", startedBy: { kind: "agent", session: SessionIdSchema.parse(agentSession(apex.caller)) } })
    assert.ok(!("refused" in result)); await w.settle()
    assert.equal(w.store.edges().of(result.child)?.run?.nativeAgent?.kind, "unknown")
    assert.equal(w.store.reportsOf(result.child, 0).at(-1)?.status, "blocked", "a nonspecific role retains genuine unknown-end decisions")
    const worker = await fixture(root, { source: { subagent: { thread_spawn: { parent_thread_id: guardian.parent_thread_id, agent_role: "guardian" } } } })
    assert.equal(worker.nativeAgent?.kind, "agent", "a worker's selected guardian role is not an internal source")
    const fin = await w.agents.start(apex.caller, { name: "real-failure", clientKey: "real-failure", cwd: root, brief: { objective: "Guardian review" } })
    assert.ok(!("refused" in fin)); await w.settle()
    assert.equal(w.store.reportsOf(fin.child!, 0).at(-1)?.status, "failed", "a real managed Fin's failure is reported")
  } finally { await w.close() }
}
async function queued(root: string) {
  for (const mixed of [false, true]) {
    const folder = join(root, String(mixed)); mkdirSync(folder)
    let w = world(folder)
    const apex = await w.apex("codex", "full"); await w.settle()
    const ref = await fixture(folder), old = historical(w, apex.caller, ref)
    const worker = await fixture(folder, { source: { subagent: { other: "unknown-worker" } } })
    const real = mixed ? historical(w, apex.caller, worker, "real-worker") : undefined
    w.agents.resume()
    const before = w.live.snapshot(apex.conversation)!.requests.find((request) => request.digest?.notices.some((notice) => notice.report.id === old.report))
    assert.ok(before && (before.status === "queued" || before.status === "held"), "fixture left an unsent durable guardian digest")
    await w.close()
    const fake = fakeCatalog()
    w = new AgentsWorld({ root: folder, script: () => "ok", resumeInSlices: true, catalog: { ...fake.catalog, readRef: async (path) => path.includes(ref.nativeId) ? ref : worker } })
    try {
      await w.resumed; await w.settle()
      const requests = w.live.snapshot(apex.conversation)!.requests
      assert.ok(!requests.some((request) => request.status !== "canceled" && request.digest?.notices.some((notice) => notice.report.id === old.report)), "the retired guardian notice is canceled, rather than lingering in its Apex's queue")
      assert.ok(w.prompts.every((prompt) => !prompt.text.includes('"guardian-review"')))
      if (real) {
        assert.ok(requests.some((request) => request.status !== "canceled" && request.digest?.notices.some((notice) => notice.report.id === real.report)), "a real worker's sibling notice is preserved")
        assert.ok(w.store.edges().of(real.edge.child), "the real worker remains managed")
      }
    } finally { await w.close() }
  }
}
async function stopping(root: string) {
  const fake = fakeCatalog(), gate = deferred(), entered = deferred()
  const shell = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>console.log('signalled'));console.log('ready');setInterval(()=>{},1000)"], { detached: true, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""; shell.stdout.on("data", (data) => { output += data })
  const ready = deferred(); shell.stdout.once("data", ready.resolve); await reached(ready.promise)
  const w = new AgentsWorld({ root, script: () => "ok", catalog: fake.catalog, processes: {
    marked: async () => [], holding: async () => new Set(), folders: async () => new Map(), startedAt: async () => 1,
    matches: async () => { entered.resolve(); await gate.promise; return true },
  } })
  try {
    const apex = await w.apex("codex", "full"); await w.settle(); const ref = await fixture(root); fake.write(stale(ref), [])
    const linked = await w.agents.runs.adopt({ parentSession: agentSession(apex.caller), ref: stale(ref), origin: "discovered", name: "stale-guardian", process: { pid: shell.pid!, startedAt: 1 }, startedBy: { kind: "agent", session: SessionIdSchema.parse(agentSession(apex.caller)) } })
    assert.ok(!("refused" in linked))
    await w.agents.stop(apex.caller, { child: "stale-guardian" }); await reached(entered.promise)
    fake.write(ref, []); gate.resolve(); await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(w.agents.runs.isTerminating(linked.child), false)
    assert.ok(!output.includes("signalled"), "a late process identity answer cannot signal a reclassified internal reviewer")
    assert.equal(w.store.edges().of(linked.child), undefined)
  } finally {
    gate.resolve(); await w.close()
    const exited = new Promise<void>((resolve) => shell.once("exit", () => resolve()))
    shell.kill("SIGKILL"); await exited
  }
}
/** Drive the real follower's scheduled check at exact boundaries, without private method access or native signals. */
class ManualJobs extends HostJobs {
  private check?: () => void | Promise<void>
  override every(_name: string, _everyMs: number, run: () => void | Promise<void>): () => void {
    this.check = run
    return () => { this.check = undefined }
  }
  async tick(): Promise<void> { assert.ok(this.check); await this.check() }
}
async function successor(root: string, change: "internal" | "relink" | "store" | "none") {
  const w = world(root), fake = fakeCatalog(), jobs = new ManualJobs(), gate = deferred(), entered = deferred()
  const ended: string[] = []
  let clock = Date.now(), parent = ""
  const runs = new AgentRuns({ store: () => w.store, catalog: fake.catalog, jobs, runs: () => true, conversationOwns: () => false, changed: () => {}, ended: (edge) => { ended.push(edge.child) }, now: () => clock, processes: {
    marked: async () => { entered.resolve(); await gate.promise; return [{ pid: 2147483647, value: parent }] },
    holding: async () => new Set([2147483647]), folders: async () => new Map(), startedAt: async () => 2,
  } })
  try {
    const apex = await w.apex("codex", "full"); await w.settle(); parent = agentSession(apex.caller)
    const captured = await fixture(root); clock = Date.now()
    const ref: ThreadRef = { ...stale(captured), childOf: { nativeId: guardian.parent_thread_id }, nativeAgent: { kind: "unknown" }, updatedAt: new Date(clock).toISOString() }
    fake.write(ref, [])
    const input = { parentSession: parent, ref, origin: "discovered" as const, startedBy: { kind: "agent" as const, session: SessionIdSchema.parse(parent) }, process: { pid: 2147483646, startedAt: 1 } }
    const adopted = await runs.adopt(input); assert.ok(!("refused" in adopted))
    await jobs.tick() // Its old process is gone, but the session has not advanced yet.
    clock += 100; fake.write({ ...ref, updatedAt: new Date(clock).toISOString() }, [])
    const checking = jobs.tick(); await reached(entered.promise)
    if (change === "internal") fake.write({ ...captured, childOf: ref.childOf, updatedAt: new Date(clock).toISOString() }, [])
    if (change === "relink") {
      const linked = await runs.adopt({ ...input, origin: "linked", process: { pid: 2147483645, startedAt: 3 } }); assert.ok(!("refused" in linked))
    }
    if (change === "store") {
      const old = w.store.edges().of(adopted.child)!
      w.store.keepEdge({ ...old, run: { ...old.run!, process: { pid: 2147483645, startedAt: 3 } } })
      assert.equal(w.store.keepRun(old, { ...old.run!, process: { pid: 2147483644, startedAt: 4 } }), undefined, "the store rejects an obsolete persisted generation")
    }
    gate.resolve(); await checking
    if (change === "internal") {
      assert.equal(w.store.edges().of(adopted.child), undefined, "a late successor cannot resurrect a reclassified internal reviewer")
      assert.equal(keptEdge(root, adopted.child).run?.nativeAgent?.kind, "internal-review")
      assert.equal(runs.following(), 0)
    } else {
      assert.deepEqual(w.store.edges().of(adopted.child)?.run?.process, change === "relink" || change === "store" ? { pid: 2147483645, startedAt: 3 } : { pid: 2147483647, startedAt: 2 }, "successor lookup must respect the current run generation and preserve genuine handoffs")
      assert.equal(runs.following(), 1)
    }
    assert.deepEqual(ended, [], "no stale end was reported")
  } finally { gate.resolve(); runs.dispose(); jobs.stop(); await w.close() }
}
async function successorInternal(root: string) { await successor(root, "internal") }
async function successorRelink(root: string) { await successor(root, "relink") }
async function successorWorker(root: string) { await successor(root, "none") }
async function successorStore(root: string) { await successor(root, "store") }
async function lateTail(root: string) {
  const fake = fakeCatalog(), w = world(root, fake), gate = deferred(), entered = deferred()
  try {
    const apex = await w.apex("codex", "full"); await w.settle(); const ref = await fixture(root); fake.write(stale(ref), [])
    const adopted = await w.agents.runs.adopt({ parentSession: agentSession(apex.caller), ref: stale(ref), origin: "discovered", process: { pid: process.pid, startedAt: 1 }, startedBy: { kind: "agent", session: SessionIdSchema.parse(agentSession(apex.caller)) } }); assert.ok(!("refused" in adopted))
    await w.settle()
    const read = fake.catalog.page
    fake.catalog.page = async (...args) => { entered.resolve(); await gate.promise; return read(...args) }
    const reading = w.agents.runs.tail(adopted.child, 10); await reached(entered.promise)
    fake.write(ref, [{ type: "text", text: "Internal review content" }]); gate.resolve()
    assert.deepEqual(await reading, [], "a late tail read cannot return a reclassified internal review's content")
  } finally { gate.resolve(); await w.close() }
}
async function rediscovery(root: string) {
  const fake = fakeCatalog(), marked: { pid: number; value: string }[] = [], w = world(root, fake, marked)
  try {
    const apex = await w.apex("codex", "full"); await w.settle(); const ref = await fixture(root), old = historical(w, apex.caller, ref)
    const internal = w.store.keepEdge({ ...old.edge, run: { ...old.edge.run!, nativeAgent: ref.nativeAgent } })
    assert.equal(w.store.edges().of(internal.child), undefined)
    marked.push({ pid: process.pid, value: agentSession(apex.caller) })
    for (const cached of [stale(ref), { ...stale(ref), nativeAgent: { kind: "unknown" as const } }]) {
      fake.write(cached, []); await w.agents.runs.discovered()
      assert.equal(w.store.edges().of(internal.child), undefined, "automatic same-native discovery cannot forget a persisted internal identity")
      const linked = await w.agents.runs.adopt({ parentSession: agentSession(apex.caller), ref: cached, origin: "linked", startedBy: { kind: "agent", session: SessionIdSchema.parse(agentSession(apex.caller)) } })
      assert.ok("refused" in linked && linked.refused === "unsupported")
    }
    const { nativeAgent: _nativeAgent, ...withoutOrigin } = internal.run!
    w.store.keepEdge({ ...internal, run: withoutOrigin })
    assert.equal(keptEdge(root, internal.child).run?.nativeAgent?.kind, "internal-review", "a same-operation stale store write cannot downgrade the known identity")
    marked.length = 0
    const worker = await fixture(root, { source: { subagent: { other: "future-worker" } } }); fake.write(worker, []); await w.agents.runs.discovered()
    const linked = await w.agents.runs.adopt({ parentSession: agentSession(apex.caller), ref: worker, origin: "linked", startedBy: { kind: "agent", session: SessionIdSchema.parse(agentSession(apex.caller)) } })
    assert.ok(!("refused" in linked)); assert.equal(w.store.edges().of(linked.child)?.origin, "linked", "an unknown new native identity remains a supported worker")
  } finally { await w.close() }
}
if (process.argv[2] === "--guardian-crash") {
  const root = process.argv[3]!, cut = process.argv[4]!
  const ref = ThreadRefSchema.parse(JSON.parse(readFileSync(join(root, "native-ref.json"), "utf8"))), fake = fakeCatalog()
  const w = new AgentsWorld({ root, script: () => "ok", resumeInSlices: true, catalog: { ...fake.catalog, readRef: async () => { if (cut === "before") process.kill(process.pid, "SIGKILL"); return ref } } })
  await w.resumed; process.kill(process.pid, "SIGKILL")
} else {
  // The renderer imports this contract. Its complete dependency graph must remain usable without Node builtins.
  await build({ entryPoints: ["packages/host/src/contracts/agents.ts"], bundle: true, platform: "browser", format: "esm", write: false, logLevel: "silent" })
  console.log("internal native agents: renderer contract bundles without Node builtins")
  const root = mkdtempSync(join(tmpdir(), "mako-internal-native-agents-"))
  const selected = process.argv[2] === "--guardian-case" ? process.argv[3] : undefined
  try {
    for (const test of [discovery, admission, ending, restart, realWorkers, queued, stopping, successorInternal, successorRelink, successorWorker, successorStore, lateTail, rediscovery]) {
      if (selected && selected !== test.name) continue
      const folder = join(root, test.name); mkdirSync(folder); await test(folder); console.log(`internal native agents: ${test.name} passed`)
    }
    for (const cut of ["before", "after"]) {
      if (selected && selected !== "crash") continue
      const folder = join(root, `crash-${cut}`); mkdirSync(folder); let w = world(folder)
      const apex = await w.apex("codex", "full"); await w.settle(); const ref = await fixture(folder), old = historical(w, apex.caller, ref)
      writeFileSync(join(folder, "native-ref.json"), JSON.stringify(ref)); await w.close()
      const host = spawn(process.execPath, ["--import", "tsx", import.meta.filename, "--guardian-crash", folder, cut], { stdio: ["ignore", "ignore", "pipe"] })
      let errors = ""; host.stderr.on("data", (data) => { errors += data })
      const signal = await new Promise<NodeJS.Signals | null>((resolve) => host.once("exit", (_code, signal) => resolve(signal))); assert.equal(signal, "SIGKILL", errors)
      const fake = fakeCatalog(); w = new AgentsWorld({ root: folder, script: () => "ok", resumeInSlices: true, catalog: { ...fake.catalog, readRef: async () => cut === "before" ? ref : null } })
      try { await w.resumed; await w.settle(); assert.equal(w.store.edges().of(old.edge.child), undefined); assert.equal(w.prompts.length, 0); assert.equal(keptEdge(folder, old.edge.child).run?.nativeAgent?.kind, "internal-review") } finally { await w.close() }
      console.log(`internal native agents: SIGKILL ${cut} classification passed`)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
}

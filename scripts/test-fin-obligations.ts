import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentsReadResult, AgentsReportResult, AgentsStarted } from "@mako/host/contracts/agent-tools"
import type { AgentRefused } from "@mako/host/contracts/agents"
import { AgentsWorld } from "./lib/agents-world.ts"

/** Report delivery/read receipts never resolve the parent's unanswered decisions. No real model/provider is called. */
const root = mkdtempSync(join(tmpdir(), "mako-fin-obligations-"))
function kept<T extends object>(value: T | AgentRefused): T {
  assert.ok(!("refused" in value), JSON.stringify(value))
  return value
}
const world = new AgentsWorld({ root, script: async (turn) => {
  if (turn.text.endsWith("Hold Apex")) await turn.world.hold(turn.conversation)
  return "ok"
} })
try {
  const apex = await world.apex("codex", "full")
  const fins: AgentsStarted[] = []
  for (const name of ["a", "b", "c"]) fins.push(kept(await world.agents.start(apex.caller, { name, clientKey: name, harness: "claude", brief: { objective: `Work on ${name}` }, cwd: root })))
  await world.settle(100)
  const fin = (index: number) => fins[index]!.conversation!
  const caller = (index: number) => world.caller(fin(index))
  const read = async (index: number, afterAsk?: string) => kept<Exclude<AgentsReadResult, AgentRefused>>(await world.agents.read(apex.caller, { child: fins[index]!.name, ...(afterAsk && { afterAsk }) }))
  const question = async (index: number, key: string, extra = {}) => kept<Exclude<AgentsReportResult, AgentRefused>>(await world.agents.report(caller(index), { clientKey: key, status: "done", summary: `${key} is ready.`, question: `Route ${key} for independent review?`, action: `Dispatch ${key} reviewer.`, options: [{ label: "Review" }, { label: "Park" }], ...extra }))
  const front = () => world.agents.frontDoor(apex.conversation, { actor: { kind: "service", name: "auto-continue" } }).join("\n")
  world.live.submit(apex.conversation, randomUUID(), "Hold Apex", [])
  while (world.live.session(apex.conversation)?.status !== "running") await new Promise((resolve) => setTimeout(resolve, 10))
  const reports = [await question(0, "a-ready"), await question(1, "b-ready"), await question(2, "c-ready")]
  const aSecond = await question(0, "a-second")
  const quiet = kept(await world.agents.report(caller(0), { clientKey: "quiet", status: "progress", summary: "Additional evidence; no new action." }))
  assert.equal(quiet.delivered, "none")
  const queued = world.live.snapshot(apex.conversation)!.requests.filter((request) => request.status === "queued" && request.digest)
  const carried = new Set(queued.flatMap((request) => request.digest!.notices.map((notice) => notice.report.id)))
  assert.ok([...reports, aSecond].every((report) => carried.has(report.id)), "coalescing preserves every identity")
  world.release(apex.conversation)
  await world.settle(100)
  assert.ok(world.prompts.some((turn) => turn.conversation === apex.conversation && reports.every((report) => turn.text.includes(report.id))), "the burst actually reaches the native scripted harness")
  assert.equal(world.store.undeliveredReports().length, 0)
  for (const index of [0, 1, 2]) await read(index)
  assert.deepEqual((await read(0)).pending?.asks.map((ask) => ask.id), [reports[0]!.id, aSecond.id], "quiet progress and repeated reads leave both A obligations open")
  const original = kept(await world.agents.read(apex.caller, { child: "a", report: reports[0]!.id }))
  assert.match(original.text, /a-ready is ready/)
  assert.match(original.text, /Options: Review · Park/, "the exact original question's choices remain inspectable")
  assert.ok("refused" in await world.agents.read(apex.caller, { child: "a", report: "" }), "an empty report selector cannot fall back to latest narration")
  assert.ok("refused" in await world.agents.answer(apex.caller, { to: "b", ask: "", answer: "Review", clientKey: "empty-id" }), "an empty ask cannot answer B's only question")
  const ambiguous = await world.agents.answer(apex.caller, { to: "a", answer: "Review", clientKey: "ambiguous" })
  assert.ok("refused" in ambiguous && ambiguous.why.includes("several"), "a delayed answer must select its own obligation")
  const answer = kept(await world.agents.answer(apex.caller, { to: "b", ask: reports[1]!.id, answer: "Review", clientKey: "answer-b" }))
  assert.equal(answer.ask, reports[1]!.id, "the answer receipt names only B")
  assert.equal(kept(await world.agents.answer(apex.caller, { to: "b", ask: reports[1]!.id, answer: "Review", clientKey: "answer-b" })).deduped, true)
  assert.equal((await read(1)).pending, undefined)
  await world.agents.send(apex.caller, { to: "a", text: "Informational context only.", reply: "none", clientKey: "unrelated-message" })
  await world.settle(100)
  world.live.transfer(apex.conversation, { id: randomUUID(), provider: "claude", text: "Continue coordination after handoff.", attachments: [] })
  await world.settle(100)
  assert.equal(world.live.session(apex.conversation)?.harness, "claude")
  await world.restart()
  assert.deepEqual((await read(0)).pending?.asks.map((ask) => ask.id), [reports[0]!.id, aSecond.id])
  assert.equal((await read(2)).pending?.asks[0]?.id, reports[2]!.id, "A/C survive B's answer and host/harness recreation")
  assert.ok(front().includes(`ask ${reports[0]!.id}`) && front().includes(`ask ${reports[2]!.id}`), "a continuation/compaction-style dispatch rebuilds pending work from the store")
  assert.ok(!front().includes(`ask ${reports[1]!.id}`), "B's resolution cannot settle A/C or reappear as pending")
  const own = kept(await world.agents.respond(apex.conversation, { fin: fins[0]!.child!, ask: aSecond.id, answer: "Park", request: randomUUID() }))
  assert.equal(own.ask, aSecond.id)
  assert.deepEqual((await read(0)).pending?.asks.map((ask) => ask.id), [reports[0]!.id], "one Fin's unrelated second question closes only itself")
  const foreign = await world.agents.report(caller(0), { clientKey: "foreign", status: "progress", summary: "Invalid foreign dismissal.", supersedes: [reports[2]!.id] })
  assert.ok("refused" in foreign)
  const superseded = kept(await world.agents.report(caller(0), { clientKey: "withdraw-a", status: "progress", summary: "A was explicitly withdrawn.", supersedes: [reports[0]!.id] }))
  assert.equal(superseded.delivered, "none", "explicit supersession does not turn progress into a wake")
  assert.deepEqual(superseded.superseded, [reports[0]!.id], "the receipt names the specific withdrawn question")
  assert.equal((await read(0)).pending, undefined)
  assert.equal((await read(2)).pending?.asks[0]?.id, reports[2]!.id)
  const denied = await world.agents.answer(caller(1), { to: fins[2]!.child!, ask: reports[2]!.id, answer: "Review", clientKey: "sibling" })
  assert.ok("refused" in denied, "pending identities grant no sibling access")
  const person = await question(0, "person", { decides: "person" })
  assert.ok("refused" in await world.agents.answer(apex.caller, { to: "a", ask: person.id, answer: "Review", clientKey: "person-denied" }))
  kept(await world.agents.report(caller(0), { clientKey: "person-progress", status: "progress", summary: "Saved context for the person's decision." }))
  assert.equal(world.agents.personAsk(apex.conversation)?.ask.id, person.id, "the person's unanswered question remains reachable after quiet narration")
  kept(await world.agents.respond(apex.conversation, { fin: fins[0]!.child!, ask: person.id, answer: "Park", request: randomUUID() }))
  for (let index = 0; index < 11; index++) await question(0, `overflow-${index}`)
  const first = await read(0)
  assert.equal(first.pending?.asks.length, 8)
  assert.equal(first.pending?.more, 3)
  const last = await read(0, first.pending?.next)
  assert.equal(last.pending?.asks.length, 3)
  assert.equal(new Set([...first.pending!.asks, ...last.pending!.asks].map((ask) => ask.id)).size, 11, "overflow preserves every exact ID through paging")
  kept(await world.agents.answer(apex.caller, { to: "a", ask: first.pending!.next, answer: "Park", clientKey: "resolved-cursor" }))
  assert.equal((await read(0, first.pending?.next)).pending?.asks.length, 3, "a resolved cursor still pages by its durable report position")
  assert.equal(front().split("\n").filter((line) => line.startsWith("fin:")).length, 8)
  assert.ok(front().length < 10_000, "pending prompt context is bounded")
  const list = kept(await world.agents.list(apex.caller, {}))
  assert.ok("children" in list && list.children.find((child) => child.name === "a")?.pendingQuestions === 10)
  await world.restart()
  assert.equal((await read(0)).pending?.more, 2)
  console.log("fin obligations: burst A/B/C, exact resolution, quiet narration, harness/restart, supersession, access and bounded ID paging pass")
} finally {
  await world.close()
  rmSync(root, { recursive: true, force: true })
}

// Reuse the existing escalation owner and first due time; no reminder loop and no retroactive legacy reconstruction.
{
  const dir = mkdtempSync(join(tmpdir(), "mako-obligation-escalation-"))
  let offset = 0
  const timers = new Set<{ ms: number; run: () => void }>()
  const later = (ms: number, run: () => void) => { const timer = { ms, run }; timers.add(timer); return () => { timers.delete(timer) } }
  const next = new AgentsWorld({ root: dir, now: () => Date.now() + offset, apexAnswerMs: 5_000, later, script: () => "ok" })
  try {
    const apex = await next.apex("codex", "full")
    const started = kept(await next.agents.start(apex.caller, { name: "worker", clientKey: "worker", harness: "claude", brief: { objective: "Prepare review" }, cwd: dir }))
    await next.settle(100)
    const report = kept(await next.agents.report(next.caller(started.conversation!), { clientKey: "ready", status: "done", summary: "Review is ready.", question: "Route this review?" }))
    const first = [...timers][0]!
    assert.ok(first.ms > 0 && first.ms <= 5_000)
    offset += 2_000
    kept(await next.agents.report(next.caller(started.conversation!), { clientKey: "quiet", status: "progress", summary: "Saved additional context." }))
    assert.ok(timers.has(first), "quiet narration cannot cancel/restart the original unanswered timer")
    await next.restart()
    assert.equal(timers.size, 1)
    const restored = [...timers][0]!
    assert.ok(restored.ms <= 3_000, "restart preserves elapsed age instead of starting a fresh escalation window")
    offset += 4_000
    timers.delete(restored)
    restored.run()
    const child = next.store.edges().all.find((edge) => edge.name === "worker")!.child
    const questions = next.store.openReportAsks(child)
    assert.equal(questions.length, 1)
    assert.equal(questions[0]!.for, "person")
    assert.deepEqual(questions[0]!.supersedes, [report.id], "the owner handoff explicitly links its old identity")
    assert.equal(next.store.answerOf(report.id), undefined, "escalation is ownership handoff, not an answer")
    assert.equal(timers.size, 0, "person-owned work is not repeatedly re-escalated")
    kept(await next.agents.respond(apex.conversation, { fin: child, ask: questions[0]!.id, answer: "Park", request: randomUUID() }))
    const ask = async (key: string) => kept(await next.agents.report(next.caller(started.conversation!), { clientKey: key, status: "done", summary: key, question: `Decide ${key}?` }))
    const older = await ask("older")
    const newer = await ask("newer")
    kept(await next.agents.answer(apex.caller, { to: "worker", ask: newer.id, answer: "Park", clientKey: "newer" }))
    kept(await next.agents.answer(apex.caller, { to: "worker", ask: older.id, answer: "Park", clientKey: "older" }))
    const state = kept(await next.agents.read(apex.caller, { child: "worker" })).state
    assert.ok(state.kind !== "ended" || state.decision === undefined, "answering an older ask cannot reopen the already-answered latest one")
    assert.equal(timers.size, 0, "no phantom unanswered decision is scheduled from the Fin's last answer map")
    const generation = next.store.latestReports().get(child)!.ownerGeneration
    next.store.keepReport({ id: `report:${child}:legacy-old`, child, status: "done", summary: "Old ambiguous request.", question: "Was this still needed?", ownerGeneration: generation, at: Date.now() })
    next.store.keepReport({ id: `report:${child}:legacy-later`, child, status: "progress", summary: "Legacy follow-up.", ownerGeneration: generation, at: Date.now() })
    assert.deepEqual(next.store.openReportAsks(child), [], "legacy rows do not acquire invented unresolved obligations")
    await next.restart()
    assert.deepEqual(next.store.openReportAsks(child), [])
    const legacy = `report:${child}:legacy-current`
    next.store.keepReport({ id: legacy, child, status: "needs-input", summary: "An older host's current question.", question: "Which option?", ownerGeneration: next.store.latestReports().get(child)!.ownerGeneration, at: Date.now() })
    next.store.markReportsDelivered([legacy], Date.now())
    kept(await next.agents.read(apex.caller, { child: "worker" }))
    kept(await next.agents.send(apex.caller, { to: "worker", text: "Use the first option.", clientKey: "legacy-reply" }))
    await next.settle(100)
    assert.equal(next.store.answerOf(legacy)?.by, "lead", "a delivered agent reply keeps the prior contract for an unmarked legacy question")
    console.log("fin obligations: original escalation due time, explicit owner handoff and legacy rollout boundaries pass")
  } finally { await next.close(); rmSync(dir, { recursive: true, force: true }) }
}

// Exact comparison acceptance: ten delivered/read typed actions, two resolutions, eight original identities remain.
{
  const dir = mkdtempSync(join(tmpdir(), "mako-ten-report-cohort-"))
  const cohort = new AgentsWorld({ root: dir, script: async (turn) => {
    if (turn.text.endsWith("Hold cohort Apex")) await turn.world.hold(turn.conversation)
    return "ok"
  } })
  try {
    const apex = await cohort.apex("codex", "full")
    const workers: AgentsStarted[] = []
    for (const name of ["alpha", "beta", "gamma"]) workers.push(kept(await cohort.agents.start(apex.caller, { name, clientKey: name, harness: "claude", brief: { objective: `Coordinate ${name}` }, cwd: dir })))
    await cohort.settle(100)
    cohort.live.submit(apex.conversation, randomUUID(), "Hold cohort Apex", [])
    while (cohort.live.session(apex.conversation)?.status !== "running") await new Promise((resolve) => setTimeout(resolve, 10))
    const input = (index: number) => ({ clientKey: `action-${index}`, status: "done" as const, summary: `Review ${index} is ready.`, question: `Route review ${index}?`, action: `Dispatch reviewer ${index}.`, artifacts: [{ kind: "commit" as const, ref: (index + 1).toString(16).padStart(40, "0") }] })
    // Nine questions on one Fin cross the eight-question page boundary within this same cohort.
    const workerAt = (index: number) => workers[index < 9 ? 0 : 1]!
    const reports: Array<Exclude<AgentsReportResult, AgentRefused>> = []
    for (let index = 0; index < 10; index++) reports.push(kept(await cohort.agents.report(cohort.caller(workerAt(index).conversation!), input(index))))
    const carriers = cohort.live.snapshot(apex.conversation)!.requests.filter((request) => request.status === "queued" && request.digest)
    const carried = new Set(carriers.flatMap((request) => request.digest!.notices.map((notice) => notice.report.id)))
    assert.ok(reports.every((report) => carried.has(report.id)))
    cohort.release(apex.conversation)
    await cohort.settle(100)
    assert.ok(cohort.prompts.some((turn) => turn.conversation === apex.conversation && reports.every((report) => turn.text.includes(report.id))), "all ten reports reached native scripted input")
    assert.equal(cohort.store.undeliveredReports().length, 0)
    const readIds: string[] = []
    for (const worker of workers) {
      let afterAsk: string | undefined
      do {
        const read = kept(await cohort.agents.read(apex.caller, { child: worker.name, ...(afterAsk && { afterAsk }) }))
        readIds.push(...(read.pending?.asks.map((ask) => ask.id) ?? []))
        afterAsk = read.pending?.next
      } while (afterAsk)
    }
    assert.deepEqual(readIds.sort(), reports.map((report) => report.id).sort(), "paging reads each of the ten questions exactly once")
    const answer = { to: workerAt(1).name, ask: reports[1]!.id, answer: "Route this exact review.", clientKey: "resolve-one" }
    assert.equal(kept(await cohort.agents.answer(apex.caller, answer)).ask, reports[1]!.id)
    const person = { fin: workerAt(8).child!, ask: reports[8]!.id, answer: "Park this exact review.", request: randomUUID() }
    assert.equal(kept(await cohort.agents.respond(apex.conversation, person)).ask, reports[8]!.id)
    kept(await cohort.agents.report(cohort.caller(workers[0]!.conversation!), { clientKey: "quiet-after-ten", status: "progress", summary: "More evidence saved; no new action." }))
    await cohort.settle(100)
    cohort.live.transfer(apex.conversation, { id: randomUUID(), provider: "claude", text: "Resume after cohort handoff.", attachments: [] })
    await cohort.settle(100)
    await cohort.restart()
    const expected = reports.filter((_report, index) => index !== 1 && index !== 8).map((report) => report.id).sort()
    const pending = workers.flatMap((worker) => cohort.store.openReportAsks(worker.child!))
    assert.equal(pending.length, 8)
    assert.deepEqual(pending.map((report) => report.id).sort(), expected, "restart preserves the eight unresolved original IDs exactly once")
    const targets = new Map(reports.map((report, index) => [report.id, input(index).artifacts[0]!.ref]))
    assert.ok(pending.every((report) => report.retainsQuestion && report.artifacts?.[0]?.ref === targets.get(report.id)), "exact target-version references survive with the original obligation")
    const original = kept(await cohort.agents.read(apex.caller, { child: workers[0]!.name, report: reports[0]!.id }))
    assert.ok(original.text.includes(targets.get(reports[0]!.id)!), "an exact report read exposes its original target reference")
    const autonomous = cohort.agents.frontDoor(apex.conversation, { actor: { kind: "service", name: "auto-continue" } }).filter((line) => line.startsWith("fin:"))
    assert.equal(autonomous.length, 8)
    assert.ok(expected.every((id) => autonomous.some((line) => line.includes(`ask ${id}`))), "autonomous context is rebuilt from all remaining IDs")
    const before = cohort.prompts.filter((turn) => turn.conversation === apex.conversation).length
    assert.equal(kept(await cohort.agents.answer(apex.caller, answer)).deduped, true)
    assert.equal(kept(await cohort.agents.respond(apex.conversation, person)).deduped, true)
    assert.equal(kept(await cohort.agents.report(cohort.caller(workers[0]!.conversation!), input(0))).deduped, true)
    assert.equal(kept(await cohort.agents.report(cohort.caller(workers[0]!.conversation!), { ...input(0), artifacts: [{ kind: "commit", ref: "f".repeat(40) }] })).deduped, true)
    assert.equal(cohort.store.reportsOf(workers[0]!.child!).find((report) => report.id === reports[0]!.id)?.artifacts?.[0]?.ref, targets.get(reports[0]!.id), "replaying the same report ID cannot replace its original target")
    kept(await cohort.agents.send(apex.caller, { to: workers[0]!.name, text: "Informational context.", reply: "none", clientKey: "information-only" }))
    for (const worker of workers) kept(await cohort.agents.read(apex.caller, { child: worker.name }))
    await cohort.settle(100)
    assert.equal(cohort.prompts.filter((turn) => turn.conversation === apex.conversation).length, before, "duplicate reports/resolutions and reads do not form a wake loop")
    assert.deepEqual(workers.flatMap((worker) => cohort.store.openReportAsks(worker.child!)).map((report) => report.id).sort(), expected)
    console.log("fin obligations: ten delivered/read reports, two exact resolutions, eight original IDs after quiet narration/handoff/restart; duplicate receipts stay quiet")
  } finally { await cohort.close(); rmSync(dir, { recursive: true, force: true }) }
}

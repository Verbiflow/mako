import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentRefused } from "@mako/host/contracts/agents"
import type { AgentsSettleInput, AgentsStarted, AgentsReportResult } from "@mako/host/contracts/agent-tools"
import { AgentsWorld } from "./lib/agents-world.ts"

const root = mkdtempSync(join(tmpdir(), "mako-report-actions-"))
function kept<T extends object>(value: T | AgentRefused): T {
  assert.ok(!("refused" in value), JSON.stringify(value))
  return value
}
const world = new AgentsWorld({ root, script: async turn => {
  if (turn.text.endsWith("Hold Apex")) await turn.world.hold(turn.conversation)
  return "ok"
} })
try {
  const apex = await world.apex("codex", "full")
  const fins: AgentsStarted[] = []
  for (const name of ["a", "b", "c"]) fins.push(kept(await world.agents.start(apex.caller, { name, clientKey: name, brief: { objective: `Work on ${name}` }, harness: "claude", cwd: root })))
  await world.settle(100)
  const caller = (i: number) => world.caller(fins[i]!.conversation!)
  const target = (i: number) => ({ ref: `fixture:review/${i}`, version: `head-${i}` })
  const rawReport = (i: number, key: string, extra = {}) => world.agents.report(caller(i % 3), { clientKey: key, status: "done", summary: `${key} ready.`, action: `Dispatch review for ${key}.`, followUp: target(i), ...extra })
  const report = async (i: number, key: string, extra = {}) => kept(await rawReport(i, key, extra))
  const read = async (i: number, afterAction?: string) => kept(await world.agents.read(apex.caller, { child: fins[i]!.name, ...(afterAction && { afterAction }) }))
  const all = async () => (await Promise.all([0, 1, 2].map(i => read(i)))).flatMap(r => r.actions?.items ?? [])
  const front = () => world.agents.frontDoor(apex.conversation, { actor: { kind: "service", name: "auto-continue" } }).join("\n")
  world.live.submit(apex.conversation, randomUUID(), "Hold Apex", [])
  while (world.live.session(apex.conversation)?.status !== "running") await new Promise(resolve => setTimeout(resolve, 10))
  const reports: Exclude<AgentsReportResult, AgentRefused>[] = []
  for (let i = 0; i < 10; i++) reports.push(await report(i, `result-${i}`))
  world.release(apex.conversation)
  await world.settle(100)
  assert.equal(world.store.undeliveredReports().length, 0, "actual delivery completed")
  for (const i of [0, 1, 2]) await read(i)
  assert.equal((await all()).length, 10, "delivered/read action-only results still need dispositions")
  assert.ok(world.prompts.some(p => p.conversation === apex.conversation && reports.every(r => p.text.includes(r.id))), "coalesced identities actually reached scripted native input")
  const resolve = (i: number, input: Partial<AgentsSettleInput> = {}) => world.agents.settle(apex.caller, { to: fins[i % 3]!.name, report: reports[i]!.id, version: 1, target: target(i), disposition: { kind: "dismiss", reason: "Explicitly no further work." }, clientKey: `resolve-${i}`, ...input })
  const b = kept(await resolve(1))
  assert.equal(b.action.report, reports[1]!.id)
  const inspected = kept(await world.agents.read(apex.caller, { child: "b", report: reports[1]!.id }))
  assert.equal(inspected.followUp?.disposition.kind, "dismiss")
  assert.equal(inspected.followUp?.version, 2, "exact report inspection retains terminal receipt without reintroducing pending work")
  assert.equal(kept(await resolve(1)).deduped, true)
  const sent = kept(await world.agents.send(apex.caller, { to: "b", text: "Review the exact fixture targets4 and5.", reply: "none", clientKey: "actual-dispatch" }))
  kept(await resolve(4))
  kept(await world.agents.report(caller(0), { clientKey: "quiet-a", status: "progress", summary: "Additional A evidence; no new action." }))
  assert.equal((await all()).length, 8, "resolving two leaves eight, not one per Fin")
  const expected = reports.filter((_, i) => i !== 1 && i !== 4).map(r => r.id).sort()
  world.live.transfer(apex.conversation, { id: randomUUID(), provider: "claude", text: "Continue after compacted context.", attachments: [] })
  await world.settle(100)
  await world.restart()
  assert.deepEqual((await all()).map(a => a.report).sort(), expected, "quiet A, harness continuation and host recreation retain exact pending IDs")
  world.live.submit(apex.conversation, randomUUID(), "Reconcile after restart without old prompt context.", [], undefined, undefined, undefined, { kind: "service", name: "auto-continue" })
  await world.settle(100)
  const resumed = world.prompts.filter(p => p.conversation === apex.conversation).at(-1)!.text
  for (const id of expected) assert.ok(resumed.includes(`action ${JSON.stringify(id)}`), "real autonomous dispatch after restart carries every pending action")
  for (const id of expected) assert.ok(front().includes(id), "autonomous dispatch rebuilds pending work independently of old prose")
  assert.ok(!front().includes(`action ${JSON.stringify(reports[1]!.id)}`), "B is not reintroduced")
  assert.ok("refused" in await resolve(0, { target: target(2), clientKey: "wrong-target" }))
  assert.ok("refused" in await resolve(0, { version: 2, clientKey: "stale-version" }))
  assert.ok("refused" in await resolve(0, { to: "b", clientKey: "wrong-fin" }))
  assert.ok("refused" in await world.agents.read(apex.caller, { child: "a", afterAction: "" }))
  assert.ok("refused" in await world.agents.read(apex.caller, { child: "a", afterAction: reports[2]!.id }))
  assert.ok("refused" in await world.agents.settle(caller(1), { to: "a", report: reports[0]!.id, version: 1, target: target(0), disposition: { kind: "dismiss", reason: "Sibling cannot decide." }, clientKey: "sibling" }))
  assert.ok("refused" in await resolve(0, { disposition: { kind: "dispatch", to: "b", request: randomUUID() }, clientKey: "invented-evidence" }))
  assert.equal(kept(await resolve(1)).deduped, true, "same operation remains idempotent after restart")
  assert.equal(kept(await resolve(4)).deduped, true, "exact terminal receipt is durable across harness/host recreation")
  assert.ok("refused" in await resolve(0, { clientKey: "resolve-1" }), "an operation key cannot settle another action")
  const deferred = kept(await resolve(0, { disposition: { kind: "defer", reason: "Target awaiting evidence.", resume: "A verified new target result." }, clientKey: "defer-a" }))
  assert.equal(deferred.action.version, 2)
  assert.equal((await all()).length, 8, "defer retains pending ownership")
  assert.ok("refused" in await resolve(0, { clientKey: "old-after-defer" }))
  const replacement = await report(0, "replacement-a", { followUp: { ...target(0), version: "head-new" } })
  kept(await resolve(0, { version: 2, disposition: { kind: "supersede", report: replacement.id, reason: "Exact newer target replaces this one." }, clientKey: "supersede-a" }))
  assert.ok((await all()).some(a => a.report === replacement.id))
  assert.ok(!(await all()).some(a => a.report === reports[0]!.id))
  const handed = kept(await resolve(5, { disposition: { kind: "handoff", to: "b", request: sent.request }, clientKey: "handoff-c" }))
  assert.equal(handed.action.owner, fins[1]!.child, "accepted handoff names the next owner, not work completion")
  const beforeAnswers = (await all()).map(a => a.report).sort()
  const question = kept(await world.agents.report(caller(1), { clientKey: "person-question", status: "done", summary: "Person decides this distinct question.", question: "Choose this separate option?", decides: "person" }))
  kept(await world.agents.respond(apex.conversation, { fin: fins[1]!.child!, ask: question.id, answer: "Park", request: randomUUID() }))
  assert.deepEqual((await all()).map(a => a.report).sort(), beforeAnswers, "direct person answer settles only its ask, never ordinary actions from the same Fin")
  const ordinary = kept(await world.agents.report(caller(1), { clientKey: "ordinary", status: "done", summary: "Informational completion with no action." }))
  assert.equal(ordinary.followUp, undefined)
  assert.deepEqual((await all()).map(a => a.report).sort(), beforeAnswers)
  assert.ok("refused" in await rawReport(0, "quiet-action", { status: "progress" }), "progress cannot silently create obligations")
  assert.ok("refused" in await rawReport(0, "mixed-ask", { question: "Existing asks use their own answer contract." }))
  assert.ok("refused" in await rawReport(0, "person-action", { decides: "person" }), "person-owned decisions use the existing ask/escalation path")
  assert.ok("refused" in await rawReport(0, "blocked-action", { status: "blocked" }), "blocked work uses the existing ask/wait path, not a second pending action")
  const original = kept(await report(3, "result-3", { followUp: target(99) }))
  assert.equal(original.deduped, true)
  assert.deepEqual(original.followUp?.target, target(3), "a duplicate report never changes its original target")
  for (let i = 0; i < 10; i++) await report(0, `overflow-${i}`)
  const first = (await read(0)).actions!
  assert.equal(first.items.length, 8)
  assert.ok(first.next)
  const cursor = first.next!
  const named = first.items.at(-1)!
  kept(await world.agents.settle(apex.caller, { to: "a", report: named.report, version: named.version, target: named.target, disposition: { kind: "dismiss", reason: "Only this overflow item." }, clientKey: "cursor-resolved" }))
  const second = (await read(0, cursor)).actions!
  assert.equal(second.items.length, first.total - 8, "resolved cursor retains durable page position")
  assert.ok(front().length < 14_000, "autonomous output is bounded with a recoverable next page")
  await world.settle(100)
  const promptCount = world.prompts.length
  await read(0)
  kept(await resolve(1))
  await world.settle(100)
  assert.equal(world.prompts.length, promptCount, "reading/dispositions create no thank-you, reminder or review loop")
  const rollback = (await read(2)).actions!.items[0]!
  const db = new DatabaseSync(world.store.path)
  db.exec("CREATE TRIGGER fail_report_action_receipt BEFORE INSERT ON agent_report_action_ops BEGIN SELECT RAISE(ABORT, 'fixture interrupted receipt'); END")
  const failed = await world.agents.settle(apex.caller, { to: "c", report: rollback.report, version: rollback.version, target: rollback.target,
    disposition: { kind: "dismiss", reason: "Transactional failure control." }, clientKey: "atomic-resolution" })
  assert.ok("refused" in failed)
  db.exec("DROP TRIGGER fail_report_action_receipt")
  db.close()
  assert.deepEqual(world.store.reportAction(rollback.report), rollback, "receipt failure rolls back action state, version and ownership")
  await world.restart()
  kept(await world.agents.settle(apex.caller, { to: "c", report: rollback.report, version: rollback.version, target: rollback.target,
    disposition: { kind: "dismiss", reason: "Transactional failure control." }, clientKey: "atomic-resolution" }))
  await report(0, "new-owner-generation")
  const newest = world.store.reportsOf(fins[0]!.child!).at(-1)!
  assert.ok(newest.ownerGeneration > 1)
  const stale = world.store.keepReport({ ...newest, id: "stale-owner-action", ownerGeneration: newest.ownerGeneration - 1 })
  assert.ok("stale" in stale)
  assert.equal(world.store.reportAction("stale-owner-action"), undefined)
  const registration = new DatabaseSync(world.store.path)
  registration.exec("CREATE TRIGGER fail_report_action_registration BEFORE INSERT ON agent_report_actions BEGIN SELECT RAISE(ABORT, 'fixture interrupted registration'); END")
  assert.ok("refused" in await rawReport(0, "atomic-registration"))
  const failedId = `report:${fins[0]!.child}:atomic-registration`
  assert.ok(!world.store.reportsOf(fins[0]!.child!).some(r => r.id === failedId), "report and actionable registration commit together")
  assert.equal(world.store.reportAction(failedId), undefined)
  registration.exec("DROP TRIGGER fail_report_action_registration")
  registration.close()
  const registered = await report(0, "atomic-registration")
  assert.equal(registered.followUp?.version, 1)
  const legacy = kept(await world.agents.report(caller(0), { clientKey: "legacy-action-words", status: "done", summary: "Legacy action words remain context.", action: "No typed follow-up was requested." }))
  assert.equal(legacy.followUp, undefined, "existing action prose without explicit target is not reclassified")
  const archivedAction = (await read(2)).actions!.items[0]!
  world.archived.add(fins[2]!.conversation!)
  assert.ok((await read(2)).actions?.items.some(action => action.report === archivedAction.report))
  kept(await world.agents.settle(apex.caller, { to: "c", report: archivedAction.report, version: archivedAction.version, target: archivedAction.target,
    disposition: { kind: "dismiss", reason: "Silent recovery after source archival." }, clientKey: "archived-disposition" }))
  world.archived.delete(fins[2]!.conversation!)
  const stopped = (await read(0)).actions!.items[0]!
  kept(await world.agents.stop(apex.caller, { child: "a", reason: "Stop control." }))
  kept(await world.agents.settle(apex.caller, { to: "a", report: stopped.report, version: stopped.version, target: stopped.target,
    disposition: { kind: "dismiss", reason: "Silent recovery never resumes stopped native work." }, clientKey: "after-stop" }))
  assert.ok(!(await read(0)).actions?.items.some(action => action.report === stopped.report))
  console.log("report actions: delivery/read A/B/C, ten→eight, quiet update, harness/restart, exact target/version/owner/receipt, person ask, deferred/superseded state and bounded paging PASS")
} finally {
  await world.close()
  rmSync(root, { recursive: true, force: true })
}

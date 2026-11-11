import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentRefused } from "@mako/host/contracts/agents"
import * as ReportActionContract from "@mako/host/contracts/report-actions"
import { AgentsWorld } from "./lib/agents-world.ts"

const root = mkdtempSync(join(tmpdir(), "mako-report-custody-"))
const kept = <T extends object>(value: T | AgentRefused): T => { assert.ok(!("refused" in value), JSON.stringify(value)); return value }
const until = async (predicate: () => boolean) => {
  const end = Date.now() + 10_000
  while (!predicate()) { assert.ok(Date.now() < end, "scripted state timeout"); await new Promise(resolve => setTimeout(resolve, 10)) }
}
const target = { ref: "fixture:private-pr/review", version: "exact-sha-1" }
const world = new AgentsWorld({ root, script: async turn => {
  if (turn.text.includes("FAIL_RECEIVER_REQUEST")) {
    await turn.world.hold(turn.conversation)
    turn.world.endWith(turn.conversation, { fail: "scripted receiver failed before review completion" })
  }
  return "ok"
} })
try {
  const apex = await world.apex("codex", "full")
  const source = kept(await world.agents.start(apex.caller, { name: "source", clientKey: "source", brief: { objective: "Produce reviewable results." }, harness: "claude", cwd: root }))
  const receiver = kept(await world.agents.start(apex.caller, { name: "receiver", clientKey: "receiver", brief: { objective: "Review exact targets." }, harness: "claude", cwd: root }))
  const stranger = kept(await world.agents.start(apex.caller, { name: "stranger", clientKey: "stranger", brief: { objective: "Unrelated work." }, harness: "claude", cwd: root }))
  await world.settle(100)
  const read = async () => kept(await world.agents.read(apex.caller, { child: "source" }))
  const actions = async () => (await read()).actions!.items
  const front = (conversation: string) => world.agents.frontDoor(conversation, { actor: { kind: "service", name: "auto-continue" } }).join("\n")
  const sourceCaller = () => world.caller(source.conversation!)
  const A = kept(await world.agents.report(sourceCaller(), { status: "done", summary: "Review needed.", action: "Review the exact fixture PR and return a verdict.", followUp: target, clientKey: "A" }))
  const B = kept(await world.agents.report(sourceCaller(), { status: "done", summary: "Independent sibling action.", action: "Inspect the other target.", followUp: { ...target, version: "other-sha" }, clientKey: "B" }))
  const settle = (version: number, disposition: Parameters<typeof world.agents.settle>[1]["disposition"], clientKey: string) => world.agents.settle(apex.caller, { to: "source", report: A.id, version, target, disposition, clientKey })
  for (const kind of ["dispatch", "handoff"] as const) {
    const before = world.store.reportAction(A.id)!
    const sent = kept(await world.agents.send(apex.caller, { to: "receiver", clientKey: `send-${kind}`, reply: "none", text: `FAIL_RECEIVER_REQUEST ${kind}: review report ${A.id}, exact target ${JSON.stringify(target)}; return a verdict.` }))
    const request = () => world.live.snapshot(receiver.conversation!)!.requests.find(item => item.id === sent.request)!
    await until(() => world.prompts.some(p => p.conversation === receiver.conversation && p.text.includes(`FAIL_RECEIVER_REQUEST ${kind}:`)))
    const transfer = { kind, to: "receiver", request: sent.request }
    const changed = kept(await settle(before.version, transfer, `custody-${kind}`))
    assert.equal(changed.action.owner, receiver.child)
    assert.ok((await actions()).some(a => a.report === A.id), "accepted dispatch/handoff retains original pending work")
    world.release(receiver.conversation!)
    await until(() => request().status === "failed")
    await world.settle(100)
    assert.deepEqual((await actions()).map(a => a.report).sort(), [A.id, B.id].sort(), "failure creates no replacement or sibling resolution")
    assert.ok(front(apex.conversation).includes(`action ${JSON.stringify(A.id)}`))
    assert.ok(front(receiver.conversation!).includes(`action ${JSON.stringify(A.id)}`), "custodian without children receives dynamic action facts")
    assert.match(front(apex.conversation), /request failed/)
    const custody = kept(await world.agents.read(world.caller(receiver.conversation!), { child: receiver.child!, view: "actions" }))
    assert.equal(custody.actions?.items[0]?.report, A.id)
    assert.ok("refused" in await world.agents.read(world.caller(stranger.conversation!), { child: receiver.child!, view: "actions" }), "custody view grants no sibling access")
    await world.restart()
    assert.ok(front(apex.conversation).includes(`action ${JSON.stringify(A.id)}`))
    assert.ok(front(receiver.conversation!).includes(`action ${JSON.stringify(A.id)}`))
    assert.ok("refused" in await world.agents.settle(world.caller(receiver.conversation!), { to: source.child!, report: A.id, version: changed.action.version, target, disposition: { kind: "dismiss", reason: "Custodian cannot decide for source Apex." }, clientKey: "wrong-custodian-authority" }))
    assert.equal(kept(await settle(before.version, transfer, `custody-${kind}`)).deduped, true)
    assert.equal((await actions()).length, 2)
    const deferred = kept(await settle(changed.action.version, { kind: "defer", reason: "Receiver failed; decision remains owed.", resume: "Verified review result." }, `defer-${kind}`))
    assert.equal(deferred.action.owner, receiver.child)
    assert.equal(deferred.action.custody?.request, sent.request)
    assert.ok("refused" in await settle(before.version, transfer, `stale-${kind}`))
    kept(await settle(deferred.action.version, { kind: "reclaim", reason: "Apex will decide the retry." }, `reclaim-${kind}`))
    assert.equal(world.store.reportAction(A.id)!.owner, world.store.journalPlacement(apex.conversation)!.thread)
    assert.equal(kept(await world.agents.read(world.caller(receiver.conversation!), { child: receiver.child!, view: "actions" })).actions?.total, 0)
  }
  const sent = kept(await world.agents.send(apex.caller, { to: "receiver", text: `Successful review request for ${A.id} ${JSON.stringify(target)}`, reply: "none", clientKey: "success" }))
  const current = world.store.reportAction(A.id)!
  const interrupted = new DatabaseSync(world.store.path)
  interrupted.exec("CREATE TRIGGER abort_custody_receipt BEFORE INSERT ON agent_report_action_ops BEGIN SELECT RAISE(ABORT, 'fixture interrupted custody'); END")
  assert.ok("refused" in await settle(current.version, { kind: "dispatch", to: "receiver", request: sent.request }, "success-custody"))
  assert.deepEqual(world.store.reportAction(A.id), current, "receipt failure rolls back owner, custody, pending state and version together")
  interrupted.exec("DROP TRIGGER abort_custody_receipt")
  interrupted.close()
  kept(await settle(current.version, { kind: "dispatch", to: "receiver", request: sent.request }, "success-custody"))
  await world.settle(100)
  const verdict = kept(await world.agents.report(world.caller(receiver.conversation!), { status: "done", summary: "Review passed for the exact target.", clientKey: "successful-review" }))
  assert.equal((await actions()).length, 2, "receiver success/report delivery does not silently resolve source obligation")
  const overflow = []
  for (let i = 0; i < 9; i++) overflow.push(kept(await world.agents.report(sourceCaller(), { status: "done", summary: `Independent delegated result ${i}.`, action: "Inspect the exact target.", followUp: { ref: `fixture:overflow/${i}`, version: `sha-${i}` }, clientKey: `overflow-${i}` })))
  const grouped = kept(await world.agents.send(apex.caller, { to: "receiver", text: `Inspect these exact source reports/targets: ${JSON.stringify(overflow.map(item => item.followUp))}`, reply: "none", clientKey: "overflow-request" }))
  for (const item of overflow) kept(await world.agents.settle(apex.caller, { to: "source", report: item.id, version: 1, target: item.followUp!.target, disposition: { kind: "dispatch", to: "receiver", request: grouped.request }, clientKey: `delegate-${item.id}` }))
  const page = kept(await world.agents.read(world.caller(receiver.conversation!), { child: receiver.child!, view: "actions" })).actions!
  assert.equal(page.items.length, 8)
  assert.equal(page.total, 10)
  const tail = kept(await world.agents.read(world.caller(receiver.conversation!), { child: receiver.child!, view: "actions", afterAction: page.next })).actions!
  assert.equal(tail.items.length, 2)
  assert.equal(new Set([...page.items, ...tail.items].map(item => item.report)).size, 10)
  for (const item of overflow) kept(await world.agents.settle(apex.caller, { to: "source", report: item.id, version: 2, target: item.followUp!.target, disposition: { kind: "dismiss", reason: "Explicit exact overflow disposition." }, clientKey: `resolve-${item.id}` }))
  assert.ok("refused" in await world.agents.read(world.caller(receiver.conversation!), { child: receiver.child!, view: "actions", afterAction: B.id }), "receiver cursor cannot read unassigned source work")
  world.archived.add(receiver.conversation!)
  assert.equal((await actions()).length, 2)
  assert.match(front(apex.conversation), /custodian archived/)
  world.archived.delete(receiver.conversation!)
  kept(await world.agents.stop(apex.caller, { child: "receiver", reason: "Stop recipient fixture." }))
  assert.equal((await actions()).length, 2)
  assert.match(front(apex.conversation), /custodian stopped/)
  world.archived.add(source.conversation!)
  kept(await world.agents.stop(apex.caller, { child: "source", reason: "Stop source fixture; retain silent action recovery." }))
  await world.restart()
  assert.equal((await actions()).length, 2, "source and recipient lifecycle do not erase explicit obligations")
  const terminal = kept(await settle(world.store.reportAction(A.id)!.version, { kind: "resolve", evidence: verdict.id }, "finally-resolve"))
  assert.deepEqual((await actions()).map(a => a.report), [B.id])
  assert.ok(world.store.edges().of(source.child!)!.closedAt !== undefined, "silent resolution cannot resume stopped source native work")
  assert.ok(world.store.edges().of(receiver.child!)!.closedAt !== undefined, "silent resolution cannot resume stopped custodian native work")
  assert.ok("refused" in await settle(terminal.action.version, { kind: "reclaim", reason: "Cannot reopen resolved work." }, "cannot-reopen"))
  const stale = world.store.reportAction(A.id)!
  assert.equal(kept(await settle(current.version, { kind: "dispatch", to: "receiver", request: sent.request }, "success-custody")).deduped, true)
  assert.deepEqual(world.store.reportAction(A.id), stale, "stale duplicate receipt never reopens or redispatches newer terminal generation")
  assert.equal(world.live.snapshot(receiver.conversation!)!.requests.filter(r => r.id === sent.request).length, 1)
  console.log("report custody: dispatch/handoff failure, success, receiver/source Stop/archive, custody views, reclaim, exact terminal disposition and restart PASS")
} finally { await world.close(); rmSync(root, { recursive: true, force: true }) }

// The injected caller adopts actual shared instructions carried by its real first-turn brief.
const instructedRoot = mkdtempSync(join(tmpdir(), "mako-instructed-action-"))
const instructed = new AgentsWorld({ root: instructedRoot, script: async turn => {
  if (turn.text.includes("Emit the exact instructed result.")) {
    assert.ok(turn.text.includes(ReportActionContract.REPORT_FOLLOW_UP_INSTRUCTIONS), "common reporting directive reaches the actual Fin prompt")
    kept(await turn.world.agents.report(turn.caller, { status: "done", summary: "Instruction-driven action-only fixture.", action: "Review the exact target.", followUp: target, clientKey: "instruction-adopted" }))
  }
  return "ok"
} })
try {
  const apex = await instructed.apex("codex", "full")
  const fin = kept(await instructed.agents.start(apex.caller, { name: "instructed", clientKey: "instructed", brief: { objective: "Emit the exact instructed result." }, harness: "claude", cwd: instructedRoot }))
  await instructed.settle(100)
  assert.equal(kept(await instructed.agents.read(apex.caller, { child: fin.child! })).actions?.total, 1)
  console.log("report adoption: common brief reaches actual caller; explicit stable-target completion is retained PASS (scripted, no model adoption claim)")
} finally { await instructed.close(); rmSync(instructedRoot, { recursive: true, force: true }) }

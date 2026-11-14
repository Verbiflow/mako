import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FRONT_DOOR_GUIDANCE } from "@mako/host/contracts/agent-tools"
import type { AgentRefused } from "@mako/host/contracts/agents"
import { CONTEXT_COMPACTED } from "@mako/host/contracts/native-activity"
import { codexInput } from "@mako/host/harnesses/codex/input"
import { AgentsWorld } from "./lib/agents-world.ts"

/** Joint real dispatch path: only static routing guidance has cadence; obligations always come from current state. */
const root = mkdtempSync(join(tmpdir(), "mako-action-cadence-"))
const kept = <T extends object>(value: T | AgentRefused): T => { assert.ok(!("refused" in value), JSON.stringify(value)); return value }
const until = async (predicate: () => boolean) => {
  const end = Date.now() + 10_000
  while (!predicate()) { assert.ok(Date.now() < end, "scripted dispatch timeout"); await new Promise(resolve => setTimeout(resolve, 10)) }
}
let rule = "Keep the original rule and every owed action."
const world = new AgentsWorld({ root, policy: () => ({ rules: [], forApexes: rule }), script: async turn => {
  if (turn.text.includes("JOINT_FAIL_REVIEW")) {
    await turn.world.hold(turn.conversation)
    turn.world.endWith(turn.conversation, { fail: "Exact review failed; outcome still owed." })
  }
  for (const label of ["JOINT no-child receiver", "JOINT receiver after restart"]) if (turn.text.endsWith(label))
    kept(await turn.world.agents.report(turn.caller, { status: "progress", summary: "Custody still awaits the source Apex decision.", clientKey: label }))
  return "ok"
} })
let captured = false
const trace: { role: string; kind: string; label: string; text: string; bytes: number; encodedCodexInput?: ReturnType<typeof codexInput> }[] = []
try {
  const apex = await world.apex("codex", "full")
  const source = kept(await world.agents.start(apex.caller, { name: "source", clientKey: "source", harness: "claude", cwd: root, brief: { objective: "Produce the exact action-only fixture." } }))
  const receiver = kept(await world.agents.start(apex.caller, { name: "receiver", clientKey: "receiver", harness: "claude", cwd: root, brief: { objective: "Review the exact source target." } }))
  await world.settle(40)
  const parent = world.store.journalPlacement(apex.conversation)!.thread
  const target = { ref: "fixture:joint-review", version: "sha-joint-1" }
  const action = kept(await world.agents.report(world.caller(source.conversation!), { status: "done", summary: "Exact artifact needs review.", action: "Return a verdict on the exact target.", followUp: target, clientKey: "action" }))
  const question = kept(await world.agents.report(world.caller(source.conversation!), { status: "done", summary: "Independent decision.", question: "Original separate question?", clientKey: "question" }))
  await world.settle(40)
  const emit = async (conversation: string, kind: "person" | "service", label: string, guidance: boolean) => {
    if (kind === "person") world.say(conversation, label)
    else world.live.submit(conversation, randomUUID(), label, [], undefined, undefined, undefined, { kind: "service", name: "auto-continue" })
    await world.settle(40)
    const prompt = world.prompts.filter(p => p.conversation === conversation && p.text.endsWith(label)).at(-1)
    assert.ok(prompt, `actual driver input missing: ${label}`)
    for (const line of FRONT_DOOR_GUIDANCE) assert.equal(prompt.text.split(line).length - 1, Number(guidance), `${label}: exact fixed guidance follows cadence`)
    assert.equal(prompt.text.split(`action ${JSON.stringify(action.id)}`).length - 1, 1, `${label}: pending action identity is rebuilt exactly once`)
    assert.ok(prompt.text.includes(target.ref) && prompt.text.includes(target.version))
    trace.push({ role: conversation === apex.conversation ? "apex" : "custodian", kind, label, text: prompt.text, bytes: Buffer.byteLength(prompt.text), ...(prompt.harness === "codex" && { encodedCodexInput: codexInput(prompt.text, []) }) })
    return prompt.text
  }
  const first = await emit(apex.conversation, "person", "JOINT person initial", true)
  assert.ok(first.includes(`ask ${question.id}`) && first.includes(`v1 · owner ${parent}`))
  kept(await world.agents.report(world.caller(source.conversation!), { status: "progress", summary: "Fresh roster evidence; original action still owed.", clientKey: "quiet-roster" }))
  const repeated = await emit(apex.conversation, "person", "JOINT person repeat", false)
  assert.ok(repeated.includes("Fresh roster evidence") && repeated.includes(`ask ${question.id}`), "roster and question stay dynamic without guidance")
  kept(await world.agents.settle(apex.caller, { to: "source", report: action.id, version: 1, target, disposition: { kind: "defer", reason: "Await exact slot.", resume: "The fixture reviewer is ready." }, clientKey: "defer" }))
  const nextQuestion = kept(await world.agents.report(world.caller(source.conversation!), { status: "done", summary: "Fresh question evidence; original action remains owed.", question: "Authentication outcome unknown; do not retry. Which evidence is needed?", supersedes: [question.id], clientKey: "replacement-question" }))
  const service = await emit(apex.conversation, "service", "JOINT service fresh version and question", false)
  assert.ok(service.includes(`v2 · owner ${parent}`) && service.includes(`ask ${nextQuestion.id}`))
  assert.ok(!service.includes(`ask ${question.id}`))
  assert.ok(service.includes("Authentication outcome unknown; do not retry."))
  const sent = kept(await world.agents.send(apex.caller, { to: "receiver", reply: "none", text: `JOINT_FAIL_REVIEW report ${action.id}, target ${JSON.stringify(target)}; return its verdict.`, clientKey: "dispatch" }))
  const request = () => world.live.snapshot(receiver.conversation!)!.requests.find(item => item.id === sent.request)!
  await until(() => world.prompts.some(p => p.conversation === receiver.conversation && p.text.includes("JOINT_FAIL_REVIEW")))
  kept(await world.agents.settle(apex.caller, { to: "source", report: action.id, version: 2, target, disposition: { kind: "handoff", to: "receiver", request: sent.request }, clientKey: "custody" }))
  world.release(receiver.conversation!)
  await until(() => request().status === "failed")
  await world.settle(40)
  const failed = await emit(apex.conversation, "service", "JOINT service failed custody", false)
  assert.ok(failed.includes(`v3 · owner ${receiver.child}`) && failed.includes("request failed"))
  assert.ok(failed.includes(`ask ${nextQuestion.id}`))
  assert.equal(world.store.edges().children(receiver.child!).length, 0)
  const receiverPrompt = await emit(receiver.conversation!, "service", "JOINT no-child receiver", false)
  assert.ok(receiverPrompt.includes(`source Apex ${parent}`) && receiverPrompt.includes("request failed"))
  assert.ok(!receiverPrompt.includes(`ask ${nextQuestion.id}`), "custody projection grants no sibling question access")
  assert.ok("refused" in await world.agents.read(world.caller(receiver.conversation!), { child: source.child! }), "routing cadence grants no sibling transcript access")
  rule = "Replacement rule applies; all exact obligations still persist."
  const changedRule = await emit(apex.conversation, "person", "JOINT person changed rule", false)
  assert.ok(changedRule.includes(rule) && changedRule.includes(`ask ${nextQuestion.id}`) && changedRule.includes("request failed"))
  assert.ok(changedRule.includes("- fin:source · Claude · done; decide: Authentication outcome unknown;") && changedRule.includes("last report (progress, just now): Custody still awaits the source Apex decision."), "fresh decision and receiver report stay in the person roster after rule change")
  world.live.observe({ type: "live-update", id: apex.conversation, update: { kind: "event", label: CONTEXT_COMPACTED } })
  await emit(apex.conversation, "service", "JOINT service after compaction", false)
  await emit(apex.conversation, "person", "JOINT person after compaction", true)
  kept(await world.agents.settle(apex.caller, { to: "source", report: action.id, version: 3, target, disposition: { kind: "defer", reason: "Failed custodian still needs an exact decision.", resume: "Verified replacement outcome." }, clientKey: "defer-custody" }))
  const current = await emit(apex.conversation, "person", "JOINT person version four", false)
  assert.ok(current.includes(`v4 · owner ${receiver.child}`) && current.includes("request failed"))
  world.live.observe({ type: "live-rewound", id: apex.conversation, run: "joint-rewind" })
  await emit(apex.conversation, "person", "JOINT person after rewind", true)
  await emit(apex.conversation, "service", "JOINT service after rewind", false)
  await world.restart()
  const restart = await emit(apex.conversation, "service", "JOINT source after restart", false)
  assert.ok(restart.includes(`ask ${nextQuestion.id}`) && restart.includes(`v4 · owner ${receiver.child}`) && restart.includes("request failed"))
  await emit(apex.conversation, "person", "JOINT first person after restart", true)
  const receiverRestart = await emit(receiver.conversation!, "service", "JOINT receiver after restart", false)
  assert.ok(receiverRestart.includes(`v4 · owner ${receiver.child}`) && receiverRestart.includes("request failed"))
  kept(await world.agents.stop(apex.caller, { child: "source", reason: "Source fixture Stop; decision remains owed." }))
  kept(await world.agents.stop(apex.caller, { child: "receiver", reason: "Custodian fixture Stop; no native resume." }))
  await world.restart()
  const closed = await emit(apex.conversation, "service", "JOINT all children closed", false)
  assert.ok(closed.includes("custodian stopped") && closed.includes(`v4 · owner ${receiver.child}`))
  assert.equal(world.store.edges().children(parent).filter(edge => !edge.closedAt).length, 0)
  assert.equal(world.store.reportAction(action.id)!.version, 4)
  if (process.argv[2] === "--capture" && process.argv[3]) writeFileSync(process.argv[3], JSON.stringify({ synthetic: true, target, action: action.id, question: nextQuestion.id, parent, receiver: receiver.child, trace, allPrompts: world.prompts, limitations: "Injected drivers; actual Mako input assembly and codexInput encoding only. No provider serialization, tokens, cache, bill or opaque compaction proof." }, null, 2) + "\n")
  captured = true
  console.log("joint action cadence: fresh roster/question/version/owner/failed-custody on person/service/reset/restart; fixed guidance only cadence; no-child receiver and closed-child source recoverability PASS")
} finally {
  if (!captured && process.argv[2] === "--capture" && process.argv[3]) writeFileSync(process.argv[3], JSON.stringify({ synthetic: true, status: "failed-before-final-acceptance", trace, allPrompts: world.prompts }, null, 2) + "\n")
  await world.close(); rmSync(root, { recursive: true, force: true })
}

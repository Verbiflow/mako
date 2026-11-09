import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { invokeWithRecovery } from "@mako/host/contracts/host-call-recovery"
import { RuntimeDisconnectedError } from "@mako/host/contracts/host-connection"
import type { AgentAsk } from "@mako/host/contracts/agent-asks"
import { AgentAskGate } from "@mako/host/conversations/agent-ask-gate"
import { ThreadMoveTool } from "@mako/host/conversations/thread-move-tool"

const pending = new Map<string, AgentAsk[]>()
const gate = new AgentAskGate({
  open: id => pending.get(id) ?? [],
  raise: (id, ask) => { pending.set(id, [...(pending.get(id) ?? []), ask]) },
  settle: (id, ask) => {
    const found = pending.get(id)?.find(each => each.id === ask)
    pending.set(id, (pending.get(id) ?? []).filter(each => each.id !== ask))
    return found
  },
})
let hostMoves = 0
let exists = true
const tool = new ThreadMoveTool({
  conversationOf: session => session === "own" ? "cloud-thread" : undefined,
  // A cloud machine owns the live conversation locally; core therefore calls its place "here".
  place: () => exists ? "here" : undefined, tier: () => "auto", busy: () => false, ownWorktree: () => false, machine: true,
  moves: () => { hostMoves++; return undefined }, gate,
})
// Core must register this owned handler; a renderer mock accepting every answer cannot establish that wiring.
const core = readFileSync(new URL("../packages/host/src/core.ts", import.meta.url), "utf8")
assert.match(core, /back: \(id\) => late\.threadMoves\?\.allowedBack\(id\)/)
gate.runs.back = id => tool.allowedBack(id)
let rpcCalls = 0
let loseAcknowledgment = false
const bridge = {
  answerAgentAsk: async (id: string, ask: string, allow: boolean) => invokeWithRecovery("mako:agent-ask-answer", async attempt => {
    rpcCalls++
    const answer = await gate.answer(id, ask, allow)
    if (loseAcknowledgment && attempt === 1) { loseAcknowledgment = false; throw new RuntimeDisconnectedError(true) }
    return answer
  }, { dropped: async () => true }),
  liveSnapshot: async () => null,
}
Object.defineProperty(globalThis, "window", { value: { mako: bridge }, configurable: true })
Object.assign(globalThis, { requestAnimationFrame: (run: () => void) => setTimeout(run, 16), cancelAnimationFrame: clearTimeout })
const { agentAskCard } = await import("../src/state/agent-asks")
const request = async () => {
  const result = await tool.move({ kind: "agent", session: "own" }, { to: "back", clientKey: "back" })
  assert.ok("ask" in result)
  const ask = gate.open("cloud-thread").find(each => each.id === result.ask)
  assert.ok(ask)
  return ask
}
let clientReturns = 0
const pressBack = (id: string) => { assert.equal(id, "cloud-thread"); clientReturns++ }
const choose = async (ask: AgentAsk, answer: "allow" | "keep") => {
  const choice = agentAskCard("cloud-thread", ask, "Fixture", pressBack).choices.find(choice => choice.answer === answer)
  assert.ok(choice)
  return choice.choose()
}
const first = await request()
const before = rpcCalls
assert.deepEqual(agentAskCard("cloud-thread", first, "Fixture").choices, [], "a client without a return action cannot allow the ask")
assert.equal(rpcCalls, before)
assert.equal(await choose(first, "allow"), true)
assert.equal(clientReturns, 1, "the real client card proceeds after the real gate acknowledges")
assert.equal(hostMoves, 0, "the cloud acknowledgement neither runs nor claims a return")
assert.deepEqual(gate.open("cloud-thread"), [])
assert.equal(await choose(first, "allow"), false, "a stale allow after accepted success cannot delegate again")
assert.equal(clientReturns, 1)
const absent = { ...first, id: "absent-ask" }
assert.equal(await choose(absent, "allow"), false, "an absent ask is not an accepted choice")
assert.equal(clientReturns, 1)
const refused = await request()
assert.equal(await choose(refused, "keep"), true)
assert.equal(clientReturns, 1, "refusal never presses return")
assert.equal(await choose(refused, "allow"), false, "a stale allow after Keep cannot delegate")
assert.equal(clientReturns, 1)
const failed = await request()
exists = false
assert.equal(await choose(failed, "allow"), false, "an owned handler's failure reaches the client")
assert.equal(clientReturns, 1)
assert.deepEqual(gate.open("cloud-thread"), [failed])
exists = true
assert.equal(await choose(failed, "allow"), true, "the same ask remains answerable after failure")
assert.equal(clientReturns, 2)
const missing = await request()
delete gate.runs.back
assert.equal(await choose(missing, "allow"), false, "missing handlers still fail rather than consume the ask")
assert.deepEqual(gate.open("cloud-thread"), [missing])
assert.equal(clientReturns, 2)
gate.runs.back = id => tool.allowedBack(id)
assert.equal(await choose(missing, "allow"), true)
assert.equal(clientReturns, 3)
assert.equal(hostMoves, 0)
const concurrent = await request()
const beforeConcurrent = clientReturns
assert.deepEqual((await Promise.all([choose(concurrent, "allow"), choose(concurrent, "allow")])).sort(), [false, true], "only the newly accepted choice delegates, not a matching joined answer")
assert.equal(clientReturns, beforeConcurrent + 1)
const keptFirst = await request()
const beforeKeep = clientReturns
const keep = choose(keptFirst, "keep"), lateAllow = choose(keptFirst, "allow")
assert.equal(await keep, true)
assert.equal(await lateAllow, false)
assert.equal(clientReturns, beforeKeep)
const allowFirst = await request()
const firstAllow = choose(allowFirst, "allow"), oppositeKeep = choose(allowFirst, "keep")
assert.equal(await firstAllow, true)
assert.equal(await oppositeKeep, false)
assert.equal(clientReturns, beforeKeep + 1)
const lost = await request()
const beforeLost = clientReturns
loseAcknowledgment = true
assert.equal(await choose(lost, "allow"), false, "actual recovery of a lost acknowledgment returns missing, not another client grant")
assert.deepEqual(gate.open("cloud-thread"), [])
assert.equal(await choose(lost, "allow"), false, "a later click cannot reconstruct permission from an absent ask")
assert.equal(clientReturns, beforeLost, "an unconfirmed client return stays unconfirmed; it is never claimed complete")
const unconfirmed = await request()
Object.defineProperty(globalThis, "window", { value: { mako: { ...bridge, answerAgentAsk: async () => undefined } }, configurable: true })
assert.equal(await choose(unconfirmed, "allow"), false, "a successful void response never grants a client action")
assert.deepEqual(gate.open("cloud-thread"), [unconfirmed])
Object.defineProperty(globalThis, "window", { value: { mako: { ...bridge, answerAgentAsk: async () => ({ outcome: "answered", ask: "other-ask", allow: true, want: { kind: "back" } }) } }, configurable: true })
assert.equal(await choose(unconfirmed, "allow"), false, "another operation's acknowledgment cannot grant this client action")
assert.equal(clientReturns, beforeLost)
Object.defineProperty(globalThis, "window", { value: { mako: bridge }, configurable: true })
await choose(unconfirmed, "keep")
Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
const disconnected = await request()
assert.equal(await choose(disconnected, "allow"), false, "a missing bridge cannot acknowledge or press return")
assert.deepEqual(gate.open("cloud-thread"), [disconnected])
assert.equal(clientReturns, beforeLost)
console.log("back ask: actual request/gate/client return, refusal, missing return client/bridge, failed/missing handler retry, stale/refused/absent/duplicate/concurrent choices and lost-ack recovery passed; no move executed")

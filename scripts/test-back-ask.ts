import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
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
const bridge = {
  answerAgentAsk: async (id: string, ask: string, allow: boolean) => { rpcCalls++; await gate.answer(id, ask, allow) },
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
const refused = await request()
assert.equal(await choose(refused, "keep"), true)
assert.equal(clientReturns, 1, "refusal never presses return")
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
Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
const disconnected = await request()
assert.equal(await choose(disconnected, "allow"), false, "a missing bridge cannot acknowledge or press return")
assert.deepEqual(gate.open("cloud-thread"), [disconnected])
assert.equal(clientReturns, 3)
console.log("back ask: actual request/gate/client return, refusal, missing return client/bridge, failed and missing handler retries passed; no move executed")

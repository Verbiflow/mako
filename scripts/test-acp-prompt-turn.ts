import assert from "node:assert/strict"
import type { PromptResponse } from "@agentclientprotocol/sdk"
import { AcpPromptTurn, type AcpTurnResult } from "@mako/host/harnesses/acp-prompt-turn"

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
for (const order of ["original-first", "steer-first"]) {
  const results: AcpTurnResult[] = []
  const turn = new AcpPromptTurn((result) => results.push(result))
  const original = Promise.withResolvers<PromptResponse>()
  const steering = Promise.withResolvers<PromptResponse>()
  const first = turn.send(() => original.promise)
  let accepted = false
  const second = turn.send(() => steering.promise, "steer").then(() => { accepted = true })
  assert.equal(turn.acceptsSteering, true)
  if (order === "original-first") original.resolve({ stopReason: "end_turn" })
  else steering.resolve({ stopReason: "end_turn" })
  await tick()
  assert.equal(results.length, 0, "One prompt response cannot finish a turn with another prompt in flight")
  original.resolve({ stopReason: "end_turn" })
  steering.resolve({ stopReason: "end_turn" })
  await Promise.all([first, second])
  assert.equal(accepted, true)
  assert.equal(results.length, 0, "The steering receipt settles before the idle event can drain a queued message")
  assert.equal(turn.acceptsSteering, false)
  await tick()
  assert.deepEqual(results, [{ kind: "completed", stopReason: "end_turn" }])
  await assert.rejects(turn.send(async () => ({ stopReason: "end_turn" })), /finished/)
}
const failures: AcpTurnResult[] = []
const failing = new AcpPromptTurn((result) => failures.push(result))
const remaining = Promise.withResolvers<PromptResponse>()
const running = failing.send(() => remaining.promise)
await assert.rejects(failing.send(async () => { throw new Error("Disconnected after dispatch") }), /Disconnected/)
remaining.resolve({ stopReason: "end_turn" })
await running
await tick()
assert.deepEqual(failures, [{ kind: "failed", error: "Disconnected after dispatch" }])
const refusedResults: AcpTurnResult[] = []
const refused = new AcpPromptTurn((result) => refusedResults.push(result))
const original = Promise.withResolvers<PromptResponse>()
const active = refused.send(() => original.promise)
await assert.rejects(refused.send(async () => { throw new Error("Steering refused") }, "steer"), /refused/)
original.resolve({ stopReason: "end_turn" })
await active
await tick()
assert.deepEqual(refusedResults, [{ kind: "completed", stopReason: "end_turn" }], "Failed steering cannot turn a successful original answer into a failure")
for (const reverse of [false, true]) {
  const results: AcpTurnResult[] = []
  const turn = new AcpPromptTurn((result) => results.push(result))
  const primary = Promise.withResolvers<PromptResponse>()
  const steer = Promise.withResolvers<PromptResponse>()
  const first = turn.send(() => primary.promise)
  const second = turn.send(() => steer.promise, "steer")
  if (reverse) steer.resolve({ stopReason: "cancelled" })
  else primary.resolve({ stopReason: "end_turn" })
  await tick()
  primary.resolve({ stopReason: "end_turn" })
  steer.resolve({ stopReason: "cancelled" })
  await Promise.all([first, second])
  await tick()
  assert.deepEqual(results, [{kind:"completed", stopReason:"end_turn"}], "A cancelled auxiliary steering response must not relabel a completed answer as interrupted")
}
const stoppedResults: AcpTurnResult[] = []
const stopped = new AcpPromptTurn((result) => stoppedResults.push(result))
const stoppingPrompt = Promise.withResolvers<PromptResponse>()
const stoppingSteer = Promise.withResolvers<PromptResponse>()
const originalStop = stopped.send(() => stoppingPrompt.promise)
const steerStop = stopped.send(() => stoppingSteer.promise, "steer")
stoppingPrompt.resolve({stopReason:"end_turn"})
await tick()
stopped.cancel()
assert.equal(stopped.acceptsSteering, false)
await assert.rejects(stopped.send(async () => ({stopReason:"end_turn"}), "steer"), /stopping/)
stoppingSteer.resolve({stopReason:"cancelled"})
await Promise.all([originalStop, steerStop])
await tick()
assert.deepEqual(stoppedResults, [{kind:"completed",stopReason:"cancelled"}], "An explicit Stop remains interrupted even after an earlier prompt completed")
console.log("ACP steering: completion order, auxiliary cancellation, explicit Stop, receipt ordering, and failure preservation verified")

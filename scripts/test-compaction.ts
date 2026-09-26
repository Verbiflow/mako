import assert from "node:assert/strict"
import { mock } from "node:test"
import { COMPACTION_CONFIRMATION_MS } from "../electron/contracts/recovery.ts"
import { AcpCompaction } from "../electron/acp-compaction.ts"
import { devinCompaction } from "../electron/providers/devin/compaction.ts"
import type { LiveActionResult } from "../electron/contracts/live-actions.ts"
import { recoveryCapabilities } from "../electron/providers/live-driver.ts"

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
assert.equal(devinCompaction.kind, "supported")
if (devinCompaction.kind !== "supported") throw new Error("Expected compaction")
for (const early of [false, true]) {
  const results: LiveActionResult[] = []
  const reply = Promise.withResolvers<{ stopReason: "end_turn" }>()
  const operation = new AcpCompaction(devinCompaction, (result) =>
    results.push(result)
  )
  operation.start(() => reply.promise)
  if (early) {
    reply.resolve({ stopReason: "end_turn" })
    await tick()
  }
  assert.deepEqual(results, [], "Devin admission is never completion")
  for (const text of ["Compacting context…", "Context com", "pacted"])
    operation.observe({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    })
  reply.resolve({ stopReason: "end_turn" })
  await tick()
  operation.observe({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Context compacted" },
  })
  assert.deepEqual(
    results,
    [{ kind: "completed" }],
    "early/late reply and duplicate notifications settle once"
  )
}
for (const [text, kind] of [
  ["Nothing to compact.", "completed"],
  ["Compacting context…Compaction canceled.", "failed"],
  ["Compacting context…Force compaction failed: backend refused", "failed"],
] as const) {
  const results: LiveActionResult[] = []
  const operation = new AcpCompaction(devinCompaction, (result) =>
    results.push(result)
  )
  operation.start(async () => ({ stopReason: "end_turn" }))
  operation.observe({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  })
  await tick()
  assert.equal(results[0]?.kind, kind)
}
{
  const results: LiveActionResult[] = []
  const operation = new AcpCompaction(devinCompaction, (result) => results.push(result))
  operation.start(async () => {
    throw new Error("transport lost")
  })
  await tick()
  assert.deepEqual(results, [{ kind: "uncertain", reason: "transport lost" }])
}
{
  const completed: LiveActionResult[] = []
  const response = Promise.withResolvers<{ stopReason: "end_turn" }>()
  new AcpCompaction(devinCompaction, (result) => completed.push(result)).start(() => response.promise)
  response.resolve({ stopReason: "end_turn" })
  await tick()
  assert.deepEqual(completed, [], "a command reply alone never confirms compaction")
}
assert.equal(recoveryCapabilities(undefined).compaction.kind, "unavailable")
mock.timers.enable({ apis: ["setTimeout"] })
try {
  const timedOut: LiveActionResult[] = []
  const operation = new AcpCompaction(devinCompaction, (result) =>
    timedOut.push(result)
  )
  operation.start(async () => ({ stopReason: "end_turn" }))
  await tick()
  mock.timers.tick(COMPACTION_CONFIRMATION_MS)
  assert.equal(
    timedOut[0]?.kind,
    "uncertain",
    "missing confirmation is never success"
  )
  operation.observe({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Context compacted" },
  })
  assert.equal(timedOut.length, 1)
  const disposed = new AcpCompaction(devinCompaction, () =>
    assert.fail("closed operation emitted a result")
  )
  disposed.start(async () => ({ stopReason: "end_turn" }))
  disposed.dispose()
  await tick()
  mock.timers.tick(COMPACTION_CONFIRMATION_MS)
} finally {
  mock.timers.reset()
}
console.log(
  "PASS: provider-owned compaction completion, early acknowledgement, split notifications, failure, cancellation and unknown delivery"
)

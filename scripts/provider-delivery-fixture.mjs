import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"

/** Real native prompts through the production owner; no supplied native path or replay transcript. */
export async function verifyNativeDelivery({ owner, id, nonce, catalog, waitFor, restart }) {
  const firstId = randomUUID()
  const text = `Remember this exact test value: ${nonce}. Reply with that value only. Do not use tools.`
  const began = performance.now()
  console.log(`Delivery ${id}: submitting native prompt`)
  owner.submit(id, firstId, text)
  owner.submit(id, firstId, text)
  const first = await waitFor(id, (snapshot) => snapshot?.requests.some((request) =>
    request.id === firstId && request.status === "completed"))
  const firstRequest = first.requests.find((request) => request.id === firstId)
  assert.equal(firstRequest.nativeDelivery?.evidence.kind, "accepted", "Completed native turn must supply a receipt")
  assert.equal(first.requests.filter((request) => request.id === firstId).length, 1)
  assert.equal(first.blocks.filter((block) => block.type === "user" && block.requestId === firstId).length, 1)
  const reply = first.blocks.filter((block) => block.type === "text").map((block) => block.text).join("\n")
  assert.ok(reply.includes(nonce), "Native provider must return the generated value")
  const firstMs = performance.now() - began

  console.log(`Delivery ${id}: native receipt verified; discovering source`)
  // Use the same discovery entry point as the host after catalog updates.
  await catalog.scan()
  owner.discoverNativePaths()
  const discovered = owner.snapshot(id)
  const binding = discovered.control.bindings.find((candidate) => candidate.id === discovered.control.activeBindingId)
  assert.ok(binding?.path, "Automatic discovery must resolve the native store")
  const nativeId = discovered.session.nativeId
  assert.ok(nativeId)
  console.log(`Delivery ${id}: restarting owner`)
  const recovered = await restart(binding)
  const retained = recovered.snapshot(id).requests.find((request) => request.id === firstId)
  assert.deepEqual(retained.nativeDelivery, firstRequest.nativeDelivery, "Native receipt must survive owner reopen")
  recovered.submit(id, firstId, text)
  assert.equal(recovered.snapshot(id).requests.length, first.requests.length, "Repeating an operation after restart cannot create another send")

  const followupId = randomUUID()
  const reopenBegan = performance.now()
  console.log(`Delivery ${id}: submitting native recall after reopen`)
  recovered.submit(id, followupId, "What exact test value did I ask you to remember? Reply with that value only. Do not use tools.")
  const reopened = await waitFor(id, (snapshot) => snapshot?.requests.some((request) =>
    request.id === followupId && request.status === "completed"))
  const followup = reopened.requests.find((request) => request.id === followupId)
  assert.equal(reopened.session.nativeId, nativeId, "Reopen must retain native identity")
  assert.equal(followup.nativeDelivery?.evidence.kind, "accepted", "Reopened native turn must supply a receipt")
  assert.notEqual(followup.nativeDelivery.attemptId, firstRequest.nativeDelivery.attemptId)
  const input = reopened.blocks.findIndex((block) => block.type === "user" && block.requestId === followupId)
  assert.ok(input >= 0)
  const recalled = reopened.blocks.slice(input + 1).filter((block) => block.type === "text").map((block) => block.text).join("\n")
  assert.ok(recalled.includes(nonce), "Reopened native session must remember the value")
  assert.ok(!followup.context?.some((manifest) => manifest.includesBase || manifest.fromBlock < first.blocks.length), "Native recall must not be replaced by full transcript replay")
  return { nativeId, firstMs, reopenMs: performance.now() - reopenBegan,
    initial: firstRequest.nativeDelivery, reopened: followup.nativeDelivery,
    automaticSource: binding.path, sameNativeIdentity: true, recalled: true, duplicateOperationRetained: true,
    snapshot: reopened }
}

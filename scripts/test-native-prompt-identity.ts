import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import { nativePromptReference, nativePromptRequestIds, NO_NATIVE_PROMPT_IDENTITY } from "../electron/contracts/native-prompt-identity.ts"
import { projectLive } from "../src/state/live-projection.ts"
import { reconcileMessages } from "../src/lib/reconcile.ts"
import { auditId, auditSnapshot } from "./performance-audit-fixtures.ts"
import { registeredHarnessIds } from "./registered-harnesses.ts"
import { acpLiveDriver } from "../electron/providers/acp-live-driver.ts"
import { noAcpCapabilities } from "./fixtures/driver-capabilities.ts"

const capability = { kind: "accepted-message-id", evidence: "Injected message receipt" } as const
assert.equal(acpLiveDriver({
  ...noAcpCapabilities,
  provider: "future-acp-fixture", nativePromptIdentity: capability,
  approvalEvidence: { kind: "submission-only", reason: "Fixture" },
  planning: { via: "setting", option: "plan", proposal: "Fixture", feedback: { kind: "next-message", reason: "Fixture" } },
  backgroundStop: { kind: "ends-with-turn", evidence: "Fixture" },
  available: () => true, launch: async () => null,
}).nativePromptIdentity, capability, "ACP forwards the provider contribution instead of fixing its availability in transport")
const scope = { bindingId: "binding", attemptId: auditId(20), provider: "fixture", nativeId: "native", path: "/fixture/history" }
const accepted = { kind: "accepted", source: "native-response", referenceId: "u1" } as const
const reference = nativePromptReference(capability, accepted, scope)
assert.ok(reference)
assert.equal(nativePromptReference(NO_NATIVE_PROMPT_IDENTITY, accepted, scope), undefined)
assert.equal(nativePromptReference(capability, { kind: "uncertain", reason: "lost response" }, scope), undefined)
assert.equal(nativePromptReference(capability, { kind: "submitted", source: "transport-call", correlationId: "run-id" }, scope), undefined)
assert.equal(nativePromptReference(capability, { kind: "accepted", source: "native-response" }, scope), undefined)
assert.equal(nativePromptReference(capability, accepted, { ...scope, nativeId: undefined }), undefined)
assert.equal(nativePromptReference(capability, accepted, { ...scope, path: undefined }), undefined)
const request = { id: auditId(1), nativePrompt: reference, nativeDelivery: {
  attemptId: scope.attemptId, bindingId: scope.bindingId, ownerEpoch: "owner", evidence: accepted,
} }
const source = { harness: scope.provider, nativeId: scope.nativeId, path: scope.path }
assert.deepEqual([...nativePromptRequestIds(source, [request])], [["u1", request.id]])
for (const mismatch of [
  { ...source, harness: "other" }, { ...source, nativeId: "other" }, { ...source, path: "/other/history" },
]) assert.equal(nativePromptRequestIds(mismatch, [request]).size, 0)
for (const delivery of [
  { ...request.nativeDelivery, attemptId: auditId(21) },
  { ...request.nativeDelivery, bindingId: "other" },
  { ...request.nativeDelivery, evidence: { ...accepted, referenceId: "other" } },
]) assert.equal(nativePromptRequestIds(source, [{ ...request, nativeDelivery: delivery }]).size, 0)
assert.equal(nativePromptRequestIds(source, [{ ...request, nativeDelivery: undefined }]).size, 0)
assert.equal(nativePromptRequestIds(source, [request, { ...request, id: auditId(2) }]).size, 0,
  "ambiguous native IDs must not attach the wrong request")
assert.equal(nativePromptRequestIds(source, [request, { ...request,
  nativePrompt: { ...reference, messageId: "u2" }, nativeDelivery: { ...request.nativeDelivery, evidence: { ...accepted, referenceId: "u2" } },
}]).size, 0, "one request cannot identify two native prompts")

// Exercise the shared projection for every registry label and a future adapter.
// These labels prove substitution, not native availability of the capability.
for (const harness of [...registeredHarnessIds(), "future-fixture"]) {
  const snapshot = auditSnapshot(2, harness, 64, 0)
  snapshot.session.status = "ready"
  snapshot.blocks = [
    { type: "user", requestId: auditId(1), text: "continue" },
    { type: "text", id: "a1", text: "first" },
    { type: "user", requestId: auditId(2), text: "continue" },
    { type: "text", id: "a2", text: "second" },
  ]
  snapshot.requests = snapshot.requests.map((item, index) => ({ ...item, text: "continue", status: "completed",
    nativePrompt: { ...reference, provider: harness, messageId: `u${index + 1}` },
    nativeDelivery: { ...request.nativeDelivery, evidence: { ...accepted, referenceId: `u${index + 1}` } },
  }))
  const live = projectLive(snapshot)
  const base = { ref: { ...source, harness, bytes: 1 }, start: 0, total: 5, hasEarlier: false, checkpoint: 1,
    entries: [
      { kind: "user" as const, id: "u1", text: "Native attachment wrapper", at: "2026-10-03T00:00:00Z" },
      { kind: "assistant" as const, id: "a1", blocks: [{ type: "text" as const, text: "first" }] },
      { kind: "user" as const, id: "steer", text: "steer", steeringFor: "u1" },
      { kind: "user" as const, id: "u2", text: "Native continuation wrapper" },
      { kind: "assistant" as const, id: "a2", blocks: [{ type: "text" as const, text: "second" }] },
    ],
  }
  const saved = { ...snapshot, base, baseCoveredBlocks: snapshot.blocks.length }
  const projected = projectLive(saved, live)
  assert.deepEqual(projected.exchanges.map(item => item.id), live.exchanges.map(item => item.id), harness)
  assert.equal(projected.exchanges[0]?.prompt?.id, "native-user-u1", "native record ID stays native")
  assert.deepEqual(projected.exchanges[0]?.prompt?.anchor, { id: "u1", index: 0, at: "2026-10-03T00:00:00Z" })
  assert.equal(projected.exchanges[0]?.response.some(item => item.steeringFor === "native-user-u1"), true)
  const repeated = projectLive({ ...saved }, projected)
  assert.equal(repeated.messages, projected.messages, "unchanged native messages reuse objects")
  assert.equal(repeated.exchanges[0], projected.exchanges[0], "unchanged exchanges reuse objects")
  const legacy = projectLive({ ...saved, requests: undefined }, projected)
  assert.equal(legacy.exchanges[0]?.id, "native-user-u1", "missing provenance never inherits guessed semantic identity")
  assert.equal(legacy.exchanges[0]?.prompt?.requestId, undefined)
  const regained = projectLive(saved, legacy)
  assert.equal(regained.exchanges[0]?.prompt?.requestId, auditId(1), "reconciliation preserves newly proven metadata")
  const duplicate = projectLive({ ...saved, base: { ...base, entries: [...base.entries, base.entries[0]!] } })
  assert.ok(duplicate.messages.filter(item => item.id === "native-user-u1").every(item => !item.requestId),
    "duplicate native records cannot inherit an authoritative request link")
}
const message = { id: "same", role: "user" as const, blocks: [], anchor: { id: "native", index: 0, at: "before" } }
assert.notEqual(reconcileMessages([message], [{ ...message, anchor: { ...message.anchor, at: "after" } }])[0], message)

const many = Array.from({ length: 10000 }, (_, index) => ({ ...request, id: auditId(index + 1),
  nativePrompt: { ...reference, messageId: `u${index}` },
  nativeDelivery: { ...request.nativeDelivery, evidence: { ...accepted, referenceId: `u${index}` } },
}))
const started = performance.now()
assert.equal(nativePromptRequestIds(source, many).size, many.length)
const elapsed = performance.now() - started
assert.ok(elapsed < 1000, `10,000 exact correspondences took ${elapsed.toFixed(1)}ms`)
console.log(`Native prompt correspondence: exact receipts, source/attempt/binding fencing, ambiguity refusal, six registry labels plus future fixture, metadata/object reuse; 10,000 lookups in ${elapsed.toFixed(1)}ms. No native prompt sent.`)

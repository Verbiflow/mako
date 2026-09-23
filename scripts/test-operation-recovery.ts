import assert from "node:assert/strict"
import { actionRetainsInput, describeActionRecovery, describeTransferRecovery } from "../electron/contracts/operation-recovery.js"
import type { ContextTransfer } from "../electron/contracts/conversation-control.js"
import { LiveActionSchema, type LiveAction } from "../electron/contracts/live-actions.js"
import type { LiveRequest } from "../electron/contracts/live-conversations.js"

const id = "11111111-1111-4111-8111-111111111111"
const manifest = { file: "/context.md", digest: "digest", sourceRevision: 1, fromBlock: 0, toBlock: 1, includesBase: true, losses: [] }
const request: LiveRequest = { id, status: "queued", text: "Check the change", attachments: [] }
for (const provider of ["Claude Code", "Codex", "Cursor", "Grok", "Devin", "OpenCode", "Future agent"]) {
  const transfer: ContextTransfer = { input: { id, provider, text: request.text, attachments: [] }, createdAt: 1, state: { kind: "accepted", bindingId: id, manifest } }
  assert.match(describeTransferRecovery(transfer, provider, request).guidance, /waiting to be sent/)
  assert.match(describeTransferRecovery(transfer, provider).guidance, /Delivery is unconfirmed/)
  assert.match(describeTransferRecovery(transfer, provider, { ...request, id: "unrelated", status: "completed" }).guidance, /Delivery is unconfirmed/)
  const received: LiveRequest = { ...request, status: "failed", nativeDelivery: { attemptId: id, bindingId: id, ownerEpoch: "epoch", evidence: { kind: "accepted", source: "native-echo" } } }
  assert.match(describeTransferRecovery(transfer, provider, received).guidance, /destination received/)
  assert.doesNotMatch(describeTransferRecovery(transfer, provider, received).guidance, /completed/)
  assert.match(describeTransferRecovery(transfer, provider, { ...request, status: "completed" }).guidance, /completed/)
  const uncertain: ContextTransfer = { ...transfer, state: { kind: "uncertain", error: "Lost reply" } }
  assert.match(describeTransferRecovery(uncertain, provider).title, /unconfirmed/)
  assert.match(describeTransferRecovery(uncertain, provider).guidance, /repeat work/)
  assert.equal(describeTransferRecovery(uncertain, provider).retryLabel, "Try switch again")
  assert.equal(describeTransferRecovery({ ...transfer, state: { kind: "failed", failure: "auth", error: "Sign in" } }, provider).retryLabel, undefined)
}
for (const kind of ["compact", "steer", "steer-queued"] as const) {
  for (const state of [{kind:"dispatching"}, {kind:"accepted"}, {kind:"completed"}, {kind:"failed",reason:"Failed after dispatch"}, {kind:"not-accepted",reason:"Turn stopped"}, {kind:"uncertain",reason:"Reply lost"}, {kind:"acknowledged"}, {kind:"acknowledged",receipt:{at:1,outcome:{kind:"uncertain",reason:"Original lost reply"}}}] satisfies LiveAction["state"][]) {
    const action: LiveAction = { input: kind === "compact" ? { kind, id } : { kind, id, requestId: id, queuedRequestId: id, text: "Change direction", attachments: [] }, digest: "digest", bindingId: id, createdAt: 1, state }
    assert.deepEqual(LiveActionSchema.parse(action).state, state, "journal parsing must retain both legacy and new acknowledgement evidence")
    assert.equal(actionRetainsInput(action), state.kind !== "not-accepted")
    const description = describeActionRecovery(action)
    assert.ok(description.guidance)
    if (state.kind === "accepted") assert.match(description.guidance, /Completion has not been confirmed/)
    if (state.kind === "uncertain") assert.match(description.guidance, /does not .*confirm completion/)
    if (state.kind === "acknowledged") assert.match(description.guidance, /not a completion receipt/)
  }
}
console.log("PASS: all-six plus future-provider transfer receipts, exact request correlation and every action outcome")

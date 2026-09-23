import assert from "node:assert/strict"
import { describePromptRecovery } from "../electron/contracts/prompt-recovery.js"
import { PROVIDER_FAILURE_KINDS, describeProviderFailure } from "../electron/contracts/provider-failure.js"
import type { LiveRequest } from "../electron/contracts/live-conversations.js"
import type { PromptDeliveryEvidence } from "../electron/contracts/prompt-delivery.js"

const evidence: PromptDeliveryEvidence[] = [
  { kind: "prepared" },
  { kind: "submitted", source: "sdk-input" },
  { kind: "accepted", source: "native-echo" },
  { kind: "not-accepted", source: "preflight", reason: "Not connected" },
  { kind: "uncertain", reason: "Lost reply" },
]
function request(value?: PromptDeliveryEvidence): LiveRequest {
  return { id: "request", text: "Apply the migration", attachments: [], status: "failed", failure: "network",
    nativeDelivery: value && { attemptId: "11111111-1111-4111-8111-111111111111", bindingId: "binding", ownerEpoch: "epoch", evidence: value } }
}
for (const label of ["Claude Code", "Codex", "Cursor", "Grok", "Devin", "OpenCode", "Future agent"]) {
  for (const value of [undefined, ...evidence]) {
    const input = request(value)
    const recovery = describePromptRecovery(input, label)
    assert.equal(recovery.resendLabel, value?.kind === "not-accepted" ? "Send again" : "Send another copy")
    assert.ok(recovery.failure?.title.includes(label))
    assert.doesNotMatch(recovery.failure?.guidance ?? "", /intact|Nothing was lost/)
    if (value?.kind === "accepted") assert.match(recovery.delivery, /agent received/)
    else if (value?.kind === "not-accepted") assert.match(recovery.delivery, /not sent/)
    else assert.match(recovery.delivery, /cannot confirm/)
    for (const status of ["queued", "dispatching", "held", "completed", "canceled", "interrupted", "uncertain"] as const)
      assert.equal(describePromptRecovery({ ...input, status }, label).resendLabel, null)
    for (const failure of PROVIDER_FAILURE_KINDS) {
      const expected = describeProviderFailure(failure).retriable
      assert.equal(Boolean(describePromptRecovery({ ...input, failure }, label).resendLabel), expected)
    }
    assert.ok(describePromptRecovery({ ...input, failure: "context-exhausted" }, label, true).resendLabel)
    assert.equal(describePromptRecovery({ ...input, failure: "auth" }, label, true).resendLabel, null,
      "Old compaction success cannot make an unrelated auth failure retryable")
  }
}
assert.equal(describePromptRecovery({ ...request(evidence[2]), status: "uncertain" }).title, "Message outcome is unconfirmed")
assert.equal(describePromptRecovery({ ...request(), status: "uncertain" }).title, "Message delivery is unconfirmed")
console.log("PASS: shared recovery distinguishes receipt, refusal, unconfirmed and legacy attempts; preserves failure prerequisites across six harnesses and a future adapter")

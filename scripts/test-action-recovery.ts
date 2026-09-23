import assert from "node:assert/strict"
import { toast } from "sonner"
import { performLiveAction } from "../src/state/live-actions"
import type { LiveSnapshot } from "../src/lib/types"
import type { LiveAction } from "../electron/contracts/live-actions"

const id = "11111111-1111-4111-8111-111111111111"
const input = { kind: "compact", id } as const
const snapshot: LiveSnapshot = {
  session: { id, harness: "fixture", cwd: "/fixture", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] },
  revision: 1, createdAt: 1, blocks: [], base: null, requests: [], permissions: [],
  control: { activeBindingId: id, bindings: [], transfers: [], children: [], merges: [], actions: [] },
}
const notices: unknown[] = []
toast.error = (message) => { notices.push(message); return "fixture-toast" }
for (const state of [{kind:"dispatching"}, {kind:"accepted"}, {kind:"completed"}, {kind:"failed",reason:"Failure after dispatch"}, {kind:"not-accepted",reason:"Native refusal"}, {kind:"uncertain",reason:"Native reply lost"}, {kind:"acknowledged"}] satisfies LiveAction["state"][]) {
  const receipt: LiveAction = { input, bindingId: id, digest: "digest", createdAt: 1, state }
  for (const lost of [false, true]) {
    let calls = 0
    notices.length = 0
    Object.assign(globalThis, { window: { mako: {
      liveAction: async () => { calls++; if (lost) throw Error("HTTP reply lost"); return receipt },
      liveSnapshot: async () => ({ ...snapshot, revision: snapshot.revision++, control: { ...snapshot.control, actions: [receipt] } }),
    } } })
    assert.equal(await performLiveAction(id, input), state.kind !== "not-accepted", `${state.kind}, lost=${lost}`)
    assert.equal(calls, 1, "Recovering a receipt never dispatches the action again")
    if (state.kind === "not-accepted") assert.deepEqual(notices, ["Native refusal"], "Native refusal survives a lost transport reply")
  }
}
Object.assign(globalThis, { window: { mako: {
  liveAction: async () => { throw Error("No receipt") },
  liveSnapshot: async () => ({ ...snapshot, control: { ...snapshot.control, actions: [] } }),
} } })
assert.equal(await performLiveAction(id, input), false, "Without a receipt the input is not discarded")
console.log("PASS: direct and recovered action receipts retain input consistently, preserve refusal and never redispatch")

const { retryTransfer, submitTransfer } = await import("../src/state/live-transfers")
const { applyLiveSnapshot } = await import("../src/state/live-recovery")
const { acpStore } = await import("../src/state/acp-state")
const transferId = "22222222-2222-4222-8222-222222222222"
const bindingId = "33333333-3333-4333-8333-333333333333"
const transfer = { input: { id: transferId, provider: "fixture", bindingId, modeId: "plan", text: "Keep the selected session", attachments: [], tuning: { model: "fixture-model" } }, createdAt: 1, state: { kind: "uncertain", error: "Reply lost" } } as const
const transferSnapshot: LiveSnapshot = { ...snapshot, epoch: "transfer-tests", revision: 100, control: { activeBindingId: id, bindings: [], children: [], merges: [], transfers: [{ ...transfer, input: { ...transfer.input, attachments: [] } }] } }
applyLiveSnapshot(transferSnapshot)
acpStore.set({ activeKey: "another-conversation" })
const writes: Array<{ conversation: string; input: import("../src/lib/types").TransferInput }> = []
const response = Promise.withResolvers<LiveSnapshot>()
Object.assign(globalThis, { window: { mako: {
  liveTransfer: async (conversation: string, input: import("../src/lib/types").TransferInput) => { writes.push({ conversation, input }); return response.promise },
  liveSnapshot: async () => transferSnapshot,
} } })
const retry = retryTransfer(id, transferId)
const duplicate = retryTransfer(id, transferId)
assert.equal(retry, duplicate, "Concurrent retry clicks share one new operation")
assert.equal(writes.length, 1)
assert.equal(writes[0]?.conversation, id, "Retry keeps its conversation even after navigation")
assert.notEqual(writes[0]?.input.id, transferId)
assert.deepEqual({ ...writes[0]?.input, id: transferId }, transfer.input, "Binding, mode, settings and input survive retry")
response.resolve(transferSnapshot)
assert.equal(await retry, true)
assert.equal(acpStore.get().activeKey, "another-conversation", "A late reply cannot navigate away from another conversation")
assert.equal(await retryTransfer(id, "missing"), false)
applyLiveSnapshot({ ...transferSnapshot, revision: 101, control: { ...transferSnapshot.control!, transfers: [{ ...transferSnapshot.control!.transfers[0]!, state: { kind: "failed", failure: "auth", error: "Sign in" } }] } })
assert.equal(await retryTransfer(id, transferId), false, "Failure prerequisites are checked in the state action too")
assert.equal(writes.length, 1)
Object.assign(globalThis, { window: { mako: {
  liveTransfer: async () => { throw Error("Lost reply") },
  liveSnapshot: async () => transferSnapshot,
} } })
assert.equal(await submitTransfer(id, { ...transfer.input, attachments: [] }), true, "A saved switch receipt survives a lost HTTP reply without another operation")
console.log("PASS: transfer retry preserves destination/mode/settings, deduplicates concurrent clicks, respects navigation and retains lost-reply receipts")

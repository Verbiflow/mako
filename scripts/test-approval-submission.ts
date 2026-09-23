import type { LiveDriverEvent } from "../electron/shared.js"
import assert from "node:assert/strict"
import { createLiveEngine, type PermittingLive } from "../electron/live-engine.js"
import { ApprovalSubmissionSchema, describeApprovalResponse, type ApprovalResponse } from "../electron/contracts/approval-response.js"

const events: LiveDriverEvent[] = []
const engine = createLiveEngine<PermittingLive>()
const live: PermittingLive = {
  state: { id: "connection", harness: "future", cwd: "/fixture", status: "running", connection: "connected", modes: [], currentMode: null, configOptions: [] },
  emit(event) { events.push(event) }, pendingPermissions: new Map(),
}
engine.sessions.set("connection", live)
const answer = { kind: "choice", optionId: "allow" } as const
assert.deepEqual(engine.respondPermission("missing", "question", answer), { kind: "not-submitted", pending: false, reason: "request-ended" })
const waiting = engine.ask(live, { id: "question", sessionId: "connection", title: "Approve?", options: [{ optionId: "allow", name: "Allow" }] })
assert.deepEqual(engine.respondPermission("connection", "question", answer), { kind: "submitted", source: "callback" })
assert.deepEqual(await waiting, answer)
assert.deepEqual(engine.respondPermission("connection", "question", answer), { kind: "not-submitted", pending: false, reason: "request-ended" })
const cancelled = engine.ask(live, { id: "cancelled", sessionId: "connection", title: "Approve?", options: [] })
const cancelledRequest = events.at(-1)
assert.ok(cancelledRequest?.type === "live-permission")
engine.release(live)
assert.deepEqual(events.at(-1), { type: "live-permission-ended", id: "connection", requestId: "cancelled",
  observationId: cancelledRequest.request.observationId, source: "connection-close" })
assert.deepEqual(await cancelled, { kind: "choice", optionId: null })
assert.equal(engine.respondPermission("connection", "cancelled", answer).kind, "not-submitted")
assert.equal(ApprovalSubmissionSchema.safeParse(undefined).success, false)
const receipt: ApprovalResponse = {
  id: "11111111-1111-4111-8111-111111111111", digest: "fixture", createdAt: 1,
  origin: { bindingId: "connection", nativeRequestId: "question", epoch: "fixture", generation: 1, connectionGeneration: 1 },
  state: { kind: "submitted" },
}
assert.match(describeApprovalResponse(receipt).guidance, /older receipt has no transport confirmation/)
assert.match(describeApprovalResponse({ ...receipt, state: { kind: "submitted", source: "callback" } }).guidance, /has not confirmed receiving/)
console.log("PASS: shared ACP/Cursor engine reports callback handoff, missing/cancelled requests, and legacy receipts never imply native confirmation")

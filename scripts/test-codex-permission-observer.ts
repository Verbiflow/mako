import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CodexPermissionObserver, codexApprovalEnvironment } from "@mako/host/harnesses/codex/permission-observer"
import { readRetainedApprovalDecisions } from "@mako/host/harnesses/retained-approval-decisions"
import { approvalAnswerDigest } from "@mako/host/harnesses/approval-evidence"
import { handleServerRequest, resolvePermission, resolveServerRequest, type PendingServerRequest, type PermissionCallbacks } from "@mako/host/harnesses/codex-app-permissions"
import type { NativeApprovalDecision, NativeApprovalIdentity } from "@mako/host/contracts/approval-response"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import type { LivePermissionRequest } from "@mako/host/contracts/providers-acp"

const root = await mkdtemp(join(tmpdir(), "mako-codex-permission-observer-"))
const outputs: NativeApprovalDecision[] = []
const events: LiveDriverEvent[] = []
const sent: unknown[] = []
const observer = new CodexPermissionObserver(root, [], decision => outputs.push(decision))
const context = { id: "conversation", serverRequests: new Map<string, PendingServerRequest>() }
const callbacks: PermissionCallbacks<typeof context> = {
  identify: (_context, call, choices) => observer.identify(call, choices),
  submitted: (_context, identity, response) => observer.submitted(identity, response),
  emit: (_context, event) => events.push(event),
  sendResult: (_context, _id, result) => { sent.push(result); return true },
  sendError: () => { throw new Error("unexpected RPC error") },
}
const event = (callId: string, decision = "approved", extras: Record<string, string> = {}) => Buffer.from(JSON.stringify({
  target: "codex_otel.log_only", level: "INFO", fields: {
    "event.name": "codex.tool_decision", "event.timestamp": new Date().toISOString(),
    "conversation.id": "thread", call_id: callId, source: "User", decision,
    "user.email": "PRIVATE_ACCOUNT", tool_arguments: "PRIVATE_TOOL", ...extras,
  },
}) + "\n")
const request = (id: number, itemId: string, file = false): LivePermissionRequest => {
  handleServerRequest(context, callbacks, id, file ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval", {
    threadId: "thread", turnId: "turn", itemId,
    availableDecisions: ["accept", "acceptForSession", "decline", "cancel", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["fixture"] } }],
  })
  const emitted = events.at(-1)
  assert.equal(emitted?.type, "live-permission")
  if (emitted?.type !== "live-permission") throw Error("missing approval")
  return emitted.request
}
const all: NativeApprovalIdentity[] = []
try {
  const env = { RUST_LOG: "warn,my_target=debug", OTEL_EXPORTER_OTLP_ENDPOINT: "https://existing.invalid", LOG_FORMAT: "text" }
  assert.deepEqual(codexApprovalEnvironment(env), { ...env, RUST_LOG: "warn,my_target=debug,codex_otel.log_only=info", LOG_FORMAT: "json" })
  assert.equal(env.LOG_FORMAT, "text", "parent environment stays untouched")
  for (const [index, native] of ["approved", "approved_for_session", "denied", "abort"].entries()) {
    const permission = request(index, `tool-${index}`, index === 1)
    assert.ok(permission.native)
    all.push(permission.native)
    assert.equal(observer.stderr(event(`tool-${index}`)), "", "pre-answer event is not submission proof")
    assert.equal(outputs.length, 0)
    const option = permission.options[index].optionId
    assert.deepEqual(resolvePermission(context, callbacks, permission.id, { kind: "choice", optionId: option }), { kind: "submitted", source: "transport-write" })
    resolveServerRequest(context, callbacks, index)
    assert.equal(outputs.length, 0, "request resolution and transport write do not confirm consumption")
    const buffer = event(`tool-${index}`, native)
    for (let at = 0; at < buffer.length; at += 7) assert.equal(observer.stderr(buffer.subarray(at, at + 7)), "")
    observer.stderr(buffer)
  }
  const nullChoice = request(10, "cancel-null")
  assert.ok(nullChoice.native)
  all.push(nullChoice.native)
  resolvePermission(context, callbacks, "10", { kind: "choice", optionId: null })
  observer.stderr(event("cancel-null", "abort"))

  const reused = request(11, "reused")
  assert.ok(reused.native)
  resolvePermission(context, callbacks, "11", { kind: "choice", optionId: "decision:0" })
  const newer = request(12, "reused")
  assert.equal(newer.native, undefined, "a repeated tool ID cannot acquire a new confirmable occurrence")
  observer.stderr(event("reused"))
  assert.ok(context.serverRequests.has("12"), "stale evidence leaves the newer question pending")
  const ignored = request(13, "ignored")
  assert.ok(ignored.native)
  resolvePermission(context, callbacks, "13", { kind: "choice", optionId: "decision:0" })
  const mismatches: Record<string, string>[] = [{ source: "Config" }, { "conversation.id": "another-session" }, { "event.timestamp": "2000-01-01T00:00:00.000Z" }, { decision: "approved_by_a_future_kind" }]
  for (const extra of mismatches)
    observer.stderr(event("ignored", "approved", extra))
  // An exec-policy rule Codex writes to rules/default.rules is confirmed by its kind when it is the one rule offered.
  const amended = request(14, "amended")
  assert.ok(amended.native)
  all.push(amended.native)
  resolvePermission(context, callbacks, "14", { kind: "choice", optionId: "decision:4" })
  observer.stderr(event("amended", "approved_with_amendment"))
  handleServerRequest(context, callbacks, 15, "item/commandExecution/requestApproval", {
    threadId: "thread", turnId: "turn", itemId: "two-rules",
    availableDecisions: ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] } }, { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git"] } }],
  })
  const twoRules = events.at(-1)
  assert.ok(twoRules?.type === "live-permission")
  assert.equal(twoRules.request.native, undefined, "two rules of one kind can't be told apart by the event, so neither is confirmed")
  assert.equal(observer.stderr(Buffer.from('{"target":"other","level":"ERROR","fields":{"message":"native failure"}}\n')), "native failure\n")
  assert.equal(observer.stderr(Buffer.from('{"target":"codex_otel.log_only","fields":{"message":"PRIVATE_ACCOUNT"}\n')), "")
  await observer.close()
  assert.equal(outputs.length, 6)
  assert.equal(outputs[1].answerDigest, approvalAnswerDigest({ kind: "choice", optionId: "acceptForSession" }))
  assert.equal(outputs[4].answerDigest, approvalAnswerDigest({ kind: "choice", optionId: null }))
  assert.equal(outputs[5].answerDigest, approvalAnswerDigest({ kind: "choice", optionId: "decision:4" }), "the rule the person chose is the one Codex reports writing")
  assert.deepEqual(await readRetainedApprovalDecisions(root, [reused.native, ignored.native]), [])
  assert.deepEqual(await readRetainedApprovalDecisions(root, all), outputs)
  const text = (await Promise.all((await readdir(root)).map(file => readFile(join(root, file), "utf8")))).join("")
  assert.ok(!text.includes("PRIVATE_") && !text.includes("tool_arguments"), "retain normalized evidence only")

  const recovered: NativeApprovalDecision[] = []
  const reopened = new CodexPermissionObserver(root, all, decision => recovered.push(decision))
  const saved = reopened.identify({ threadId: "thread", itemId: "tool-0" }, [])
  assert.equal(saved, undefined, "a new callback reusing an old tool ID cannot inherit a past receipt or be hidden by it")
  reopened.submitted(saved, { kind: "choice", optionId: "decision:0" })
  reopened.stderr(event("tool-0", "denied"))
  await reopened.close()
  assert.deepEqual(recovered, outputs, "new executor events cannot replace retained native decisions")
  assert.equal(sent.length, 8, "reconnect sends no answer")

  const lost = new CodexPermissionObserver(root, [], () => { throw Error("lost live reply") })
  const identity = lost.identify({ threadId: "thread", itemId: "lost" }, [{ optionId: "once", result: { decision: "accept" } }])!
  lost.submitted(identity, { kind: "choice", optionId: "once" })
  lost.stderr(event("lost"))
  await lost.close()
  assert.equal((await readRetainedApprovalDecisions(root, [identity])).length, 1, "native evidence is durable before publication")

  const bounded = new CodexPermissionObserver(root, [], () => { throw Error("unexpected evidence") })
  assert.match(bounded.stderr(Buffer.alloc(300 * 1024, 120)), /limit/)
  assert.equal(bounded.identify({ threadId: "thread", itemId: "bounded" }, []), undefined)
  await bounded.close()
  console.log("Codex native approval observation: exact choices, a lone exec-policy rule, split logs, privacy, replay, lost replies, stale/repeated IDs and bounds passed")
} finally {
  await observer.close()
  await rm(root, { recursive: true, force: true })
}

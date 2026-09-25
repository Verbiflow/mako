import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, stat, appendFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listenClaudePermissionDecisions } from "../electron/providers/claude/permission-observer.js"
import { hasClaudeTelemetryConfiguration, claudeTelemetryOptionsCompatible, hasClaudeTelemetrySettings } from "../electron/providers/claude/approval-telemetry-settings.js"
import { readRetainedApprovalDecisions, RetainedApprovalDecisions } from "../electron/providers/retained-approval-decisions.js"
import { approvalAnswerDigest } from "../electron/providers/approval-evidence.js"
import type { NativeApprovalDecision } from "../electron/contracts/approval-response.js"
import { ClaudePermissions } from "../electron/providers/claude/sdk-permissions.js"
import type { LiveDriverEvent } from "../electron/shared.js"

const root = await mkdtemp(join(tmpdir(), "mako-claude-permission-observer-"))
const sessionId = randomUUID()
const decisions: NativeApprovalDecision[] = []
let loseDelivery = false
const observer = await listenClaudePermissionDecisions({ root, sessionId, publish(decision) {
  if (loseDelivery) throw new Error("lost observer delivery")
  decisions.push(decision)
} })
const endpoint = observer.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT!
const batch = (tool: string, source = "user_temporary", session = sessionId) => ({ resourceLogs: [{ resource: { attributes: [{ key: "private", value: { stringValue: "must-not-retain" } }] }, scopeLogs: [{ logRecords: [{ attributes: Object.entries({
  "event.name": "tool_decision", "session.id": session, tool_use_id: tool,
  source, decision: source === "user_reject" ? "reject" : "accept", "event.sequence": "3",
  tool_parameters: "secret-tool-arguments",
}).map(([key, stringValue]) => ({ key, value: { stringValue } })) }] }] }] })
const send = (body: ReturnType<typeof batch>, url = endpoint) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
try {
  assert.equal((await send(batch("unasked"))).status, 200)
  assert.equal((await readdir(root)).length, 0, "unsolicited telemetry creates no retained data")
  assert.equal((await send(batch("unasked"), endpoint.replace(/\/[^/]+\/v1/, "/wrong/v1"))).status, 404)
  const events: LiveDriverEvent[] = []
  const permissions = new ClaudePermissions("conversation", event => events.push(event), undefined, observer)
  for (const [optionId, classification] of [["allow_once", "user_temporary"], ["allow_session", "user_permanent"], ["reject_once", "user_reject"]]) {
    const toolUseID = randomUUID(), requestId = randomUUID()
    const native = permissions.tool("Write", { file_path: "/fixture-only" }, { toolUseID, requestId, signal: new AbortController().signal,
      suggestions: [{ type: "addRules", destination: "session", behavior: "allow", rules: [{ toolName: "Write" }] }] })
    const event = events.at(-1)
    assert.ok(event?.type === "live-permission" && event.request.native)
    permissions.respond(requestId, { kind: "choice", optionId })
    assert.equal((await native).decisionClassification, classification)
    assert.equal(decisions.length, events.filter(event => event.type === "live-permission").length - 1, "callback return cannot confirm native consumption")
    assert.equal((await send(batch(toolUseID, classification, "other-session"))).status, 200)
    assert.equal((await send(batch(toolUseID, classification))).status, 200)
    assert.equal(decisions.at(-1)?.answerDigest, approvalAnswerDigest({ kind: "choice", optionId }))
    assert.deepEqual(decisions.at(-1)?.identity, event.request.native)
    const saved = await readRetainedApprovalDecisions(root, [event.request.native])
    assert.deepEqual(saved, [decisions.at(-1)], "HTTP success follows retained exact evidence")
    const path = join(root, `${event.request.native.scope}.jsonl`)
    const before = await stat(path)
    await send(batch(toolUseID, classification))
    assert.equal((await stat(path)).size, before.size, "native exporter retries are idempotent")
  }
  const count = decisions.length
  const ambiguous = observer.identify("reused")!
  assert.equal(observer.identify("reused"), undefined)
  await send(batch("reused"))
  assert.equal(decisions.length, count)
  assert.deepEqual(await readRetainedApprovalDecisions(root, [ambiguous]), [])

  const lost = observer.identify("lost-reply")!
  loseDelivery = true
  assert.equal((await send(batch("lost-reply"))).status, 503)
  const saved = await readRetainedApprovalDecisions(root, [lost])
  assert.equal(saved.length, 1, "native decision survives loss between retention and journal publication")
  assert.deepEqual(await readRetainedApprovalDecisions(root, [{ ...lost, scope: randomUUID() }, { ...lost, sessionId: "other" }, { ...lost, requestId: "newer" }]), [])
  loseDelivery = false
  await send(batch("lost-reply"))
  assert.deepEqual(decisions.at(-1), saved[0], "retry retains original evidence timestamp")
  await observer.dispose()
  assert.equal(observer.identify("after-close"), undefined)
  await assert.rejects(send(batch("lost-reply")), /fetch failed/)
  const replacementDecisions: NativeApprovalDecision[] = []
  const replacement = await listenClaudePermissionDecisions({ root, sessionId, previous: [lost], publish: decision => replacementDecisions.push(decision) })
  try {
    assert.deepEqual(replacement.identify("lost-reply"), lost, "a callback replay keeps the journaled identity, preventing a second answer")
    await send(batch("lost-reply"), replacement.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT)
    assert.deepEqual(replacementDecisions, [], "events from a replacement executor cannot confirm the older request")
    const newer = replacement.identify("new-tool")!
    assert.notEqual(newer.scope, lost.scope)
    await send(batch("new-tool"), replacement.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT)
    assert.equal(replacementDecisions.length, 1)
  } finally { await replacement.dispose() }
  const contents = await readFile(join(root, `${lost.scope}.jsonl`), "utf8")
  for (const secret of ["must-not-retain", "secret-tool-arguments", "resourceLogs", "tool_parameters"])
    assert.ok(!contents.includes(secret))
  await appendFile(join(root, `${lost.scope}.jsonl`), '{"interrupted":')
  assert.deepEqual(await readRetainedApprovalDecisions(root, [lost]), saved, "a torn final write cannot destroy complete earlier receipts")

  const failing = new RetainedApprovalDecisions(join(root, "not-a-directory"))
  await writeFile(join(root, "not-a-directory"), "fixture")
  await assert.rejects(failing.record({ identity: { ...lost, scope: failing.scope }, answerDigest: "a".repeat(64), observedAt: 1 }))
  await failing.close()
  for (const key of ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_LOGS_EXPORTER", "OTEL_EXPORTER_OTLP_HEADERS", "CLAUDE_CODE_ENABLE_TELEMETRY", "DISABLE_TELEMETRY", "DO_NOT_TRACK", "BETA_TRACING_ENDPOINT"])
    assert.equal(hasClaudeTelemetryConfiguration({ [key]: "" }), true, "even empty configured settings remain untouched")
  assert.equal(claudeTelemetryOptionsCompatible({ env: {} }), true)
  assert.equal(claudeTelemetryOptionsCompatible({ env: {}, pathToClaudeCodeExecutable: "/different-native-version" }), false)
  assert.equal(claudeTelemetryOptionsCompatible({ env: {}, settings: "/settings-path" }), false)
  assert.equal(hasClaudeTelemetrySettings({ otelHeadersHelper: "private-command" }), true)
  assert.equal(claudeTelemetryOptionsCompatible({ env: {}, settings: { env: { OTEL_LOGS_EXPORTER: "none" } } }), false)
  console.log("PASS Claude native permissions: exact once/session/decline, no callback inference, scoped retention, lost publication, exporter retry, ambiguity, bounded private data and teardown")
} finally { await observer.dispose(); await rm(root, { recursive: true, force: true }) }

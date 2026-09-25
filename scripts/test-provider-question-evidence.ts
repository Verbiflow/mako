import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { ClaudeApprovalObserver, claudeApprovalAnswerDigest, readClaudeApprovalDecisions } from "../electron/providers/claude/approval-observer.js"
import { DevinApprovalObserver, readDevinApprovalDecisions } from "../electron/providers/devin/approval-observer.js"
import { approvalAnswerDigest } from "../electron/providers/approval-evidence.js"
import { describeApprovalResponse, type NativeApprovalDecision } from "../electron/contracts/approval-response.js"
import type { LivePermissionRequest } from "../electron/shared.js"
import type { SessionNotification, CreateElicitationRequest } from "@agentclientprotocol/sdk"

const root = await mkdtemp(join(tmpdir(), "mako-question-evidence-"))
try {
  const decisions: NativeApprovalDecision[] = []
  const claude = new ClaudeApprovalObserver("session", [], d => decisions.push(d))
  const identity = claude.identify("tool-1")!
  const request: LivePermissionRequest = { id: "host", sessionId: "host", title: "Question", native: identity, options: [], questions: [{ id: "0", header: "Choice", question: "Which?", required: true, isSecret: false, allowOther: true, valueType: "string-array", options: [] }] }
  const answer = { kind: "answers" as const, answers: { "0": ["alpha, beta", "gamma"] } }
  const digest = claudeApprovalAnswerDigest(request, answer)!
  const message = { type: "user", session_id: "session", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "tool-1" }] }, tool_use_result: { questions: [{ question: "Which?" }], answers: { "Which?": "alpha, beta, gamma" } } }
  for (const bad of [ { ...message, session_id: "other" }, { ...message, parent_tool_use_id: "child" }, { ...message, tool_use_result: undefined }, { ...message, message: { content: [{ type: "tool_result", tool_use_id: "newer" }] } } ]) claude.observe(bad)
  assert.equal(decisions.length, 0)
  claude.observe(message)
  assert.equal(decisions[0].answerDigest, digest)
  assert.notEqual(digest, approvalAnswerDigest(answer), "compare provider encoding without guessing comma boundaries")
  const receipt = { id: randomUUID(), origin: { native: identity, nativeRequestId: "callback", bindingId: "binding", epoch: "epoch", generation: 1, connectionGeneration: 1 }, digest: approvalAnswerDigest(answer), nativeAnswerDigest: digest, createdAt: 1, state: { kind: "uncertain" as const, reason: "lost" }, nativeDecision: decisions[0] }
  assert.equal(describeApprovalResponse(receipt).title, "Agent recorded your answer")
  assert.equal(describeApprovalResponse({ ...receipt, nativeAnswerDigest: "0".repeat(64) }).title, "Agent recorded a different decision")
  const ambiguous = new ClaudeApprovalObserver("session", [identity, { ...identity, scope: randomUUID() }], d => decisions.push(d))
  assert.equal(ambiguous.identify("tool-1"), undefined)
  ambiguous.observe(message)
  assert.equal(decisions.length, 1)

  const path = join(root, "claude.jsonl")
  const call = { type: "assistant", sessionId: "session", uuid: "call", parentUuid: null, message: { content: [{ type: "tool_use", id: "tool-1", name: "AskUserQuestion" }] } }
  const result = { type: "user", sessionId: "session", uuid: "result", parentUuid: "call", message: message.message, toolUseResult: message.tool_use_result }
  const head = { type: "last-prompt", sessionId: "session", leafUuid: "result" }
  const write = (entries: unknown[], suffix = "") => writeFile(path, entries.map(e => JSON.stringify(e)).join("\n") + "\n" + suffix)
  await write([call, result, head])
  assert.equal((await readClaudeApprovalDecisions(path, "session", [identity]))[0].answerDigest, digest)
  assert.deepEqual(await readClaudeApprovalDecisions(path, "other", [identity]), [])
  await write([call, result, { ...head, leafUuid: "call" }])
  assert.deepEqual(await readClaudeApprovalDecisions(path, "session", [identity]), [], "discard results outside selected branch")
  await write([call, { ...result, isSidechain: true }, head])
  assert.deepEqual(await readClaudeApprovalDecisions(path, "session", [identity]), [])
  await write([call, result, head], '{"type":')
  assert.deepEqual(await readClaudeApprovalDecisions(path, "session", [identity]), [], "torn history is not complete evidence")
  await write([call, result, result, head])
  await assert.rejects(readClaudeApprovalDecisions(path, "session", [identity]), /repeats/)

  decisions.length = 0
  const devin = new DevinApprovalObserver(d => decisions.push(d))
  const question = { question: "Pick", header: "Choice", options: ["Alpha", "Beta"] }
  const notification: SessionNotification = { sessionId: "session", update: { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Question", _meta: { "cognition.ai/inferenceToolName": "ask_user_question", "cognition.ai/questions": [question] } } }
  const elicitation: CreateElicitationRequest = { mode: "form", sessionId: "session", message: "Pick", requestedSchema: { type: "object", properties: { q0: { type: "string", title: "Choice", description: "Pick", enum: ["Alpha", "Beta"] } }, required: ["q0"] } }
  devin.observe(notification)
  assert.equal(devin.identifyElicitation({ ...elicitation, sessionId: "other" }), undefined)
  const native = devin.identifyElicitation(elicitation)!
  assert.ok(native)
  assert.equal(devin.identifyElicitation(elicitation), undefined, "one occurrence cannot bind two forms")
  const update: SessionNotification = { sessionId: "session", update: { sessionUpdate: "tool_call_update", toolCallId: "call-1", _meta: { "cognition.ai/inferenceToolName": "ask_user_question", "cognition.ai/answers": [{ question_index: 0, selected_options: ["Beta"] }] } } }
  devin.observe({ ...update, sessionId: "other" })
  assert.equal(decisions.length, 0)
  devin.observe(update)
  assert.equal(decisions[0].identity, native)
  assert.equal(decisions[0].answerDigest, approvalAnswerDigest({ kind: "answers", answers: { q0: ["Beta"] } }))
  devin.observe(update)
  assert.equal(decisions.length, 1)
  devin.observe({ ...notification, update: { ...notification.update, toolCallId: "call-2" } })
  devin.observe({ ...notification, update: { ...notification.update, toolCallId: "call-3" } })
  assert.equal(devin.identifyElicitation(elicitation), undefined, "parallel identical forms cannot be guessed")

  const databasePath = join(root, "sessions.db"), db = new DatabaseSync(databasePath)
  db.exec("CREATE TABLE sessions(id TEXT, main_chain_id INTEGER, hidden INTEGER); CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT); INSERT INTO sessions VALUES('session',2,0)")
  const insert = db.prepare("INSERT INTO message_nodes VALUES('session',?,?,?)")
  insert.run(1, null, JSON.stringify({ role: "assistant", tool_calls: [{ id: "call-1", name: "ask_user_question" }] }))
  insert.run(2, 1, JSON.stringify({ role: "tool", tool_call_id: "call-1", metadata: { extensions: { "chisel/user_question_answers": { answers: [{ question_index: 0, selected: ["Beta"] }] } } } }))
  assert.equal(readDevinApprovalDecisions(databasePath + "#session", [native])[0].answerDigest, decisions[0].answerDigest)
  assert.deepEqual(readDevinApprovalDecisions(databasePath + "#other", [native]), [])
  assert.deepEqual(readDevinApprovalDecisions(databasePath + "#session", [native, { ...native, scope: randomUUID() }]), [])
  db.exec("UPDATE sessions SET main_chain_id=1")
  assert.deepEqual(readDevinApprovalDecisions(databasePath + "#session", [native]), [])
  db.exec("UPDATE sessions SET main_chain_id=2; UPDATE message_nodes SET parent_node_id=2 WHERE node_id=1")
  assert.throws(() => readDevinApprovalDecisions(databasePath + "#session", [native]), /cycle/)
  db.close()
  console.log("Provider question evidence: encoded answers, exact session/tool identity, ambiguous forms, selected branches, partial history and cycles passed")
} finally { await rm(root, { recursive: true, force: true }) }

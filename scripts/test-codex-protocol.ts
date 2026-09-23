import { reduceLiveUpdates } from "../electron/contracts/live-content.ts"
import assert from "node:assert/strict"
import { LineAssembler } from "@mako/sessions"
import { spawn } from "node:child_process"
import {
  handleServerRequest,
  resolvePermission,
  resolveServerRequest,
  type PermissionCallbacks,
  type PermissionContext,
} from "../electron/codex-app-permissions.ts"
import {
  boundedText,
  numberValue,
  type JsonObject,
} from "../electron/codex-app-json.ts"
import {
  parseJsonRpcEnvelope,
  parseNotification,
  parseThreadResponse,
  parseSteerResponse,
} from "../electron/codex-app-parse.ts"
import {
  consumeStdout,
  rpcRequest,
  MAX_STDOUT_BUFFER,
  type ProtocolContext,
} from "../electron/codex-app-protocol.ts"
import type {
  LiveSessionState,
  LiveUpdate,
  HostEvent,
} from "../electron/shared.ts"

assert.deepEqual(parseJsonRpcEnvelope("not-json"), { kind: "invalid" })
assert.deepEqual(parseJsonRpcEnvelope("[]"), { kind: "ignored" })
assert.deepEqual(
  parseJsonRpcEnvelope(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "account/read",
      params: { fresh: true },
    })
  ),
  {
    kind: "request",
    id: 7,
    method: "account/read",
    params: { fresh: true },
  }
)
assert.deepEqual(
  parseJsonRpcEnvelope(
    JSON.stringify({ jsonrpc: "2.0", id: "7", result: { ok: true } })
  ),
  { kind: "response", id: "7", result: { ok: true }, error: null }
)
assert.deepEqual(parseSteerResponse({ turnId: "active-turn" }), {
  valid: true,
  value: { turnId: "active-turn" },
})
assert.equal(parseSteerResponse({}).valid, false)
assert.equal(parseSteerResponse({ turnId: "" }).valid, false)
assert.equal(numberValue(Number.NaN), undefined)
assert.equal(boundedText("short", 20), "short")
assert.ok(boundedText("x".repeat(100), 64).includes("output truncated"))

const permissionContext: PermissionContext = {
  id: "permission-test",
  serverRequests: new Map(),
}
const permissionEvents: HostEvent[] = []
const permissionResults: unknown[] = []
const permissionErrors: string[] = []
const permissionCallbacks = {
  emit: (_context, event) => permissionEvents.push(event),
  sendResult: (_context, _id, result) => { permissionResults.push(result); return true },
  sendError: (_context, _id, _code, message) => permissionErrors.push(message),
} satisfies PermissionCallbacks<PermissionContext>
for (const [id, command, reason, title] of [
  ["command-detail", "printf fixture >> /tmp/fixture.txt", "Allow this write?", "printf fixture >> /tmp/fixture.txt"],
  ["reason-only", null, "Allow this operation?", "Allow this operation?"],
] as const) {
  handleServerRequest(permissionContext, permissionCallbacks, id, "item/commandExecution/requestApproval", {
    threadId: "thread-1", turnId: "turn-1", itemId: id, command, reason,
    availableDecisions: ["accept", "decline"],
  })
  const event = permissionEvents.at(-1)
  assert.equal(event?.type, "live-permission")
  if (event?.type === "live-permission") {
    assert.equal(event.request.title, title, "a native reason cannot hide the command being approved")
    assert.deepEqual(event.request.options.map(option => option.kind), ["allow_once", "reject_once"])
  }
}
handleServerRequest(
  permissionContext,
  permissionCallbacks,
  "question-1",
  "item/tool/requestUserInput",
  {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    isBlocking: true,
    questions: [
      {
        id: "environment",
        header: "Environment",
        question: "Which environment?",
        isOther: true,
        isSecret: false,
        options: [
          { label: "Staging", description: "Use the staging deployment" },
        ],
      },
    ],
  }
)
const permissionEvent = permissionEvents.at(-1)
assert.equal(permissionEvent?.type, "live-permission")
if (permissionEvent?.type === "live-permission") {
  assert.equal(permissionEvent.request.questions?.[0]?.allowOther, true)
  assert.equal(
    permissionEvent.request.questions?.[0]?.options[0]?.label,
    "Staging"
  )
}
const pendingQuestion = permissionContext.serverRequests.get("question-1")
assert.ok(pendingQuestion)
assert.deepEqual(resolvePermission(permissionContext, permissionCallbacks, "question-1", { kind: "answers", answers: {} }),
  { kind: "not-submitted", pending: true, reason: "invalid-answer" })
assert.equal(permissionResults.length, 0)
assert.ok(permissionContext.serverRequests.has("question-1"), "invalid answers leave the native request open")
resolvePermission(permissionContext, permissionCallbacks, "question-1", {
  kind: "answers",
  answers: { environment: ["Production"] },
})
assert.deepEqual(permissionResults, [
  { answers: { environment: { answers: ["Production"] } } },
])
assert.deepEqual(permissionErrors, [])
assert.deepEqual(resolvePermission(permissionContext, permissionCallbacks, "question-1", {
  kind: "answers", answers: { environment: ["Production"] },
}), { kind: "not-submitted", pending: false, reason: "request-ended" })
assert.equal(permissionResults.length, 1, "retained correlation must never resend the answer")
resolveServerRequest(permissionContext, permissionCallbacks, "question-1")
assert.deepEqual(permissionEvents.at(-1), { type: "live-permission-ended", id: permissionContext.id,
  requestId: "question-1", observationId: pendingQuestion.observationId, source: "native-resolution" })
const resolvedCount = permissionEvents.length
resolveServerRequest(permissionContext, permissionCallbacks, "question-1")
assert.equal(permissionEvents.length, resolvedCount, "duplicate resolution is ignored")


const parsedThread = parseThreadResponse({
  thread: {
    id: "thread-1",
    cwd: "/tmp/project",
    path: "/custom/codex-home/sessions/native.jsonl",
    turns: [
      {
        id: "turn-1",
        status: "completed",
        error: null,
        items: [
          {
            type: "userMessage",
            id: "user-1",
            content: [{ type: "text", text: "hello" }],
          },
          { type: "agentMessage", id: "agent-1", text: "world" },
          { type: "contextCompaction", id: "compact-1" },
        ],
      },
    ],
  },
  model: "gpt-5",
})
assert.equal(parsedThread.valid, true)
if (parsedThread.valid) {
  assert.equal(parsedThread.value.thread.path, "/custom/codex-home/sessions/native.jsonl", "retain the provider-owned locator instead of waiting for catalog discovery")
  assert.deepEqual(parsedThread.value.thread.turns?.[0]?.items.at(-1), {
    type: "unsupported",
    id: "compact-1",
    sourceType: "contextCompaction",
  })
}
assert.equal(
  parseThreadResponse({ thread: { cwd: "/tmp/project" } }).valid,
  false
)
assert.equal(parseThreadResponse({ thread: { id: "ephemeral", path: null } }).valid, true)
assert.equal(parseThreadResponse({ thread: { id: "legacy" } }).valid, true)
assert.equal(parseThreadResponse({ thread: { id: "invalid", path: 3 } }).valid, false)
assert.equal(
  parseNotification("item/agentMessage/delta", { threadId: "thread-1" }),
  null
)

// A native resume/fork without excludeTurns returns a history frame larger
// than Mako's bound. Exercise the production request builder and framing.
const child = spawn(process.execPath, ["-e", `
  const readline = require("node:readline");
  readline.createInterface({ input: process.stdin }).on("line", line => {
    const request = JSON.parse(line);
    const turns = request.params.excludeTurns === true ? [] : [{
      id: "old-turn", status: "completed", items: [{
        id: "old-answer", type: "agentMessage", text: "x".repeat(9 * 1024 * 1024)
      }]
    }];
    process.stdout.write(JSON.stringify({ id: request.id, result: {
      thread: { id: request.params.threadId, turns }, model: "fixture-model"
    }}) + "\\n");
  });
`], {
  stdio: ["pipe", "pipe", "pipe"],
})
const state: LiveSessionState = {
  id: "session-1",
  harness: "codex",
  cwd: "/tmp/project",
  status: "ready",
  modes: [],
  currentMode: null,
  configOptions: [],
}
const updates: LiveUpdate[] = []
const requests: Array<{
  id: string | number
  method: string
  params: JsonObject
}> = []
const context: ProtocolContext = {
  child,
  threadId: "thread-1",
  currentTurnId: null,
  state,
  nextRequestId: 0,
  pending: new Map(),
  items: new Map(),
  stdoutLines: new LineAssembler(MAX_STDOUT_BUFFER),
  exited: false,
  protocol: {
    observeAgents: () => {},
    handleFatal(message) {
      throw new Error(message)
    },
    updateState(patch) {
      Object.assign(state, patch)
    },
    emitUpdate(update) {
      updates.push(update)
    },
    handleServerRequest(id, method, params) {
      requests.push({ id, method, params })
    },
    resolveServerRequest() {},
    clearTurnServerRequests() {},
  },
}

const request = `${JSON.stringify({ id: 4, method: "approval/request", params: { reason: "test" } })}\n`
consumeStdout(context, Buffer.from(request.slice(0, 12)))
assert.equal(requests.length, 0)
consumeStdout(context, Buffer.from(request.slice(12)))
assert.equal(requests[0]?.method, "approval/request")

consumeStdout(
  context,
  Buffer.from(
    `${JSON.stringify({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } })}\n`
  )
)
assert.equal(context.currentTurnId, "turn-1")
assert.equal(state.status, "running")
const childTurns: string[] = []
context.protocol.observeAgentTurn = (nativeId) => childTurns.push(nativeId)
consumeStdout(context, Buffer.from(JSON.stringify({ method: "turn/completed", params: {
  threadId: "child-thread", turn: { id: "child-turn", status: "completed", error: null, items: [] },
} }) + "\n"))
assert.deepEqual(childTurns, ["child-thread"])
assert.equal(context.currentTurnId, "turn-1", "Child turn events never settle the parent")
assert.equal(state.status, "running")


consumeStdout(
  context,
  Buffer.from(
    `${JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1", delta: "hello" } })}\n`
  )
)
assert.deepEqual(updates.at(-1), {
  kind: "text",
  id: "codex:turn-1:agent-1",
  text: "hello",
})

const confirmation: JsonObject = {
  threadId: "thread-1",
  turnId: "turn-1",
  serverName: "fixture",
  mode: "form",
  message: "Allow the fixture tool?",
  meta: { codex_approval_kind: "mcp_tool_call" },
  requestedSchema: { type: "object", properties: {}, required: [] },
}
handleServerRequest(
  permissionContext,
  permissionCallbacks,
  "confirm",
  "mcpServer/elicitation/request",
  confirmation
)
const confirmationEvent = permissionEvents.at(-1)
assert.ok(confirmationEvent?.type === "live-permission")
assert.ok(
  confirmationEvent.request.options.some(
    (option) => option.kind === "allow_once"
  )
)
resolvePermission(permissionContext, permissionCallbacks, "confirm", {
  kind: "choice",
  optionId: "accept",
})
assert.deepEqual(permissionResults.at(-1), {
  action: "accept",
  content: {},
  _meta: null,
})
for (const patch of [
  { mode: "url" },
  { meta: {} },
  {
    requestedSchema: {
      type: "object",
      properties: { secret: { type: "string" } },
      required: ["secret"],
    },
  },
]) {
  handleServerRequest(
    permissionContext,
    permissionCallbacks,
    "unsupported",
    "mcpServer/elicitation/request",
    { ...confirmation, ...patch }
  )
  const event = permissionEvents.at(-1)
  assert.ok(event?.type === "live-permission")
  assert.equal(
    event.request.options.some((option) => option.kind === "allow_once"),
    false
  )
  resolvePermission(permissionContext, permissionCallbacks, "unsupported", {
    kind: "choice",
    optionId: "decline",
  })
  assert.deepEqual(permissionResults.at(-1), {
    action: "decline",
    content: null,
    _meta: null,
  })
}
assert.equal(state.nativeRunId, "turn-1")

const compactResults: Array<{ actionId: string; result: unknown }> = []
context.protocol.actionResult = (actionId, result) => compactResults.push({ actionId, result })
const notify = (method: string, params: JsonObject) => consumeStdout(context, Buffer.from(`${JSON.stringify({ method, params })}\n`))
for (const confirmed of [false, true]) {
  context.compaction = { actionId: "compact-action", confirmed: false }
  notify("turn/started", { threadId: "thread-1", turn: { id: "compact-turn" } })
  notify("turn/completed", { threadId: "different-thread", turn: { id: "compact-turn", status: "completed", error: null, items: [] } })
  assert.ok(context.compaction, "another thread cannot complete compaction")
  if (confirmed) notify("item/completed", { threadId: "thread-1", turnId: "compact-turn", item: { type: "contextCompaction", id: "boundary" } })
  notify("turn/completed", { threadId: "thread-1", turn: { id: "compact-turn", status: "completed", error: null, items: [] } })
  assert.equal(compactResults.at(-1)?.actionId, "compact-action")
  assert.deepEqual(compactResults.at(-1)?.result, confirmed ? { kind: "completed" } :
    { kind: "uncertain", reason: "The provider ended the turn without confirming compaction." })
  assert.equal(context.compaction, undefined)
}
console.log("PASS: Codex compaction requires the matching turn and native compaction boundary")

assert.throws(() => consumeStdout({
  ...context,
  stdoutLines: new LineAssembler(MAX_STDOUT_BUFFER),
}, Buffer.alloc(MAX_STDOUT_BUFFER + 1, 120)), /oversized JSON-RPC/)
child.stdout.on("data", (chunk: Buffer) => consumeStdout(context, chunk))
for (const method of ["thread/resume", "thread/fork"] as const) {
  const reopened = await rpcRequest(context, method, {
    threadId: "large-history-thread",
    lastTurnId: "old-turn",
    cwd: "/tmp/project",
  })
  assert.equal(reopened.thread.id, "large-history-thread")
  assert.deepEqual(reopened.thread.turns, [])
  assert.equal(reopened.model, "fixture-model")
}
child.kill("SIGTERM")
console.log("PASS: resume and fork omit oversized history without changing native identity")
console.log("Codex JSON-RPC parsing, framing, and streaming checks passed")

for (const notification of [
  {
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "plan-turn",
      item: { type: "plan", id: "proposal", text: "" },
    },
  },
  {
    method: "item/plan/delta",
    params: {
      threadId: "thread-1",
      turnId: "plan-turn",
      itemId: "proposal",
      delta: "# Initial plan",
    },
  },
  {
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "plan-turn",
      item: {
        type: "plan",
        id: "proposal",
        text: "# Revised plan\n\nKeep the public API.",
      },
    },
  },
])
  consumeStdout(context, Buffer.from(`${JSON.stringify(notification)}\n`))
const proposals = reduceLiveUpdates([], updates).filter(
  (block) => block.type === "proposed-plan"
)
assert.equal(proposals.length, 1)
assert.equal(proposals[0]?.text, "# Revised plan\n\nKeep the public API.")
assert.equal(proposals[0]?.status, "proposed")
console.log(
  "PASS: Codex proposed-plan deltas and final replacements preserve one plan artifact"
)

assert.deepEqual(resolvePermission(permissionContext, permissionCallbacks, "absent", { kind: "choice", optionId: null }),
  { kind: "not-submitted", pending: false, reason: "request-ended" })
permissionContext.serverRequests.set("write-failed", { ...pendingQuestion, answered: false })
assert.equal(resolvePermission(permissionContext, { ...permissionCallbacks, sendResult: () => false }, "write-failed", {
  kind: "answers", answers: { environment: ["Staging"] },
}).kind, "uncertain", "a failed pipe write is never a submitted receipt")
console.log("PASS: Codex approval missing request, validation refusal and unconfirmed write evidence")

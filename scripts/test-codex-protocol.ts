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
  retainStoppedTurn,
  rpcRequest,
  MAX_STDOUT_BUFFER,
  CodexDecoder,
  type ProtocolContext,
} from "../electron/codex-app-protocol.ts"
import type {
  LiveSessionState,
  LiveUpdate,
  HostEvent,
} from "../electron/shared.ts"
import type { TranscriptEvent } from "@mako/sessions/events"
import type { UsageWindow } from "../electron/account-types.ts"

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
    type: "contextCompaction",
    id: "compact-1",
  })
}
assert.equal(
  parseThreadResponse({ thread: { cwd: "/tmp/project" } }).valid,
  false
)
assert.equal(parseThreadResponse({ thread: { id: "ephemeral", path: null } }).valid, true)
assert.equal(parseThreadResponse({ thread: { id: "legacy" } }).valid, true)
const effectivePolicy = parseThreadResponse({ thread: { id: "native-full" }, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" } })
assert.ok(effectivePolicy.valid)
if (effectivePolicy.valid) {
  assert.equal(effectivePolicy.value.approvalPolicy, "on-request")
  assert.equal(effectivePolicy.value.approvalsReviewer, "user")
  assert.deepEqual(effectivePolicy.value.sandbox, { type: "dangerFullAccess" }, "Native policy must survive the parser before it reaches the picker")
}

assert.equal(parseThreadResponse({ thread: { id: "invalid", path: 3 } }).valid, false)
const futurePolicy = parseThreadResponse({ thread: { id: "future-policy" }, sandbox: { type: "futureSandbox" }, approvalPolicy: "on-request" })
assert.ok(futurePolicy.valid)
if (futurePolicy.valid) assert.equal(futurePolicy.value.sandbox, undefined)

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
    if (request.method === "thread/backgroundTerminals/list")
      return process.stdout.write(JSON.stringify({ id: request.id, result: { data: [], nextCursor: null } }) + "\\n");
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
  decoder: new CodexDecoder({ threadId: "thread-1", state }),
  background: { running: new Set() },
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

const limits: UsageWindow[][] = []
context.protocol.usage = (windows) => limits.push(windows)
const spent = { rateLimits: { limitId: "codex", primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: 1_900_000_000 } } }
notify("account/rateLimits/updated", spent)
assert.deepEqual(limits, [[{ usedPercent: 41, windowMinutes: 300, resetsAt: 1_900_000_000_000 }]],
  "the account's limits go to the account, not the ignore list")
context.protocol.usage = undefined
console.log("PASS: Codex rate-limit updates reach the account")

const activities: unknown[] = []
const unhandled: string[] = []
let compactions = 0
context.protocol.activity = (activity) => activities.push(activity)
context.protocol.compacted = () => compactions++
context.protocol.unhandled = (kind) => unhandled.push(kind)
notify("turn/started", { threadId: "thread-1", turn: { id: "quiet-turn" } })
notify("item/started", { threadId: "thread-1", turnId: "quiet-turn", item: { type: "contextCompaction", id: "auto" } })
notify("item/completed", { threadId: "thread-1", turnId: "quiet-turn", item: { type: "contextCompaction", id: "auto" } })
notify("error", { threadId: "thread-1", turnId: "quiet-turn", willRetry: true, error: { message: "Reconnecting... 2/5" } })
assert.equal(state.error, undefined, "a retried error is not the turn's error")
notify("error", { threadId: "thread-1", turnId: "quiet-turn", willRetry: false, error: { message: "stream disconnected" } })
assert.equal(state.error, "stream disconnected")
notify("future/notification", { threadId: "thread-1" })
notify("item/started", { threadId: "thread-1", turnId: "quiet-turn", item: { type: "futureItem", id: "future" } })
assert.deepEqual(activities, [{ kind: "compacting" }, { kind: "retrying", attempt: 2, maxAttempts: 5 }])
assert.equal(compactions, 1)
assert.deepEqual(unhandled, ["future/notification", "item/futureItem"])
notify("turn/completed", { threadId: "thread-1", turn: { id: "quiet-turn", status: "completed", error: null, items: [] } })
state.error = undefined
console.log("PASS: Codex reports compaction and retries as activity, a retried error as no failure, and unknown events")

{
  const markers: TranscriptEvent[] = []
  const patches: Array<Partial<LiveSessionState>> = []
  const updateState = context.protocol.updateState
  const markerIds: (string | undefined)[] = []
  context.protocol.event = (marker, id) => {
    markers.push(marker)
    markerIds.push(id)
  }
  context.protocol.updateState = (patch) => { patches.push(patch); updateState(patch) }
  activities.length = 0
  unhandled.length = 0
  updates.length = 0
  notify("turn/started", { threadId: "thread-1", turn: { id: "notice-turn" } })
  patches.length = 0

  const usage = (totalTokens: number, modelContextWindow: number | null) =>
    notify("thread/tokenUsage/updated", { threadId: "thread-1", turnId: "notice-turn", tokenUsage: {
      total: { totalTokens: 900_000 }, last: { totalTokens }, modelContextWindow,
    } })
  usage(120_000, null)
  assert.equal(state.usage, undefined, "no meter without a known window")
  usage(120_000, 400_000)
  usage(120_000, 400_000)
  assert.deepEqual(state.usage, { used: 120_000, size: 400_000 }, "the meter reads the latest request, not the thread total")
  assert.equal(patches.filter((patch) => patch.usage).length, 1, "an unchanged reading is not reported again")

  notify("warning", { threadId: "thread-1", message: "Heads up: long threads can be less accurate." })
  notify("warning", { threadId: "thread-1", message: "Heads up: long threads can be less accurate." })
  notify("guardianWarning", { threadId: "thread-1", message: "Automatic approval review approved (risk: low, authorization: high): fine" })
  notify("guardianWarning", { threadId: "thread-1", message: "Automatic approval review denied (risk: high, authorization: low): writes outside the project" })
  notify("configWarning", { summary: "Unknown key `foo`", details: "Remove it from config.toml", path: "/tmp/config.toml" })
  notify("configWarning", { summary: "Unknown key `foo`", details: "Remove it from config.toml", path: "/tmp/config.toml" })
  notify("deprecationNotice", { summary: "`--full-auto` is deprecated", details: null })
  notify("model/rerouted", { threadId: "thread-1", turnId: "notice-turn", fromModel: "gpt-5.5", toModel: "gpt-5.4", reason: "highRiskCyberActivity" })
  notify("mcpServer/startupStatus/updated", { threadId: null, name: "linear", status: "starting", error: null, failureReason: null })
  notify("mcpServer/startupStatus/updated", { threadId: null, name: "linear", status: "failed", error: null, failureReason: "reauthenticationRequired" })
  notify("item/completed", { threadId: "thread-1", turnId: "notice-turn", item: { type: "enteredReviewMode", id: "review-in", review: "current changes" } })
  notify("item/completed", { threadId: "thread-1", turnId: "notice-turn", item: { type: "exitedReviewMode", id: "review-out", review: "No issues found.\n\nThe change is correct." } })
  assert.deepEqual(markers, [
    { label: "Warning", detail: "Heads up: long threads can be less accurate.", tone: "warning" },
    { label: "Warning", detail: "Automatic approval review denied (risk: high, authorization: low): writes outside the project", tone: "warning" },
    { label: "Warning", detail: "Unknown key `foo`", body: "Remove it from config.toml", tone: "warning", setup: true },
    { label: "Warning", detail: "`--full-auto` is deprecated", tone: "warning", setup: true },
    { label: "Model changed", detail: "gpt-5.5 → gpt-5.4 · cybersecurity safety check" },
    { label: "MCP server failed", detail: "linear · sign-in required", tone: "warning", setup: true },
    { label: "Review mode started", detail: "current changes" },
    { label: "Review mode ended", body: "No issues found.\n\nThe change is correct." },
  ], "each notice is marked once, in Mako's words")
  markers.length = 0
  markerIds.length = 0

  notify("model/safetyBuffering/updated", { threadId: "thread-1", turnId: "other-turn", model: "gpt-5.5", useCases: [], reasons: [], showBufferingUi: true, fasterModel: null })
  notify("model/safetyBuffering/updated", { threadId: "thread-1", turnId: "notice-turn", model: "gpt-5.5", useCases: [], reasons: [], showBufferingUi: true, fasterModel: null })
  notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "notice-turn", itemId: "answer", delta: "Checked." })
  notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "notice-turn", itemId: "answer", delta: " Still checked." })
  notify("item/autoApprovalReview/started", { threadId: "thread-1", turnId: "notice-turn", reviewId: "r1" })
  notify("item/autoApprovalReview/completed", { threadId: "thread-1", turnId: "notice-turn", reviewId: "r1" })
  notify("modelProvider/authRecoveryStarted", { threadId: "thread-1", turnId: "notice-turn", provider: "openai", message: "Refreshing" })
  notify("modelProvider/authRecoveryCompleted", { threadId: "thread-1", turnId: "notice-turn", provider: "openai", message: "Done" })
  notify("item/started", { threadId: "thread-1", turnId: "notice-turn", item: { type: "contextCompaction", id: "auto-2" } })
  notify("item/autoApprovalReview/completed", { threadId: "thread-1", turnId: "notice-turn", reviewId: "stale" })
  notify("modelProvider/authRecoveryCompleted", { threadId: "thread-1", turnId: "notice-turn", provider: "openai", message: "Done" })
  assert.deepEqual(activities, [
    { kind: "waiting", label: "Checking the response" }, null,
    { kind: "waiting", label: "Reviewing the approval" }, null,
    { kind: "waiting", label: "Refreshing sign-in" }, null,
    { kind: "compacting" },
  ], "a wait ends with its own end or the output it held, and never ends compaction")
  activities.length = 0
  const compacted: unknown[] = []
  context.protocol.compacted = (compaction, id) => compacted.push([compaction, id])
  usage(9_000, 400_000)
  notify("item/completed", { threadId: "thread-1", turnId: "notice-turn", item: { type: "contextCompaction", id: "auto-2" } })
  assert.deepEqual(compacted, [[{ tokensBefore: 120_000, tokensAfter: 9_000 }, "auto-2"]],
    "the marker counts from where compaction started to Codex's estimate after it, and is named by Codex's item")

  notify("error", { threadId: "thread-1", turnId: "notice-turn", willRetry: true, error: {
    message: "Selected model is at capacity.", codexErrorInfo: "serverOverloaded", additionalDetails: null,
  } })
  notify("error", { threadId: "thread-1", turnId: "notice-turn", willRetry: true, error: {
    message: "Reconnecting... 3/5", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } }, additionalDetails: "unexpected status 503",
  } })
  notify("error", { threadId: "thread-1", turnId: "notice-turn", willRetry: true, error: {
    message: "Reconnecting... waiting for network", codexErrorInfo: null, additionalDetails: null,
  } })
  assert.deepEqual(activities, [
    { kind: "retrying", reason: "Server overloaded" },
    { kind: "retrying", attempt: 3, maxAttempts: 5 },
    { kind: "retrying", reason: "Waiting for network" },
  ])

  for (const method of ["thread/status/changed", "account/rateLimits/updated", "turn/diff/updated", "thread/compacted", "hook/started", "rawResponseItem/completed"])
    notify(method, { threadId: "thread-1" })
  notify("item/started", { threadId: "thread-1", turnId: "notice-turn", item: { type: "commandExecution", id: "broken" } })
  notify("item/started", { threadId: "thread-1", turnId: "notice-turn", item: { type: "hookPrompt", id: "hook", fragments: [] } })
  assert.deepEqual(unhandled, ["item/commandExecution/invalid"], "bookkeeping is known and quiet; a broken known item names itself")

  notify("thread/name/updated", { threadId: "thread-1", threadName: "Fix the flaky test" })
  assert.equal(state.title, "Fix the flaky test")

  updates.length = 0
  notify("item/started", { threadId: "thread-1", turnId: "notice-turn", item: { type: "webSearch", id: "search", query: "", action: null, results: null } })
  notify("item/completed", { threadId: "thread-1", turnId: "notice-turn", item: {
    type: "webSearch", id: "search", query: "electron utility process", action: { type: "search", query: "electron utility process", queries: null }, results: null,
  } })
  notify("item/completed", { threadId: "thread-1", turnId: "notice-turn", item: { type: "sleep", id: "nap", durationMs: 90_000 } })
  notify("item/completed", { threadId: "thread-1", turnId: "notice-turn", item: {
    type: "mcpToolCall", id: "mcp", server: "linear", tool: "get_issue", status: "completed", arguments: { id: "MAK-1" }, result: null, error: null,
  } })
  notify("item/completed", { threadId: "thread-1", turnId: "notice-turn", item: {
    type: "fileChange", id: "edit", status: "completed", changes: [
      { path: "/tmp/project/new.ts", kind: { type: "add" }, diff: "export {}\n" },
      { path: "/tmp/project/old.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b\n" },
    ],
  } })
  const tools = reduceLiveUpdates([], updates).filter((block) => block.type === "tool")
  assert.deepEqual(tools.map((tool) => [tool.title, tool.name, tool.status]), [
    ["electron utility process", "web_search", "completed"],
    ["Sleep 1m 30s", "sleep", "completed"],
    ["linear: get_issue", "mcp__linear__get_issue", "completed"],
    ["Edit /tmp/project/new.ts, /tmp/project/old.ts", "apply_patch", "completed"],
  ])
  assert.equal(tools[0]?.input, JSON.stringify({ type: "search", query: "electron utility process", queries: null }, null, 2))
  assert.equal(tools[2]?.input, JSON.stringify({ id: "MAK-1" }, null, 2), "an MCP row shows what it was called with")
  assert.equal(tools[3]?.output, "Add /tmp/project/new.ts\n+export {}\n\nUpdate /tmp/project/old.ts\n@@ -1 +1 @@\n-a\n+b", "edits read as a patch, not JSON")

  notify("item/reasoning/summaryTextDelta", { threadId: "thread-1", turnId: "notice-turn", itemId: "why", delta: "First part." })
  notify("item/reasoning/summaryPartAdded", { threadId: "thread-1", turnId: "notice-turn", itemId: "why", summaryIndex: 1 })
  notify("item/reasoning/summaryTextDelta", { threadId: "thread-1", turnId: "notice-turn", itemId: "why", delta: "Second part." })
  assert.equal(reduceLiveUpdates([], updates).findLast((block) => block.type === "thinking")?.text, "First part.\n\nSecond part.")

  notify("turn/completed", { threadId: "thread-1", turn: { id: "notice-turn", status: "failed", items: [], error: {
    message: "You've hit your usage limit. Try again at 6:26 PM.", codexErrorInfo: "usageLimitExceeded", additionalDetails: null,
  } } })
  assert.deepEqual(markers, [{ label: "Turn failed", detail: "Usage limit reached", body: "You've hit your usage limit. Try again at 6:26 PM.", tone: "error" }])
  assert.deepEqual(markerIds, ["notice-turn:failed"], "a turn's failure is named by its turn, so a replayed completion is drawn once")
  assert.equal(state.status, "failed")
  context.protocol.updateState = updateState
  context.protocol.event = undefined
  Object.assign(state, { error: undefined, status: "ready" })
  console.log("PASS: Codex usage, notices, waits, error classes, ignored bookkeeping and new item rows reach Mako's vocabulary")
}

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

// Stop ownership follows native turn/terminal IDs even when command startup
// arrives after interruption. Repeated notifications must not repeat mutation.
{
  const terminal = spawn(process.execPath, ["-e", `
    require("node:readline").createInterface({input:process.stdin}).on("line", line => {
      const request = JSON.parse(line);
      process.stdout.write(JSON.stringify({id:request.id,result:{terminated:request.params.processId !== "refused",seen:request}})+"\\n");
    });
  `], { stdio: ["pipe", "pipe", "pipe"] })
  const seen: Array<{method: string; params: {threadId: string; processId: string}}> = []
  const failures: string[] = []
  const localState = { ...state, backgroundTasks: 0 }
  const late: ProtocolContext = { ...context, child: terminal, pending: new Map(), state: localState,
    decoder: new CodexDecoder({threadId:"thread-1",state:localState}),
    stdoutLines: new LineAssembler(MAX_STDOUT_BUFFER), background: {running:new Set()},
    protocol: {...context.protocol, updateState: patch => Object.assign(localState,patch), handleFatal: message => failures.push(message)} }
  terminal.stdout.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split("\n")) seen.push(JSON.parse(line).result.seen)
    consumeStdout(late, chunk)
  })
  const command = (threadId: string, turnId: string, processId: string) => consumeStdout(late,Buffer.from(JSON.stringify({method:"item/started",params:{threadId,turnId,item:{type:"commandExecution",id:`item-${turnId}`,processId,command:"fixture",cwd:"/tmp",status:"inProgress",aggregatedOutput:null,exitCode:null}}})+"\n"))
  const wait = async (done: () => boolean) => {
    for (let i=0;i<200&&!done();i++) await new Promise(resolve=>setTimeout(resolve,5))
    assert.ok(done())
  }
  try {
    retainStoppedTurn(late,"stopped")
    command("thread-1","stopped","native-17")
    command("thread-1","stopped","native-17")
    command("thread-1","next-turn","native-18")
    await wait(()=>seen.length===1&&localState.backgroundTasks===0)
    assert.deepEqual(seen.map(call=>({method:call.method,params:call.params})),[{method:"thread/backgroundTerminals/terminate",params:{threadId:"thread-1",processId:"native-17"}}])
    retainStoppedTurn(late,"child-stopped")
    command("child-thread","child-stopped","native-17")
    await wait(()=>seen.length===2)
    assert.equal(seen[1]?.params.threadId,"child-thread","child cleanup never targets the root thread")
    retainStoppedTurn(late,"reused-id")
    command("thread-1","reused-id","native-17")
    await wait(()=>seen.length===3)
    retainStoppedTurn(late,"failed-stop")
    command("thread-1","failed-stop","refused")
    await wait(()=>failures.length===1)
    assert.match(failures[0]!,/not ended/)
    assert.equal(seen.length,4,"a refused native mutation is not automatically retried")
    for (let i=0;i<508;i++) retainStoppedTurn(late,`bounded-${i}`)
    assert.throws(()=>retainStoppedTurn(late,"overflow"),/bound/)
    assert.ok(late.stoppedTurns?.has("stopped"),"bounded Stop evidence never evicts a turn that may still emit commands")
  } finally { terminal.kill("SIGTERM") }
  console.log("PASS: Late stopped-turn commands use exact native IDs once, child scope and reused IDs hold, new turns are untouched, refusal and evidence bounds fail explicitly")
}

// A terminal a turn left running keeps the session busy until Codex completes
// its item. A completion that races the list must not be counted again.
{
  const terminals = spawn(process.execPath, ["-e", `
    const readline = require("node:readline");
    const held = [];
    readline.createInterface({ input: process.stdin }).on("line", line => {
      const message = JSON.parse(line);
      if (message.release) {
        for (const id of held.splice(0)) process.stdout.write(JSON.stringify({ id, result: {
          data: [{ itemId: "bg-1", processId: "1", command: "sleep 60", cwd: "/tmp" }, { itemId: "bg-2", processId: "2", command: "sleep 1", cwd: "/tmp" }],
          nextCursor: null,
        }}) + "\\n");
      } else if (message.method === "thread/backgroundTerminals/list") held.push(message.id);
    });
  `], { stdio: ["pipe", "pipe", "pipe"] })
  const backgroundState: LiveSessionState = { ...state, id: "background", status: "running" }
  const background: ProtocolContext = {
    ...context,
    child: terminals,
    state: backgroundState,
    threadId: "thread-bg",
    pending: new Map(),
    decoder: new CodexDecoder({ threadId: "thread-bg", state: backgroundState }),
    background: { running: new Set() },
    stdoutLines: new LineAssembler(MAX_STDOUT_BUFFER),
    protocol: { ...context.protocol, updateState: (patch) => Object.assign(backgroundState, patch) },
  }
  terminals.stdout.on("data", (chunk: Buffer) => consumeStdout(background, chunk))
  const notify = (method: string, params: JsonObject) =>
    consumeStdout(background, Buffer.from(`${JSON.stringify({ method, params })}\n`))
  const settled = async (count: number) => {
    for (let attempt = 0; attempt < 200 && (backgroundState.backgroundTasks ?? 0) !== count; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(backgroundState.backgroundTasks ?? 0, count)
  }
  const ended = (id: string) => notify("item/completed", { threadId: "thread-bg", turnId: "turn-bg", item: {
    type: "commandExecution", id, command: "sleep", cwd: "/tmp", status: "completed", aggregatedOutput: "", exitCode: 0,
  } })
  notify("turn/completed", { threadId: "thread-bg", turn: { id: "turn-bg", status: "completed", error: null, items: [] } })
  assert.equal(backgroundState.status, "ready")
  ended("bg-2")
  terminals.stdin.write(`${JSON.stringify({ release: true })}\n`)
  await settled(1)
  assert.deepEqual([...background.background.running], ["bg-1"], "a completion that raced the list is not counted")
  ended("bg-1")
  await settled(0)
  terminals.kill("SIGTERM")
  console.log("PASS: Codex background terminals keep the session busy until their items complete")
}

// A turn/start the app-server is slow to answer may already be running its
// turn, so it has no deadline; other requests keep theirs.
{
  const silent = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "pipe", "pipe"] })
  const slow: ProtocolContext = { ...context, child: silent, pending: new Map(), stdoutLines: new LineAssembler(MAX_STDOUT_BUFFER) }
  const started = rpcRequest(slow, "turn/start", { threadId: "thread-1", input: [] }).catch(() => {})
  const listed = rpcRequest(slow, "thread/backgroundTerminals/list", { threadId: "thread-1" }).catch(() => {})
  const [turnStart, other] = [...slow.pending.values()]
  assert.equal(turnStart?.method, "turn/start")
  assert.equal(turnStart?.timer, undefined, "turn/start waits for the app-server or its exit")
  assert.ok(other?.timer, "an ordinary request still has a deadline")
  for (const pending of slow.pending.values()) {
    clearTimeout(pending.timer)
    pending.reject(new Error("fixture ended"))
  }
  await Promise.all([started, listed])
  silent.kill("SIGTERM")
  console.log("PASS: Codex turn/start outlives the request deadline")
}

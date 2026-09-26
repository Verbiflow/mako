import type { PromptDeliveryEvidence } from "../electron/contracts/prompt-delivery.ts"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type {
  SDKMessage,
  SDKUserMessage,
  SDKAssistantMessage,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk"
import {
  createClaudeSdkDriver,
  type ClaudeSdkDependencies,
} from "../electron/providers/claude/sdk-driver.ts"
import { claudeExecutablePath } from "../electron/providers/claude/sdk-process.ts"
import { ClaudeProjection } from "../electron/providers/claude/sdk-projection.ts"
import { ClaudeInput } from "../electron/providers/claude/input.ts"
import { ClaudePermissions } from "../electron/providers/claude/sdk-permissions.ts"
import { ClaudeTranscript } from "../electron/providers/claude/sdk-transcript.ts"
import type { LiveDriverEvent } from "../electron/shared.ts"
import { claudeAuthDiagnostics } from "../electron/providers/claude/auth-diagnostics.ts"
import { installHostLog, flushHostLog, type HostLogFields } from "../electron/host-log.ts"

const authLogRoot = await mkdtemp(join(tmpdir(), "mako-claude-auth-diagnostics-"))
installHostLog(join(authLogRoot, "host.log"))
const authDiagnostics: HostLogFields[] = []
const diagnostic = claudeAuthDiagnostics({
  HOME: "/private-user-home", CLAUDE_CONFIG_DIR: "/private-router-scope",
  CLAUDE_SECURESTORAGE_CONFIG_DIR: "", ANTHROPIC_API_KEY: "secret-api-key",
  ANTHROPIC_AUTH_TOKEN: "secret-auth-token", CLAUDE_CODE_OAUTH_TOKEN: "secret-oauth-token",
  ANTHROPIC_BASE_URL: "https://private-server/token=secret",
}, fields => authDiagnostics.push(fields))
const refreshFailure = "Failed to authenticate: OAuth session expired and could not be refreshed"
diagnostic.failure(`A user wrote: ${refreshFailure}`)
assert.equal(authDiagnostics.length, 0, "ordinary prose must not become native auth evidence")
diagnostic.failure(refreshFailure)
diagnostic.failure(refreshFailure)
assert.equal(authDiagnostics.length, 1, "repeated native errors cannot flood the log")
assert.equal(authDiagnostics[0]?.secureStorageOverride, true, "empty native override is meaningful")
assert.equal(authDiagnostics[0]?.apiKeyOverride, true)
assert.equal(authDiagnostics[0]?.category, "native-refresh-unavailable")
for (const secret of ["private-user", "private-router", "secret-api", "secret-auth", "secret-oauth", "private-server"])
  assert.ok(!JSON.stringify(authDiagnostics).includes(secret), "diagnostics must not retain secrets or raw source paths")
let inheritedScope: HostLogFields | undefined
claudeAuthDiagnostics({ CLAUDE_CONFIG_DIR: "/private-router-scope" }, fields => { inheritedScope = fields }).failure(refreshFailure)
assert.notEqual(inheritedScope?.secureStorageScope, authDiagnostics[0]?.secureStorageScope)

class Messages implements AsyncIterable<SDKMessage> {
  private readonly items: SDKMessage[] = []
  private wake: (() => void) | undefined
  private closed = false
  send(message: SDKMessage) {
    this.items.push(message)
    this.wake?.()
  }
  close() {
    this.closed = true
    this.wake?.()
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    while (!this.closed) {
      const message = this.items.shift()
      if (message) yield message
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
    }
  }
}
const events: LiveDriverEvent[] = []
const output = new Messages()
let input: AsyncIterator<SDKUserMessage> | undefined
let closed = false
const dependencies: ClaudeSdkDependencies = {
  available: () => true,
  configure: async () => ({}),
  receiptTimeoutMs: 20,
  interruptTimeoutMs: 20,
  query: (options) => {
    input = options.prompt[Symbol.asyncIterator]()
    return {
      [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
      initializationResult: async () => ({
        commands: [],
        agents: [],
        output_style: "default",
        available_output_styles: [],
        models: [],
        account: {},
      }),
      setModel: async () => {},
      applyFlagSettings: async () => {},
      setPermissionMode: async () => {},
      interrupt: () => new Promise(() => {}),
      close: () => {
        closed = true
        output.close()
      },
    }
  },
}
const driver = createClaudeSdkDriver(dependencies)
await driver.start("/tmp", {
  conversationId: "sdk-fixture",
  emit: (event) => events.push(event),
})
const delivery: PromptDeliveryEvidence[] = []
const attemptId = randomUUID()
await driver.prompt("sdk-fixture", "Begin", [], undefined, { operationId: randomUUID(), attemptId, report: (evidence) => delivery.push(evidence) })
assert.equal(delivery.at(-1)?.kind, "submitted", "SDK enqueue does not acknowledge delivery")
const original = await input?.next()
assert.equal(original?.value?.message.content[0].text, "Begin")
assert.equal(original?.value?.uuid, attemptId)
assert.ok(original?.value)
output.send({ ...original.value, uuid: randomUUID() })
await new Promise<void>((resolve) => setImmediate(resolve))
assert.equal(delivery.at(-1)?.kind, "submitted", "unrelated native echo cannot acknowledge input")
output.send(original.value)
await new Promise<void>((resolve) => setImmediate(resolve))
assert.deepEqual(delivery.at(-1), { kind: "accepted", source: "native-echo", referenceId: attemptId })
const running = events.findLast(
  (event) => event.type === "live-session" && event.session.status === "running"
)
assert.ok(running?.type === "live-session" && running.session.nativeRunId)
assert.ok(driver.steer)
assert.deepEqual(
  await driver.steer("sdk-fixture", {
    id: "stale",
    expectedRunId: "stale",
    text: "Wrong turn",
    attachments: [],
  }),
  { kind: "not-accepted", reason: "The Claude turn has already changed" }
)
const receipt = driver.steer("sdk-fixture", {
  id: "one",
  expectedRunId: running.session.nativeRunId,
  text: "Steer",
  attachments: [],
})
const steering = await input?.next()
assert.ok(steering && !steering.done)
assert.equal(steering.value.priority, "now")
output.send(steering.value)
assert.deepEqual(await receipt, { kind: "accepted" })
const missing = driver.steer("sdk-fixture", {
  id: "two",
  expectedRunId: running.session.nativeRunId,
  text: "Unknown",
  attachments: [],
})
await assert.rejects(missing, /not confirmed steering/)
await assert.rejects(driver.cancel("sdk-fixture"), /interrupt timed out/)
assert.equal(closed, true)
assert.equal(
  events.findLast((event) => event.type === "live-session")?.type,
  "live-session"
)
await assert.rejects(
  driver.prompt("sdk-fixture", "After stop", [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} }),
  /disconnected/
)

let configured: (() => void) | undefined
let launched = false
const racing = createClaudeSdkDriver({
  ...dependencies,
  configure: async () => {
    await new Promise<void>((resolve) => {
      configured = resolve
    })
    return {}
  },
  query: (options) => {
    launched = true
    return dependencies.query(options)
  },
})
const starting = racing.start("/tmp", {
  conversationId: "closing",
  emit: () => {},
})
racing.close("closing")
configured?.()
await assert.rejects(starting, /closed while configuring/)
assert.equal(launched, false)

const permissionEvents: LiveDriverEvent[] = []
const permissions = new ClaudePermissions("permission-fixture", (event) =>
  permissionEvents.push(event)
)
const options = {
  signal: new AbortController().signal,
  toolUseID: "tool",
  requestId: "permission",
}
const question = permissions.tool(
  "AskUserQuestion",
  {
    questions: [
      {
        header: "Choice",
        question: "Which?",
        options: [{ label: "A", description: "First" }],
      },
    ],
  },
  options
)
permissions.respond("permission", { kind: "answers", answers: { "0": ["A"] } })
const answer = await question
assert.ok(answer)
assert.equal(answer.behavior, "allow")
if (answer.behavior === "allow")
  assert.deepEqual(answer.updatedInput?.answers, { "Which?": "A" })
const denied = permissions.tool("Bash", { command: "echo test" }, options)
permissions.close()
assert.equal((await denied)?.behavior, "deny")
assert.deepEqual(permissions.respond("permission", { kind: "choice", optionId: "allow_once" }),
  { kind: "not-submitted", pending: false, reason: "request-ended" })
const abort = new AbortController()
const cancelledQuestion = permissions.tool("Bash", { command: "echo harmless" }, { ...options, signal: abort.signal })
const observedQuestion = permissionEvents.at(-1)
assert.ok(observedQuestion?.type === "live-permission")
abort.abort()
const cancelledDecision = await cancelledQuestion
assert.equal(cancelledDecision.behavior, "deny")
assert.equal(cancelledDecision.decisionClassification, undefined, "an aborted request must not invent a user click")
assert.deepEqual(permissionEvents.at(-1), { type: "live-permission-ended", id: "permission-fixture",
  requestId: "permission", observationId: observedQuestion.request.observationId, source: "request-aborted" })
const sessionRule: PermissionUpdate = { type: "addRules", destination: "session", behavior: "allow", rules: [{ toolName: "Bash", ruleContent: "echo:*" }] }
const persistentRule: PermissionUpdate = { ...sessionRule, destination: "userSettings" }
for (const [optionId, classification] of [["allow_once", "user_temporary"], ["allow_session", "user_permanent"], ["reject_once", "user_reject"]]) {
  const reply = permissions.tool("Bash", { command: "echo harmless" }, { ...options, suggestions: [sessionRule, persistentRule] })
  permissions.respond(options.requestId, { kind: "choice", optionId })
  const native = await reply
  assert.equal(native.decisionClassification, classification)
  if (native.behavior === "allow")
    assert.deepEqual(native.updatedPermissions, optionId === "allow_session" ? [sessionRule] : undefined,
      "only native session suggestions reach the native policy engine")
}
const queue = new ClaudeInput()
queue.close()
assert.throws(() => queue.send(steering.value), /closed/)
console.log(
  "PASS: Claude SDK exact-turn steering, receipt timeout, bounded Stop, launch cancellation, questions, permission decline and closed input"
)

const projection = new ClaudeProjection()
for (const confirmed of [true, false]) {
  const messages = new Messages()
  const compactEvents: LiveDriverEvent[] = []
  const compactDriver = createClaudeSdkDriver({ ...dependencies, query(options) {
    return { ...dependencies.query(options), [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](), close: () => messages.close() }
  } })
  await compactDriver.start("/disposable", { conversationId: "compact-fixture", emit: (event) => compactEvents.push(event) })
  assert.ok(compactDriver.compaction?.kind === "supported")
  await compactDriver.compaction.start("compact-fixture", "compact-action")
  const command = await input?.next()
  assert.ok(command && !command.done)
  assert.equal(command.value.message.content, "/compact")
  assert.equal(compactEvents.some((event) => event.type === "live-action-result"), false)
  if (confirmed) messages.send({ type: "system", subtype: "compact_boundary", uuid: randomUUID(), session_id: "compact-fixture", compact_metadata: { trigger: "manual", pre_tokens: 1000 } })
  const result = {
    type: "result", subtype: "success", uuid: randomUUID(), session_id: "compact-fixture",
    duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, result: "", stop_reason: "end_turn", total_cost_usd: 0,
    modelUsage: {}, permission_denials: [], user_message_uuid: command.value.uuid,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      fallback_credit: { status: { type: "redeemed" } }, inference_geo: "", iterations: [], output_tokens_details: { thinking_tokens: 0 },
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 }, service_tier: "standard", speed: "standard" },
  } satisfies SDKMessage
  messages.send({ ...result, user_message_uuid: "earlier-prompt" })
  await delay(0)
  assert.equal(compactEvents.some((event) => event.type === "live-action-result"), false, "an earlier turn cannot complete this action")
  messages.send(result)
  await delay(0)
  const final = compactEvents.findLast((event) => event.type === "live-action-result")
  assert.ok(final?.type === "live-action-result")
  assert.equal(final.actionId, "compact-action")
  assert.equal(final.result.kind, confirmed ? "completed" : "uncertain")
  if (confirmed) {
    const authError = "Failed to authenticate: OAuth session expired and could not be refreshed"
    const promptAttempt = randomUUID()
    const receipts: PromptDeliveryEvidence[] = []
    await compactDriver.prompt("compact-fixture", "Fixture prompt", [], undefined, {
      operationId: randomUUID(), attemptId: promptAttempt, report: (evidence) => receipts.push(evidence),
    })
    messages.send({ ...result, uuid: randomUUID(), user_message_uuid: promptAttempt, is_error: true, result: authError })
    await delay(0)
    const failed = compactEvents.findLast((event) => event.type === "live-session")
    assert.ok(failed?.type === "live-session")
    assert.equal(failed.session.status, "failed")
    assert.equal(failed.session.error, authError, "success subtype must not discard is_error result text")
    await flushHostLog()
    const authLog = await readFile(join(authLogRoot, "host.log"), "utf8")
    assert.match(authLog, /claude-auth Native authentication failure .*category=native-refresh-unavailable/)
    assert.equal(receipts.at(-1)?.kind, "accepted", "API failure does not undo SDK acknowledgement")
    const nextAttempt = randomUUID()
    await compactDriver.prompt("compact-fixture", "Next prompt", [], undefined, {
      operationId: randomUUID(), attemptId: nextAttempt, report() {},
    })
    messages.send({ ...result, uuid: randomUUID(), user_message_uuid: nextAttempt, result: authError })
    await delay(0)
    const success = compactEvents.findLast((event) => event.type === "live-session")
    assert.ok(success?.type === "live-session")
    assert.equal(success.session.status, "ready", "ordinary answer text cannot establish a failure")
    assert.equal(success.session.error, undefined)
  }
  compactDriver.close("compact-fixture")
}
console.log("PASS: Claude compaction requires a manual boundary and the matching SDK result")
{
  const messages = new Messages()
  const backgroundEvents: LiveDriverEvent[] = []
  const backgroundDriver = createClaudeSdkDriver({ ...dependencies, query(options) {
    return { ...dependencies.query(options), [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](), close: () => messages.close() }
  } })
  await backgroundDriver.start("/disposable", { conversationId: "background-fixture", emit: (event) => backgroundEvents.push(event) })
  const reported = () => backgroundEvents.findLast((event) => event.type === "live-session")?.session.backgroundTasks
  const changed = (tasks: { task_id: string; task_type: string; description: string; ambient?: boolean }[]) =>
    messages.send({ type: "system", subtype: "background_tasks_changed", tasks, uuid: randomUUID(), session_id: "background-fixture" })
  changed([
    { task_id: "sleep", task_type: "local_bash", description: "sleep 45" },
    { task_id: "watcher", task_type: "monitor", description: "live update watcher", ambient: true },
  ])
  await delay(0)
  assert.equal(reported(), 1, "ambient watchers are not background work")
  changed([{ task_id: "watcher", task_type: "monitor", description: "live update watcher", ambient: true }])
  await delay(0)
  assert.equal(reported(), 0, "the latest task list replaces the previous one")
  changed([{ task_id: "build", task_type: "local_bash", description: "npm run build" }])
  await delay(0)
  assert.equal(reported(), 1)
  backgroundDriver.close("background-fixture")
}
console.log("PASS: Claude background tasks follow the SDK's replace-semantics task list")
const assistant: SDKAssistantMessage = {
  type: "assistant",
  parent_tool_use_id: null,
  uuid: randomUUID(),
  session_id: "fixture",
  message: {
    id: "message",
    type: "message",
    role: "assistant",
    model: "fixture",
    content: [{ type: "text", text: "Complete", citations: null }],
    container: null,
    context_management: null,
    diagnostics: null,
    stop_details: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      fallback_credit: null,
      inference_geo: null,
      iterations: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
  },
}
diagnostic.observe({ ...assistant, error: "authentication_failed", parent_tool_use_id: "child-tool" })
assert.equal(authDiagnostics.length, 1, "a child failure must not be attributed to the parent account")
diagnostic.observe({
  type: "system", subtype: "init", uuid: randomUUID(), session_id: "fixture",
  apiKeySource: "none", claude_code_version: "2.1.263", cwd: "/private-workspace",
  tools: [], mcp_servers: [], model: "fixture", permissionMode: "default",
  slash_commands: [], output_style: "default", skills: [], plugins: [],
})
diagnostic.observe({ ...assistant, error: "authentication_failed" })
diagnostic.observe({ ...assistant, error: "authentication_failed" })
assert.equal(authDiagnostics.length, 2)
assert.equal(authDiagnostics.at(-1)?.nativeVersion, "2.1.263")
assert.equal(authDiagnostics.at(-1)?.category, "authentication_failed")
diagnostic.observe({ ...assistant, error: "rate_limit" })
assert.equal(authDiagnostics.length, 2, "rate limits are not authentication failures")
projection.project({
  type: "stream_event",
  uuid: randomUUID(),
  session_id: "fixture",
  parent_tool_use_id: null,
  event: {
    type: "message_start",
    message: { ...assistant.message, content: [] },
  },
})
projection.project({
  type: "stream_event",
  uuid: randomUUID(),
  session_id: "fixture",
  parent_tool_use_id: null,
  event: {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "", citations: null },
  },
})
assert.deepEqual(
  projection.project({
    type: "stream_event",
    uuid: randomUUID(),
    session_id: "fixture",
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Com" },
    },
  }),
  [{ kind: "text", id: "message:0", text: "Com" }]
)
assert.deepEqual(projection.project(assistant), [
  { kind: "text", id: "message:0", text: "Complete", replace: true },
])
assert.deepEqual(
  projection.project({
    type: "user",
    session_id: "fixture",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool",
          content: [
            { type: "text", text: "Image result" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "fixture",
              },
            },
          ],
        },
      ],
    },
  }),
  [
    {
      kind: "tool-update",
      id: "tool",
      status: "completed",
      output: "Image result",
      attachments: [
        {
          type: "attachment",
          name: "Tool image",
          mimeType: "image/png",
          source: { kind: "inline", data: "fixture" },
        },
      ],
    },
  ]
)
console.log("PASS: SDK streaming/final text identity and tool image ownership")

assert.equal(
  claudeExecutablePath(
    "/Applications/Mako.app/Contents/Resources/app.asar/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"
  ),
  "/Applications/Mako.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"
)
assert.equal(
  claudeExecutablePath("/usr/local/bin/claude"),
  "/usr/local/bin/claude"
)

projection.reset()
projection.project({
  type: "stream_event",
  uuid: randomUUID(),
  session_id: "fixture",
  parent_tool_use_id: null,
  event: {
    type: "message_start",
    message: { ...assistant.message, content: [] },
  },
})
projection.project({
  type: "stream_event",
  uuid: randomUUID(),
  session_id: "fixture",
  parent_tool_use_id: null,
  event: {
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "", signature: "" },
  },
})
projection.project({
  type: "stream_event",
  uuid: randomUUID(),
  session_id: "fixture",
  parent_tool_use_id: null,
  event: {
    type: "content_block_start",
    index: 1,
    content_block: { type: "text", text: "", citations: null },
  },
})
assert.deepEqual(projection.project(assistant), [
  { kind: "text", id: "message:1", text: "Complete", replace: true },
])
assert.deepEqual(
  projection.project(assistant),
  [],
  "A repeated SDK frame cannot duplicate the answer"
)
console.log(
  "PASS: single-block SDK completion retains its stream index after thinking"
)

const transcriptRoot = await mkdtemp(join(tmpdir(), "mako-sdk-flush-"))
try {
  const sessionId = randomUUID()
  const transcriptPath = join(transcriptRoot, `${sessionId}.jsonl`)
  const transcript = new ClaudeTranscript()
  await transcript.hook(
    {
      hook_event_name: "SessionStart",
      source: "startup",
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: "/different-workspace",
    },
    undefined,
    { signal: new AbortController().signal }
  )
  transcript.observe({ ...assistant, session_id: sessionId })
  const point = transcript.forkPoint(sessionId)
  await delay(50)
  const finalId = randomUUID()
  await writeFile(
    transcriptPath,
    [
      { uuid: assistant.uuid, parentUuid: null, sessionId, type: "assistant" },
      {
        uuid: finalId,
        parentUuid: assistant.uuid,
        sessionId,
        type: "attachment",
      },
      { type: "last-prompt", sessionId, leafUuid: finalId },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n"
  )
  assert.equal(await point, finalId)
  transcript.reset()
  assert.equal(await transcript.forkPoint(sessionId), undefined)
  console.log(
    "PASS: SDK fork waits for the account-scoped native writer and never reuses a previous turn's boundary"
  )
} finally {
  await rm(transcriptRoot, { recursive: true, force: true })
}
await flushHostLog()
await rm(authLogRoot, { recursive: true, force: true })

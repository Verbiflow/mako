import type { PromptDeliveryEvidence } from "../electron/contracts/prompt-delivery.ts"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type {
  HookCallback,
  SDKMessage,
  SDKResultSuccess,
  SDKUserMessage,
  SDKAssistantMessage,
  SDKAssistantMessageError,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk"
import {
  createClaudeSdkDriver,
  type ClaudeSdkDependencies,
} from "../electron/providers/claude/sdk-driver.ts"
import { claudeExecutablePath } from "../electron/providers/claude/sdk-process.ts"
import { ClaudeProjection } from "../electron/providers/claude/sdk-projection.ts"
import { readPromptAttachments } from "@mako/sessions/prompt-attachments"
import { claudeInputContent, ClaudeInput } from "../electron/providers/claude/input.ts"
import { ClaudePermissions } from "../electron/providers/claude/sdk-permissions.ts"
import { ClaudeTranscript } from "../electron/providers/claude/sdk-transcript.ts"
import type { LiveDriverEvent } from "../electron/shared.ts"
import { claudeAuthCause, claudeAuthDiagnostics } from "../electron/providers/claude/auth-diagnostics.ts"
import type { ClaudeCredentialState } from "../electron/providers/claude/accounts.ts"
import { installHostLog, flushHostLog, type HostLogFields } from "../electron/host-log.ts"

const authLogRoot = await mkdtemp(join(tmpdir(), "mako-claude-auth-diagnostics-"))
installHostLog(join(authLogRoot, "host.log"))
const authDiagnostics: HostLogFields[] = []
// The store an account profile was left with after its refresh token expired: Claude cleared both tokens.
const clearedStore: ClaudeCredentialState = { store: "keychain", scoped: true, access: false, refresh: "empty",
  refreshExpiresAt: "2026-08-30T20:47:16.410Z", writtenAt: "2026-10-01T07:19:19Z" }
const diagnostic = claudeAuthDiagnostics({
  HOME: "/private-user-home", CLAUDE_CONFIG_DIR: "/private-account-scope",
  CLAUDE_SECURESTORAGE_CONFIG_DIR: "", ANTHROPIC_API_KEY: "secret-api-key",
  ANTHROPIC_AUTH_TOKEN: "secret-auth-token", CLAUDE_CODE_OAUTH_TOKEN: "secret-oauth-token",
  ANTHROPIC_BASE_URL: "https://private-server/token=secret",
}, fields => authDiagnostics.push(fields), async () => clearedStore)
const refreshFailure = "Failed to authenticate: OAuth session expired and could not be refreshed"
diagnostic.failure(`A user wrote: ${refreshFailure}`)
await diagnostic.settled()
assert.equal(authDiagnostics.length, 0, "ordinary prose must not become native auth evidence")
diagnostic.failure(refreshFailure)
diagnostic.failure(refreshFailure)
await diagnostic.settled()
assert.equal(authDiagnostics.length, 1, "repeated native errors cannot flood the log")
assert.equal(authDiagnostics[0]?.secureStorageOverride, true, "empty native override is meaningful")
assert.equal(authDiagnostics[0]?.apiKeyOverride, true)
assert.equal(authDiagnostics[0]?.category, "native-refresh-unavailable")
assert.equal(authDiagnostics[0]?.cause, "cleared")
assert.equal(authDiagnostics[0]?.refreshToken, "empty")
assert.equal(authDiagnostics[0]?.storeWrittenAt, "2026-10-01T07:19:19Z", "the store's last write dates the native give-up")
for (const secret of ["private-user", "private-account", "secret-api", "secret-auth", "secret-oauth", "private-server"])
  assert.ok(!JSON.stringify(authDiagnostics).includes(secret), "diagnostics must not retain secrets or raw source paths")
let accountScope: HostLogFields | undefined
const account = claudeAuthDiagnostics({ CLAUDE_CONFIG_DIR: "/private-account-scope" }, fields => { accountScope = fields }, async () => clearedStore)
account.failure(refreshFailure)
await account.settled()
assert.notEqual(accountScope?.secureStorageScope, authDiagnostics[0]?.secureStorageScope)
{
  const now = new Date("2026-10-04T00:00:00Z")
  const live = { store: "keychain", scoped: true, access: true, refresh: "present", refreshExpiresAt: "2026-10-31T10:19:18Z" } as const
  assert.equal(claudeAuthCause({ store: "none", scoped: false }, now), "signed-out")
  assert.equal(claudeAuthCause({ ...live, access: false, refresh: "empty" }, now), "cleared")
  assert.equal(claudeAuthCause({ ...live, refresh: "missing" }, now), "no-refresh-token")
  assert.equal(claudeAuthCause({ ...live, refreshExpiresAt: "2026-09-10T06:16:51Z" }, now), "refresh-expired")
  assert.equal(claudeAuthCause(live, now), "unexplained", "only a live, unexpired refresh token implicates rotation or contention")
}

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
const mixedInput = await claudeInputContent("Review it", [{ name: "report.pdf", mimeType: "application/pdf", path: "/fixture/report.pdf", size: 12 }])
assert.ok(Array.isArray(mixedInput))
assert.equal(mixedInput.length, 1)
assert.equal(mixedInput[0]?.type, "text")
if (mixedInput[0]?.type === "text") {
  const parsed = readPromptAttachments(mixedInput[0].text)
  assert.equal(parsed.text, "Review it")
  assert.equal(parsed.attachments[0]?.name, "report.pdf")
}
await assert.rejects(claudeInputContent("Review it", [{ name: "report.pdf", mimeType: "application/pdf", size: 12 }]), /not staged/)

const events: LiveDriverEvent[] = []
const output = new Messages()
let input: AsyncIterator<SDKUserMessage> | undefined
let closed = false
const dependencies: ClaudeSdkDependencies = {
  available: () => true,
  configure: async () => ({ options: {}, account: { name: "fixture-launch" } }),
  receiptTimeoutMs: 20,
  interruptTimeoutMs: 20,
  inspectCredentials: async () => clearedStore,
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
// Claude Code 2.1.283 reports each command's progress by Mako's uuid, before any echo.
// A CLI newer than the SDK's types sends this kind, as JSON the driver parses.
const lifecycle = (command: string, state: string) =>
  output.send(JSON.parse(JSON.stringify({ type: "command_lifecycle", command_uuid: command, state, uuid: randomUUID(), session_id: "native" })))
const queued = driver.steer("sdk-fixture", { id: "queued", expectedRunId: running.session.nativeRunId, text: "Queued", attachments: [] })
const queuedInput = await input?.next()
assert.ok(queuedInput && !queuedInput.done)
lifecycle(queuedInput.value.uuid!, "queued")
assert.deepEqual(await queued, { kind: "accepted" }, "a queued command is received")
const dropped = driver.steer("sdk-fixture", { id: "dropped", expectedRunId: running.session.nativeRunId, text: "Dropped", attachments: [] })
const droppedInput = await input?.next()
assert.ok(droppedInput && !droppedInput.done)
lifecycle(droppedInput.value.uuid!, "cancelled")
await assert.rejects(dropped, /not confirmed steering/, "a cancelled command is no receipt")
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

// A process killed in a fresh session's first turn: no hook has reported the
// transcript yet, and the death must still carry the path it resumes from.
{
  const configDir = await mkdtemp(join(tmpdir(), "mako-claude-config-"))
  const conversationId = randomUUID()
  const transcriptPath = join(configDir, "projects", "-tmp-work", `${conversationId}.jsonl`)
  await mkdir(join(configDir, "projects", "-tmp-work"), { recursive: true })
  await mkdir(join(configDir, "projects", "-tmp-other"), { recursive: true })
  await writeFile(transcriptPath, "{}\n")
  let fail: ((error: Error) => void) | undefined
  async function* dying(): AsyncGenerator<SDKMessage, void> {
    yield await new Promise<never>((_, reject) => { fail = reject })
  }
  const deaths: LiveDriverEvent[] = []
  const dyingDriver = createClaudeSdkDriver({
    ...dependencies,
    configure: async () => ({ options: { env: { CLAUDE_CONFIG_DIR: configDir } }, account: { name: "fixture-launch" } }),
    query: (options) => ({ ...dependencies.query(options), [Symbol.asyncIterator]: dying }),
  })
  await dyingDriver.start("/tmp/work", { conversationId, emit: (event) => deaths.push(event) })
  await dyingDriver.prompt(conversationId, "Begin", [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
  const before = deaths.length
  fail?.(new Error("Claude Code process terminated by signal SIGKILL"))
  for (let waited = 0; deaths.length === before && waited < 2000; waited += 10) await delay(10)
  const reported = deaths.slice(before).filter((event) => event.type === "live-session")
  assert.equal(reported.length, 1, "the death is one session update")
  const death = reported[0]?.type === "live-session" ? reported[0].session : undefined
  assert.equal(death?.status, "failed")
  assert.equal(death?.connection, "disconnected")
  assert.equal(death?.nativePath, transcriptPath, "the death carries the transcript found under the account's config")
  await rm(configDir, { recursive: true, force: true })
}

let configured: (() => void) | undefined
let launched = false
const racing = createClaudeSdkDriver({
  ...dependencies,
  configure: async () => {
    await new Promise<void>((resolve) => {
      configured = resolve
    })
    return { options: {}, account: { name: "fixture-launch" } }
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
assert.ok(cancelledDecision)
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
  assert.ok(native)
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
  let postCompact: HookCallback | undefined
  const compactDriver = createClaudeSdkDriver({ ...dependencies, query(options) {
    postCompact = options.options.hooks?.PostCompact?.at(-1)?.hooks[0]
    return { ...dependencies.query(options), [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](), close: () => messages.close() }
  } })
  await compactDriver.start("/disposable", { conversationId: "compact-fixture", emit: (event) => compactEvents.push(event) })
  assert.ok(compactDriver.compaction?.kind === "supported")
  await compactDriver.compaction.start("compact-fixture", "compact-action")
  const command = await input?.next()
  assert.ok(command && !command.done)
  assert.equal(command.value.message.content, "/compact")
  assert.equal(compactEvents.some((event) => event.type === "live-action-result"), false)
  if (confirmed) {
    const retriedAt = Date.now()
    messages.send({ type: "system", subtype: "status", status: "compacting", uuid: randomUUID(), session_id: "compact-fixture" })
    messages.send({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 1000, error_status: 529,
      error: "overloaded", uuid: randomUUID(), session_id: "compact-fixture" })
    await delay(0)
    await postCompact?.({ hook_event_name: "PostCompact", trigger: "manual", compact_summary: "Kept: the parser plan.",
      session_id: "compact-fixture", transcript_path: "/disposable/compact-fixture.jsonl", cwd: "/disposable" },
    undefined, { signal: new AbortController().signal })
    const boundary = randomUUID()
    messages.send({ type: "system", subtype: "compact_boundary", uuid: boundary, session_id: "compact-fixture", compact_metadata: { trigger: "manual", pre_tokens: 1000, post_tokens: 200, duration_ms: 8_200 } })
    for (let index = 0; index < 2; index++) {
      // A Claude Code newer than the SDK types: the message arrives as parsed JSON.
      const future: SDKMessage = JSON.parse(JSON.stringify({ type: "system", subtype: "future_notice", uuid: randomUUID(), session_id: "compact-fixture" }))
      messages.send(future)
    }
    await delay(0)
    const activities = compactEvents.flatMap((event) => event.type === "live-activity" ? [event.activity] : [])
    const retrying = activities[1]
    assert.ok(retrying?.kind === "retrying")
    const { retryAt, ...retry } = retrying
    assert.deepEqual([activities[0], retry, ...activities.slice(2)],
      [{ kind: "compacting" }, { kind: "retrying", attempt: 2, maxAttempts: 10, reason: "Overloaded (529)" }, null],
      "compaction and its retry show while they run and end at the boundary")
    assert.ok(retryAt !== undefined && retryAt >= retriedAt + 1000 && retryAt <= Date.now() + 1000,
      "the retry counts down to when Claude tries again")
    assert.deepEqual(
      compactEvents.flatMap((event) => event.type === "live-update" ? [event.update] : []),
      [{ kind: "event", id: boundary, source: { harness: "claude", record: boundary }, label: "Context compacted", detail: "Manual · 1k → 200 tokens · took 8s", body: "Kept: the parser plan." }],
      "the boundary is a transcript event with its trigger, tokens, Claude's own duration and the hook's summary, not assistant text"
    )
  }
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
    await delay(0)
    await flushHostLog()
    const authLog = await readFile(join(authLogRoot, "host.log"), "utf8")
    assert.match(authLog, /claude-auth Native authentication failure .*category=native-refresh-unavailable.*cause=cleared .*refreshToken=empty/)
    assert.equal(authLog.match(/native event not handled .*kind=system\/future_notice/g)?.length, 1,
      "a message kind this SDK does not declare is logged once")
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
{
  // The sequence Claude Code 2.1.283 streamed on 2026-09-27 when a background
  // command settled after its turn: notification, `init`, reply, then a result
  // whose origin is the notification.
  const messages = new Messages()
  const turnEvents: LiveDriverEvent[] = []
  let turnInput: AsyncIterator<SDKUserMessage> | undefined
  const turnDriver = createClaudeSdkDriver({ ...dependencies, query(options) {
    turnInput = options.prompt[Symbol.asyncIterator]()
    return { ...dependencies.query(options), [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](), close: () => messages.close(),
      interrupt: async () => { onInterrupt?.(); await delay(5) } }
  } })
  let onInterrupt: (() => void) | undefined
  await turnDriver.start("/disposable", { conversationId: "turn-fixture", emit: (event) => turnEvents.push(event) })
  const session = () => turnEvents.findLast((event) => event.type === "live-session")?.session
  const opened = () => turnEvents.flatMap((event) =>
    event.type === "live-update" ? [event.update] : event.type === "live-updates" ? event.updates : []).filter((update) => update.kind === "provider-turn")
  const init = () => messages.send({
    type: "system", subtype: "init", uuid: randomUUID(), session_id: "turn-fixture",
    apiKeySource: "none", claude_code_version: "2.1.283", cwd: "/disposable",
    tools: [], mcp_servers: [], model: "fixture", permissionMode: "default",
    slash_commands: [], output_style: "default", skills: [], plugins: [],
  })
  const reply = (text: string) => {
    const message: SDKAssistantMessage = { ...assistant, uuid: randomUUID(), session_id: "turn-fixture", message: { ...assistant.message, content: [{ type: "text", text, citations: null }] } }
    messages.send(message)
  }
  const result = (origin?: { kind: "task-notification" }) => {
    const message: SDKMessage = {
      type: "result", subtype: "success", uuid: randomUUID(), session_id: "turn-fixture",
      duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, result: "", stop_reason: "end_turn", total_cost_usd: 0,
      modelUsage: {}, permission_denials: [], queued_turn_count: 0,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
        fallback_credit: { status: { type: "redeemed" } }, inference_geo: "", iterations: [], output_tokens_details: { thinking_tokens: 0 },
        server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 }, service_tier: "standard", speed: "standard" },
    }
    if (origin) message.origin = origin
    messages.send(message)
  }
  const notify = (summary: string, ambient = false) => messages.send({
    type: "system", subtype: "task_notification", task_id: randomUUID(), status: "completed", output_file: "/disposable/out",
    summary, ambient, uuid: randomUUID(), session_id: "turn-fixture",
  })

  await turnDriver.prompt("turn-fixture", "Start the sleep", [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
  await turnInput?.next()
  init()
  reply("Started it.")
  notify("Background command \"Sleep 8 seconds\" completed (exit code 0)")
  await delay(0)
  assert.equal(opened().length, 0, "an init and a notification inside Mako's own turn open nothing")
  result()
  await delay(0)
  assert.equal(session()?.status, "ready")

  notify("Live update watcher stopped", true)
  notify("Background command \"Sleep 8 seconds\" completed (exit code 0)")
  init()
  await delay(0)
  assert.equal(session()?.status, "running", "the turn Claude started itself shows as running")
  assert.deepEqual(opened(), [{ kind: "provider-turn", reason: "Background command \"Sleep 8 seconds\" completed (exit code 0)" }],
    "the non-ambient notification names the turn's cause")
  reply("It printed BG-DONE.")
  result({ kind: "task-notification" })
  await delay(0)
  assert.equal(session()?.status, "ready", "the provider's result ends its own turn")
  assert.equal(session()?.lastStop, "completed")

  init()
  await delay(0)
  assert.equal(opened().at(-1)?.reason, "A background task finished", "a turn started without a notification still opens with a cause")
  result()
  await delay(0)
  assert.equal(session()?.status, "ready")

  notify("Background command \"Watch logs\" completed (exit code 0)")
  init()
  await delay(0)
  assert.equal(session()?.status, "running")
  onInterrupt = () => {
    messages.send({ type: "user", uuid: randomUUID(), session_id: "turn-fixture", parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } })
    messages.send({
      type: "result", subtype: "error_during_execution", uuid: randomUUID(), session_id: "turn-fixture", origin: { kind: "task-notification" },
      duration_ms: 1, duration_api_ms: 1, is_error: true, num_turns: 0, stop_reason: null, total_cost_usd: 0, terminal_reason: "aborted_streaming",
      modelUsage: {}, permission_denials: [], errors: [],
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
        fallback_credit: { status: { type: "redeemed" } }, inference_geo: "", iterations: [], output_tokens_details: { thinking_tokens: 0 },
        server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 }, service_tier: "standard", speed: "standard" },
    } satisfies SDKMessage)
  }
  await turnDriver.cancel("turn-fixture")
  assert.equal(session()?.status, "ready", "Stop settles a turn Claude started itself")
  assert.equal(session()?.lastStop, "interrupted")
  assert.equal(session()?.error, undefined, "the interrupt's own aborted result is not reported as an error")
}
console.log("PASS: A turn Claude starts after a background task opens with its cause, runs, and settles on its result")
{
  const messages = new Messages()
  const noticeEvents: LiveDriverEvent[] = []
  const noticeDriver = createClaudeSdkDriver({ ...dependencies, query(options) {
    return { ...dependencies.query(options), [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](), close: () => messages.close() }
  } })
  await noticeDriver.start("/disposable", { conversationId: "notice-fixture", emit: (event) => noticeEvents.push(event) })
  const session = () => noticeEvents.findLast((event) => event.type === "live-session")?.session
  const updates = () => noticeEvents.flatMap((event) =>
    event.type === "live-update" ? [event.update] : event.type === "live-updates" ? event.updates : [])
  const markers = () => updates().flatMap((update) => update.kind === "event" ? [update] : [])
  const since = (count: number) => markers().slice(count).map(({ label, detail, body, tone }) => ({ label, detail, body, tone }))
  const ids = { uuid: randomUUID(), session_id: "notice-fixture" }
  const send = (message: SDKMessage) => messages.send({ ...message, uuid: randomUUID() })
  const result = (fields: Partial<SDKResultSuccess> = {}) => send({
    type: "result", subtype: "success", ...ids, duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, result: "",
    stop_reason: "end_turn", total_cost_usd: 0, modelUsage: {}, permission_denials: [], queued_turn_count: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      fallback_credit: { status: { type: "redeemed" } }, inference_geo: "", iterations: [], output_tokens_details: { thinking_tokens: 0 },
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 }, service_tier: "standard", speed: "standard" },
    ...fields,
  })
  const prompt = () => noticeDriver.prompt("notice-fixture", "Go", [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })

  let count = markers().length
  const resetsAt = Math.floor(Date.now() / 1000) + 3600
  for (const status of ["allowed", "allowed_warning", "allowed_warning", "rejected", "rejected"] as const)
    send({ type: "rate_limit_event", ...ids, rate_limit_info: { status, rateLimitType: "five_hour", resetsAt } })
  await delay(0)
  const limits = since(count)
  assert.deepEqual(limits.map(({ label, tone }) => [label, tone]), [["Warning", "warning"], ["Rate limited", "warning"]],
    "a limit is said once per status and reset, and an allowed request says nothing")
  assert.match(limits[0]?.detail ?? "", /^Approaching your 5-hour limit · resets \S/)
  assert.match(limits[1]?.detail ?? "", /^Reached your 5-hour limit · resets \S/)

  count = markers().length
  send({ type: "system", subtype: "model_refusal_fallback", ...ids, trigger: "refusal", direction: "retry", scope: "session",
    original_model: "claude-fable-5-1", fallback_model: "claude-opus-4-8", request_id: "req-1",
    content: "Fable 5.1's safeguards flagged this message. Switched to Opus 4.8.", api_refusal_explanation: null })
  send({ type: "system", subtype: "informational", ...ids, level: "info", content: "Transcript-mode detail" })
  send({ type: "system", subtype: "informational", ...ids, level: "notice", content: "A UserPromptSubmit hook said hello" })
  send({ type: "system", subtype: "informational", ...ids, level: "warning", content: "Plugin failed to load\nSee the plugin log" })
  for (let index = 0; index < 2; index++)
    send({ type: "system", subtype: "notification", ...ids, key: "update", text: "Update available", priority: "low" })
  send({ type: "system", subtype: "local_command_output", ...ids, content: "Kept model as Opus 4.8" })
  send({ type: "system", subtype: "hook_response", ...ids, hook_id: "h", hook_name: "SessionStart:startup", hook_event: "SessionStart",
    output: "", stdout: "", stderr: "setup.sh: not found", exit_code: 127, outcome: "error" })
  send({ type: "system", subtype: "hook_response", ...ids, hook_id: "h2", hook_name: "SessionStart:startup", hook_event: "SessionStart",
    output: "", stdout: "", stderr: "", outcome: "success" })
  send({ type: "system", subtype: "session_state_changed", ...ids, state: "idle" })
  await delay(0)
  assert.deepEqual(since(count), [
    { label: "Model changed", detail: "claude-fable-5-1 → claude-opus-4-8 · after a refusal",
      body: "Fable 5.1's safeguards flagged this message. Switched to Opus 4.8.", tone: undefined },
    { label: "Notice", detail: "A UserPromptSubmit hook said hello", body: undefined, tone: undefined },
    { label: "Warning", detail: "Plugin failed to load", body: "Plugin failed to load\nSee the plugin log", tone: "warning" },
    { label: "Notice", detail: "Update available", body: undefined, tone: undefined },
    { label: "Notice", detail: "Kept model as Opus 4.8", body: undefined, tone: undefined },
    { label: "Warning", detail: "SessionStart:startup hook failed", body: "setup.sh: not found", tone: "warning" },
  ], "provider notices are markers; transcript-mode detail, repeated notifications and bookkeeping say nothing")

  send({ type: "system", subtype: "status", ...ids, status: null, permissionMode: "plan" })
  send({ type: "system", subtype: "commands_changed", ...ids,
    commands: [{ name: "review", description: "Review the branch", argumentHint: "[branch]" }, { name: "exit", description: "", argumentHint: "" }] })
  await delay(0)
  assert.equal(session()?.currentMode, "plan", "a mode Claude changes mid-turn shows")
  assert.deepEqual(session()?.commands, [{ name: "review", description: "Review the branch", hint: "[branch]" }, { name: "exit", description: undefined, hint: undefined }])

  await prompt()
  count = markers().length
  const textUpdates = updates().filter((update) => update.kind === "text").length
  const apiFailure: SDKAssistantMessage = { ...assistant, ...ids, error: "rate_limit", message: { ...assistant.message,
    id: "synthetic-error", model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit · resets 5:10am", citations: null }] } }
  send(apiFailure)
  send({ ...assistant, ...ids, message: { ...assistant.message, id: "synthetic-filler", model: "<synthetic>",
    content: [{ type: "text", text: "No response requested.", citations: null }] } })
  send({ ...assistant, ...ids, message: { ...assistant.message, id: "answer", model: "claude-opus-4-8",
    usage: { ...assistant.message.usage, input_tokens: 1000, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, output_tokens: 200 } } })
  const window = { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 5000, cacheCreationInputTokens: 0,
    webSearchRequests: 0, costUSD: 0.25, contextWindow: 1_000_000, maxOutputTokens: 64_000 }
  result({ stop_reason: "max_tokens", total_cost_usd: 0.25, modelUsage: { "claude-opus-4-8[1m]": window } })
  await delay(0)
  assert.equal(updates().filter((update) => update.kind === "text").length, textUpdates + 1, "only the model's own answer is prose")
  assert.deepEqual(since(count), [
    { label: "Rate limited", detail: "You've hit your session limit · resets 5:10am", body: undefined, tone: "warning" },
    { label: "Warning", detail: "The reply hit the output token limit", body: undefined, tone: "warning" },
  ], "an API failure Claude composed is a marker, and a truncated reply says so")
  assert.deepEqual(session()?.usage, { used: 6200, size: 1_000_000, cost: { amount: 0.25, currency: "USD" },
    tokens: { input: 1000, cacheRead: 5000, cacheWrite: 0, output: 200 } },
    "the context meter reads the main loop's latest request against its model's window, split by where its tokens came from")
  const reports = noticeEvents.length
  result({ total_cost_usd: 0.25, modelUsage: { "claude-opus-4-8[1m]": window } })
  await delay(0)
  assert.equal(noticeEvents.length, reports, "an unchanged reading reports nothing")
  send({ type: "system", subtype: "compact_boundary", ...ids, compact_metadata: { trigger: "auto", pre_tokens: 6200, post_tokens: 900 } })
  await delay(0)
  assert.equal(session()?.usage?.used, 900, "compaction empties the meter to what it kept")
  assert.equal(markers().at(-1)?.detail, "Automatic · 6k → 900 tokens")

  await prompt()
  count = markers().length
  send({ type: "system", subtype: "model_refusal_no_fallback", ...ids, original_model: "claude-opus-4-8", request_id: null,
    content: "Opus 4.8's safeguards flagged this message.", api_refusal_explanation: "Blocked under the usage policy." })
  result({ stop_reason: "refusal" })
  await delay(0)
  assert.deepEqual(since(count), [{ label: "Turn failed", detail: "claude-opus-4-8 declined the request",
    body: "Opus 4.8's safeguards flagged this message.\n\nBlocked under the usage policy.", tone: "error" }],
  "a refusal is said once, not again as the turn's stop")

  count = markers().length
  result({ terminal_reason: "hook_stopped" })
  await prompt()
  send({ type: "result", subtype: "error_max_turns", ...ids, duration_ms: 1, duration_api_ms: 1, is_error: true, num_turns: 9,
    stop_reason: null, total_cost_usd: 0, modelUsage: {}, permission_denials: [], errors: [], terminal_reason: "max_turns",
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      fallback_credit: { status: { type: "redeemed" } }, inference_geo: "", iterations: [], output_tokens_details: { thinking_tokens: 0 },
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 }, service_tier: "standard", speed: "standard" } })
  await delay(0)
  assert.deepEqual(since(count), [{ label: "Warning", detail: "A hook ended the turn", body: undefined, tone: "warning" }],
    "a turn that ended early says why; a failed one says it on its request")
  assert.equal(session()?.status, "failed")
  assert.equal(session()?.error, "Reached the turn limit", "a failure without text is named by why the turn stopped")

  const resetId = randomUUID()
  send({ type: "conversation_reset", ...ids, new_conversation_id: resetId, trigger: "clear" })
  await delay(0)
  assert.equal(session()?.nativeId, resetId, "a cleared conversation continues under its new native id")
  assert.deepEqual(session()?.usage, { cost: { amount: 0.25, currency: "USD" },
    tokens: { input: 1000, cacheRead: 5000, cacheWrite: 0, output: 200 } },
  "a cleared conversation empties the context, a result without model usage erases nothing, and what was spent stays")
  noticeDriver.close("notice-fixture")
}
console.log("PASS: Claude limits, fallbacks, notices, mode, commands, usage and stop reasons reach the session once each")
const assistantError = (error: SDKAssistantMessageError): SDKAssistantMessage => ({ ...assistant, error })
diagnostic.observe({ ...assistantError("authentication_failed"), parent_tool_use_id: "child-tool" })
assert.equal(authDiagnostics.length, 1, "a child failure must not be attributed to the parent account")
diagnostic.observe({
  type: "system", subtype: "init", uuid: randomUUID(), session_id: "fixture",
  apiKeySource: "none", claude_code_version: "2.1.263", cwd: "/private-workspace",
  tools: [], mcp_servers: [], model: "fixture", permissionMode: "default",
  slash_commands: [], output_style: "default", skills: [], plugins: [],
})
diagnostic.observe(assistantError("authentication_failed"))
diagnostic.observe(assistantError("authentication_failed"))
await diagnostic.settled()
assert.equal(authDiagnostics.length, 2)
assert.equal(authDiagnostics.at(-1)?.nativeVersion, "2.1.263")
assert.equal(authDiagnostics.at(-1)?.category, "authentication_failed")
diagnostic.observe(assistantError("rate_limit"))
assert.equal(authDiagnostics.length, 2, "rate limits are not authentication failures")
const revokedFields: HostLogFields[] = []
const revoked = claudeAuthDiagnostics({}, fields => revokedFields.push(fields), async () => { throw new Error("Keychain locked") })
revoked.observe({ ...assistantError("authentication_failed"), message: { ...assistant.message,
  content: [{ type: "text", text: "Failed to authenticate. API Error: 401 OAuth access token has been revoked.", citations: null }] } })
await revoked.settled()
assert.equal(revokedFields[0]?.category, "access-revoked")
assert.equal(revokedFields[0]?.cause, "store-unreadable", "a failed store read is evidence, not a crash")
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

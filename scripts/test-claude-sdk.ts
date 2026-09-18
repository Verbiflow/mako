import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type {
  SDKMessage,
  SDKUserMessage,
  SDKAssistantMessage,
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
await driver.prompt("sdk-fixture", "Begin", [])
const original = await input?.next()
assert.equal(original?.value?.message.content[0].text, "Begin")
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
  driver.prompt("sdk-fixture", "After stop", []),
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
assert.throws(
  () =>
    permissions.respond("permission", {
      kind: "choice",
      optionId: "allow_once",
    }),
  /no longer pending/
)
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
  compactDriver.close("compact-fixture")
}
console.log("PASS: Claude compaction requires a manual boundary and the matching SDK result")
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

import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKModelRefusalFallbackMessage,
  SDKPartialAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk"
import assert from "node:assert/strict"
import { randomUUID, type UUID } from "node:crypto"
import { mock } from "node:test"
import {
  reduceLiveUpdates,
  type LiveUpdate,
} from "@mako/sessions/live-content"
import { createLiveEngine, type EngineLive } from "../electron/live-engine.ts"
import { mcpServerFailedEvent } from "@mako/sessions/events"
import {
  ClaudeProjection,
  claudeRetracted,
} from "@mako/sessions/claude-projection"
import { ClaudeNotices } from "../electron/providers/claude/sdk-notices.ts"
import type { LiveDriverEvent, LiveSessionState } from "../electron/shared.ts"
import { sessionDelta } from "../electron/contracts/live-conversations.ts"

type AssistantReply = SDKAssistantMessage["message"]
type StreamEvent = SDKPartialAssistantMessage["event"]

function session() {
  const events: LiveDriverEvent[] = []
  const state: LiveSessionState = {
    id: randomUUID(),
    nativeId: "native-1",
    harness: "fixture",
    cwd: "/tmp",
    status: "running",
    connection: "connected",
    modes: [],
    currentMode: null,
    configOptions: [],
  }
  const live: EngineLive = { state, emit: (event) => events.push(event) }
  const markers = () =>
    events.flatMap((event) =>
      event.type === "live-update" && event.update.kind === "event"
        ? [event.update]
        : []
    )
  return { live, events, markers }
}

const clock = mock.method(Date, "now", () => 0)
const at = (ms: number) => clock.mock.mockImplementation(() => ms)
try {
  const engine = createLiveEngine<EngineLive>()

  const restating = session()
  const options = () => [{ id: "model", label: "Model", kind: "select" as const, current: "a", values: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }]
  engine.patch(restating.live, { configOptions: options() })
  const held = restating.live.state
  engine.patch(restating.live, { status: "ready", configOptions: options() })
  assert.equal(restating.live.state.configOptions, held.configOptions, "an option list restated unchanged keeps the value the window holds")
  assert.deepEqual(sessionDelta(held, restating.live.state), { sessionChanges: { status: "ready" } })
  engine.patch(restating.live, { configOptions: [{ ...options()[0]!, current: "b" }] })
  assert.notEqual(restating.live.state.configOptions, held.configOptions, "a changed option list replaces it")
  console.log("PASS: a session field restated unchanged is not sent to the window again")

  const claude = session()
  at(1_000)
  engine.activity(claude.live, { kind: "compacting" })
  at(20_000)
  engine.activity(claude.live, {
    kind: "retrying",
    attempt: 2,
    reason: "Overloaded",
  })
  at(73_000)
  engine.compacted(claude.live, { trigger: "manual" }, "boundary")
  assert.deepEqual(
    claude.markers(),
    [
      {
        kind: "event",
        id: "boundary",
        source: { harness: "fixture", record: "boundary" },
        label: "Context compacted",
        detail: "Manual · took 1m 12s",
      },
    ],
    "compacting is measured from its start to the boundary; a retry on the way is part of it"
  )

  const cursor = session()
  at(0)
  engine.activity(cursor.live, { kind: "compacting" })
  at(8_500)
  engine.activity(cursor.live, null)
  at(9_200)
  engine.compacted(cursor.live, { summary: "Kept the plan" }, "turn:3")
  engine.compacted(cursor.live, { summary: "Kept the plan" }, "turn:3")
  assert.deepEqual(
    cursor.markers(),
    [
      {
        kind: "event",
        id: "turn:3",
        source: { harness: "fixture", record: "turn:3" },
        label: "Context compacted",
        detail: "took 8s",
        body: "Kept the plan",
      },
    ],
    "a summary after compacting stopped still takes its measure, and the same event replayed is drawn once"
  )

  const reported = session()
  engine.activity(reported.live, { kind: "compacting" })
  at(30_000)
  engine.compacted(reported.live, { durationMs: 94_952 })
  assert.equal(
    reported.markers()[0]?.detail,
    "took 1m 34s",
    "a duration the provider recorded wins over the measured one"
  )

  const abandoned = session()
  at(0)
  engine.activity(abandoned.live, { kind: "compacting" })
  engine.patch(abandoned.live, { status: "ready" })
  at(600_000)
  engine.compacted(abandoned.live, { trigger: "automatic" })
  const quick = session()
  engine.activity(quick.live, { kind: "compacting" })
  engine.compacted(quick.live, { trigger: "automatic" })
  assert.deepEqual(
    [...abandoned.markers(), ...quick.markers()].map((marker) => marker.detail),
    ["Automatic", "Automatic"],
    "a completion long after an abandoned compaction's turn ended, or under a second, claims no duration"
  )

  const noticed = session()
  engine.observe(
    noticed.live,
    "status",
    [
      {
        kind: "event",
        event: { label: "Model changed", detail: "after a refusal" },
      },
      { kind: "event", event: { label: "Hook failed" } },
    ],
    "message-1"
  )
  engine.observe(
    noticed.live,
    "status",
    [
      {
        kind: "event",
        event: { label: "Model changed", detail: "after a refusal" },
      },
    ],
    "message-1"
  )
  engine.observe(noticed.live, "status", [
    { kind: "event", event: { label: "Unnamed" } },
  ])
  engine.observe(noticed.live, "status", [
    { kind: "event", event: { label: "Unnamed" } },
  ])
  assert.deepEqual(
    noticed.markers().map((marker) => marker.id),
    ["message-1", "message-1:2", undefined, undefined],
    "each marker of one native event has its own id; events without one are never merged"
  )
  console.log(
    "PASS: The engine measures compaction across retries and late summaries, and draws a replayed native event once"
  )
} finally {
  clock.mock.restore()
}

{
  const opened: LiveUpdate[] = [
    { kind: "user", text: "Write the parser" },
    { kind: "event", id: "hook-1", label: "Hook running" },
    { kind: "thinking", id: "refused:0", text: "Considering" },
    { kind: "text", id: "refused:1", text: "I can't" },
    { kind: "tool", id: "tool-refused", title: "Read", status: "running" },
    { kind: "tool", id: "tool-kept", title: "Grep", status: "running" },
  ]
  let blocks = reduceLiveUpdates([], opened)
  blocks = reduceLiveUpdates(blocks, [
    { kind: "event", id: "hook-1", label: "Hook finished", tone: "error" },
    {
      kind: "retract",
      ids: ["refused:0", "refused:1", "tool-refused", "missing"],
    },
    {
      kind: "tool-update",
      id: "tool-kept",
      status: "completed",
      output: "3 matches",
    },
    { kind: "text", id: "fallback:0", text: "Here is the parser." },
  ])
  assert.deepEqual(
    blocks.map((block) =>
      block.type === "event"
        ? `event:${block.label}`
        : block.type === "tool"
          ? `tool:${block.id}:${block.status}`
          : block.type
    ),
    ["user", "event:Hook finished", "tool:tool-kept:completed", "text"],
    "a marker with the same id replaces its own, and retracted blocks leave while later updates still find their tool"
  )
  const kept = reduceLiveUpdates(blocks, [
    { kind: "retract", ids: ["missing"] },
  ])
  assert.equal(kept, blocks, "retracting nothing that is shown changes nothing")
  console.log(
    "PASS: A repeated marker id replaces its marker, and a retraction removes exactly the named blocks"
  )
}

{
  const projection = new ClaudeProjection()
  const reply = (
    id: string,
    content: AssistantReply["content"],
    stop_reason: AssistantReply["stop_reason"]
  ): AssistantReply => ({
    id,
    type: "message",
    role: "assistant",
    model: "fixture",
    content,
    container: null,
    context_management: null,
    diagnostics: null,
    stop_details: null,
    stop_reason,
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
  })
  const message = (
    uuid: UUID,
    id: string,
    text: string,
    supersedes?: UUID[]
  ): SDKAssistantMessage => ({
    type: "assistant",
    parent_tool_use_id: null,
    uuid,
    session_id: "fixture",
    ...(supersedes && { supersedes }),
    message: reply(id, [
      { type: "text", text, citations: null },
      { type: "tool_use", id: `${id}-tool`, name: "Read", input: {} },
    ], "end_turn"),
  })
  const refusedUuid = randomUUID()
  const refused = message(
    refusedUuid,
    "msg-refused",
    "I can't help with that."
  )
  const shown = projection.project(refused)
  const fallback = message(
    randomUUID(),
    "msg-fallback",
    "Here is the parser.",
    [refusedUuid]
  )
  assert.deepEqual(claudeRetracted(fallback), [refusedUuid])
  assert.deepEqual(projection.retract(claudeRetracted(fallback)), [
    { kind: "retract", ids: ["msg-refused:0", "msg-refused-tool"] },
  ])
  assert.deepEqual(
    projection.retract([refusedUuid]),
    [],
    "a message is withdrawn once"
  )
  let blocks = reduceLiveUpdates(
    [],
    [{ kind: "user", text: "Write the parser" }, ...shown]
  )
  blocks = reduceLiveUpdates(blocks, [
    ...projection.retract(["uuid-unknown"]),
    { kind: "retract", ids: ["msg-refused:0", "msg-refused-tool"] },
    ...projection.project(fallback),
  ])
  assert.deepEqual(
    blocks.map((block) => (block.type === "text" ? block.text : block.type)),
    ["user", "Here is the parser.", "tool"],
    "the refused reply leaves the transcript and the fallback's stays"
  )
  console.log(
    "PASS: Claude's retraction of a refused reply removes the blocks that reply put in the transcript"
  )

  const stream = (event: StreamEvent): SDKMessage => ({
    type: "stream_event",
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: "fixture",
    event,
  })
  const streamed = new ClaudeProjection()
  const refusedStream = [
    stream({ type: "message_start", message: reply("msg-cut", [], null) }),
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "", citations: null },
    }),
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "I can't" },
    }),
    stream({ type: "message_start", message: reply("msg-retry", [], null) }),
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "", citations: null },
    }),
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Here is" },
    }),
  ].flatMap((event) => streamed.project(event))
  const retry = message(randomUUID(), "msg-retry", "Here is the parser.", [])
  const withdrawn = streamed.withdraw(retry)
  assert.deepEqual(
    withdrawn,
    [{ kind: "retract", ids: ["msg-cut:0"] }],
    "a refused reply that only streamed leaves, and the fallback's own stream stays"
  )
  blocks = reduceLiveUpdates(
    [],
    [{ kind: "user", text: "Write the parser" }, ...refusedStream, ...withdrawn]
  )
  assert.deepEqual(
    blocks.map((block) => (block.type === "text" ? block.text : block.type)),
    ["user", "Here is"]
  )
  streamed.project(retry)
  const notice: SDKModelRefusalFallbackMessage = {
    type: "system",
    subtype: "model_refusal_fallback",
    trigger: "refusal",
    direction: "retry",
    original_model: "claude-opus",
    fallback_model: "claude-sonnet",
    request_id: null,
    retracted_message_uuids: [],
    content: "",
    uuid: randomUUID(),
    session_id: "fixture",
  }
  assert.deepEqual(
    streamed.withdraw(notice),
    [],
    "the turn-end notice finds nothing left to withdraw"
  )
  assert.deepEqual(
    streamed.withdraw(message(randomUUID(), "msg-plain", "Hi")),
    [],
    "an ordinary reply withdraws nothing"
  )
  console.log(
    "PASS: A refused reply that only streamed leaves the transcript when Claude falls back"
  )
}

{
  const failed = mcpServerFailedEvent("axiom", "sign-in required")
  const configWarning: LiveUpdate = {
    kind: "event",
    label: "Warning",
    detail: "Codex is ignoring 2 settings",
    tone: "warning",
    setup: true,
  }
  const rerouted: LiveUpdate = {
    kind: "event",
    id: "reroute",
    label: "Model changed",
    detail: "a → b",
  }
  // A session start reports setup; a wake after hibernation starts another and reports it again.
  const start = (): LiveUpdate[] => [
    { kind: "event", id: "first-start", ...failed },
    configWarning,
  ]
  let blocks = reduceLiveUpdates(
    [],
    [{ kind: "user", text: "one" }, ...start(), rerouted]
  )
  blocks = reduceLiveUpdates(blocks, [
    { kind: "user", text: "two" },
    { kind: "event", id: "woken", ...failed },
    configWarning,
    rerouted,
  ])
  blocks = reduceLiveUpdates(blocks, [
    { kind: "user", text: "three" },
    { ...configWarning, body: "worded again" },
  ])
  const events = blocks.flatMap((block) =>
    block.type === "event"
      ? [`${block.label}: ${block.detail}${block.setup ? " (setup)" : ""}`]
      : []
  )
  assert.deepEqual(
    events,
    [
      "MCP server failed: axiom · sign-in required (setup)",
      "Warning: Codex is ignoring 2 settings (setup)",
      "Model changed: a → b",
      "Model changed: a → b",
    ],
    "a conversation keeps one of each setup notice across turns and session starts; a turn's own marker repeats per turn"
  )
  blocks = reduceLiveUpdates(blocks, [
    { kind: "event", ...mcpServerFailedEvent("axiom", "connection refused") },
  ])
  assert.equal(
    blocks.filter((block) => block.type === "event" && block.setup).length,
    3,
    "the same server failing for another reason is a new notice"
  )
  console.log(
    "PASS: Setup notices are kept once per conversation, however many session starts report them"
  )
}

{
  // Each harness's own words for a server that did not start, as they arrive.
  const said: Array<[string, string]> = [
    [
      "MCP startup failed: handshaking with MCP server failed: Send message error Transport [codex_rmcp_client] error",
      "could not connect",
    ],
    [
      "handshake failed: connection closed: initialize response",
      "could not connect",
    ],
    ["MCP error -32000: Connection closed", "could not connect"],
    ["connection closed: initialize response", "could not connect"],
    ["could not connect", "could not connect"],
    ["NotFound: ChildProcess.spawn (docs-mcp )", "could not be launched"],
    ["spawn docs-mcp ENOENT", "could not be launched"],
    ["cannot find binary path", "could not be launched"],
    ["startup timeout", "timed out"],
    ["needs_auth", "sign-in required"],
    ["sign-in required", "sign-in required"],
    ["setup_required", "setup required"],
    ["Invalid config", "Invalid config"],
  ]
  for (const [reason, words] of said) {
    const marker = mcpServerFailedEvent("docs", reason)
    assert.equal(marker.detail, `docs · ${words}`, reason)
    assert.equal(
      marker.body,
      words === reason ? undefined : reason,
      "the harness's own words stay in the body"
    )
  }
  console.log(
    "PASS: A server that did not start reads in the same words on every harness, its harness's own in the body"
  )
}

{
  const notices = new ClaudeNotices()
  const init = (status: string): SDKMessage => ({
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    claude_code_version: "2.0.0",
    cwd: "/tmp",
    tools: [],
    mcp_servers: [
      { name: "linear", status },
      { name: "docs", status: "connected" },
      { name: "drive", status: "needs-auth" },
    ],
    plugin_errors: [
      { plugin: "shipit", type: "load", message: "manifest missing" },
    ],
    model: "claude-opus-5",
    permissionMode: "default",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: randomUUID(),
    session_id: "fixture",
  })
  const markers = (message: SDKMessage) =>
    (notices.decode(message) ?? []).flatMap((notice) =>
      notice.kind === "event" ? [notice.event] : []
    )
  assert.deepEqual(
    markers(init("failed")).map((marker) => [
      marker.label,
      marker.detail,
      marker.setup,
    ]),
    [
      ["MCP server failed", "linear · could not connect", true],
      ["MCP server failed", "drive · sign-in required", true],
      ["shipit plugin didn't load", "manifest missing", true],
    ],
    "Claude's init reports servers and plugins that did not start as setup notices"
  )
  assert.deepEqual(
    markers(init("failed")),
    [],
    "the next turn's init repeats nothing"
  )
  assert.deepEqual(
    markers(init("pending")),
    [],
    "a server still starting is not a failure"
  )
  console.log(
    "PASS: Claude's MCP servers and plugins that did not start are setup notices, once per session"
  )
}

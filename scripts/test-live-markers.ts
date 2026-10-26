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
import { createLiveEngine, type EngineLive } from "@mako/host/harnesses/live-engine"
import { mcpServerFailedEvent } from "@mako/sessions/events"
import {
  ClaudeProjection,
  claudeRetracted,
} from "@mako/sessions/claude-projection"
import { ClaudeNotices } from "@mako/host/harnesses/claude/sdk-notices"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import { sessionDelta } from "@mako/host/contracts/live-conversations"

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

  // A harness that measures what a compaction left only later (Cursor's next
  // checkpoint) completes the marker it drew: the same id again, with what it
  // adds, which the reducer draws over the first in place. A replay of the
  // first statement adds nothing and draws nothing.
  const completing = session()
  engine.compacted(completing.live, { summary: "Read one.txt so far.", tokensBefore: 188_331 }, "window-1")
  completing.live.emit({ type: "live-update", id: completing.live.state.id, update: { kind: "text", text: "Reading two.txt." } })
  engine.compacted(completing.live, { summary: "Read one.txt so far.", tokensBefore: 188_331, tokensAfter: 100_947 }, "window-1")
  engine.compacted(completing.live, { summary: "Read one.txt so far.", tokensBefore: 188_331 }, "window-1")
  assert.deepEqual(completing.markers().map((marker) => [marker.id, marker.detail]), [
    ["window-1", "from 188k tokens"],
    ["window-1", "188k → 101k tokens"],
  ], "the marker is completed once, and a replay of its first statement adds nothing")
  const completed = reduceLiveUpdates([], completing.events.flatMap((event) => event.type === "live-update" ? [event.update] : []))
  assert.deepEqual(completed.map((entry) => entry.type === "event" ? [entry.type, entry.detail, entry.body] : [entry.type]), [
    ["event", "188k → 101k tokens", "Read one.txt so far."],
    ["text"],
  ], "the window draws one marker, completed where it was first drawn")

  // Measured by the next run: the completion arrives in a later turn and
  // completes the marker in the earlier one; a completion whose marker these
  // blocks don't hold (a reopened conversation, which shows it from the
  // record) draws nothing.
  const later = session()
  engine.compacted(later.live, { tokensBefore: 190_997 }, "window-2")
  later.live.emit({ type: "live-update", id: later.live.state.id, update: { kind: "user", text: "And two.txt." } })
  engine.compacted(later.live, { tokensBefore: 190_997, tokensAfter: 23_418 }, "window-2", true)
  const across = reduceLiveUpdates([], later.events.flatMap((event) => event.type === "live-update" ? [event.update] : []))
  assert.deepEqual(across.map((entry) => entry.type === "event" ? [entry.type, entry.detail] : [entry.type]), [
    ["event", "191k → 23k tokens"],
    ["user"],
  ], "a later turn's measure completes the marker in its own turn")
  const reopened = session()
  engine.compacted(reopened.live, { tokensBefore: 190_997, tokensAfter: 23_418 }, "window-3", true)
  assert.equal(reopened.markers()[0]?.completes, true, "a completion is said to be one")
  assert.deepEqual(reduceLiveUpdates([{ type: "text", text: "Earlier." }], reopened.events.flatMap((event) => event.type === "live-update" ? [event.update] : [])).map((entry) => entry.type), ["text"], "with no marker to complete it draws nothing")

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

  // A provider's retries end in one quiet marker, drawn before what ended
  // them: the model's answer (recovered) or the failure it gave up on, which
  // says the failure itself, so the provider's words appear once.
  const updates = (events: LiveDriverEvent[]) => events.flatMap((event) => event.type === "live-update" ? [event.update] : event.type === "live-updates" ? event.updates : [])
  const recovered = session()
  at(10_000)
  engine.activity(recovered.live, { kind: "retrying", attempt: 1, maxAttempts: 10, reason: "Overloaded (529)" })
  at(12_000)
  engine.activity(recovered.live, { kind: "retrying", attempt: 1, maxAttempts: 10, reason: "Overloaded (529)" })
  at(20_000)
  engine.activity(recovered.live, { kind: "retrying", attempt: 2, maxAttempts: 10 })
  engine.activity(recovered.live, { kind: "retrying", attempt: 3, maxAttempts: 10 })
  at(51_000)
  engine.emitUpdates(recovered.live, [{ kind: "text", text: "" }])
  assert.deepEqual(recovered.markers(), [], "an empty text is no answer")
  engine.emitUpdates(recovered.live, [{ kind: "text", text: "Here it is." }])
  engine.emitUpdate(recovered.live, { kind: "text", text: " More." })
  assert.deepEqual(
    updates(recovered.events).map((update) => update.kind === "event" ? [update.kind, update.label, update.detail, update.tone, update.retries] : [update.kind]),
    [
      ["text"],
      ["event", "Recovered after 3 retries", "Overloaded (529)", undefined, { count: 3, outcome: "recovered", durationMs: 41_000 }],
      ["text"],
      ["text"],
    ],
    "recovered once the model answers, measured from the first retry, a repeated attempt counted once, drawn before the answer and only once"
  )

  const gaveUp = session()
  at(0)
  engine.activity(gaveUp.live, { kind: "retrying", attempt: 1, reason: "Server error" })
  at(62_000)
  engine.activity(gaveUp.live, null)
  engine.observe(gaveUp.live, "retry_state", [{ kind: "event", event: { label: "Turn failed", detail: "Server error", tone: "error" } }], "update-9")
  assert.deepEqual(
    gaveUp.markers().map((marker) => [marker.label, marker.detail, marker.tone, marker.retries]),
    [
      ["Retried once", undefined, undefined, { count: 1, outcome: "gave-up", durationMs: 62_000 }],
      ["Turn failed", "Server error", "error", undefined],
    ],
    "the provider's failure ends the retries quietly; its words are the failure's, said once"
  )
  const otherWords = session()
  engine.activity(otherWords.live, { kind: "retrying", attempt: 1, reason: "Overloaded (529)" })
  engine.activity(otherWords.live, { kind: "retrying", attempt: 2 })
  engine.event(otherWords.live, { label: "API error", detail: "Claude's servers didn't answer", tone: "error" })
  assert.deepEqual(otherWords.markers().map((marker) => [marker.label, marker.detail, marker.tone]), [
    ["Retried 2 times", "Overloaded (529)", undefined],
    ["API error", "Claude's servers didn't answer", "error"],
  ], "what it retried on stays beside the count when the failure says something else")

  // Codex says it gave up in the session's error, before the failure marker; its retries name no reason.
  const errored = session()
  at(0)
  engine.activity(errored.live, { kind: "retrying", attempt: 1, maxAttempts: 5 })
  engine.activity(errored.live, { kind: "retrying", attempt: 2, maxAttempts: 5 })
  at(9_000)
  engine.patch(errored.live, { error: "We're currently experiencing high demand.\nTry again later." })
  engine.event(errored.live, { label: "Turn failed", detail: "Server error", tone: "error" })
  assert.deepEqual(
    errored.markers().map((marker) => [marker.label, marker.detail, marker.retries?.durationMs]),
    [
      ["Retried 2 times", undefined, 9_000],
      ["Turn failed", "Server error", undefined],
    ],
    "an error in the session's state gives up; the error is the failure's to say"
  )

  // A turn that ends another way (a Stop, a process gone) ends its retries unsaid, and the next turn's answer is no recovery.
  const stopped = session()
  engine.activity(stopped.live, { kind: "retrying", attempt: 1 })
  engine.patch(stopped.live, { status: "ready", lastStop: "cancelled" })
  engine.patch(stopped.live, { status: "running" })
  engine.emitUpdate(stopped.live, { kind: "text", text: "A new turn." })
  assert.deepEqual(stopped.markers(), [], "nothing is said of retries a Stop cut short")
  console.log("PASS: a provider's retries end in one quiet marker: recovered when the model answers, retried before the failure without repeating its words, unsaid when the turn ends otherwise")
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
  // A conversation switched from Claude Code to Devin: each harness configures its own servers (session flows, 2026-10-17).
  const nia = mcpServerFailedEvent("nia", "could not connect")
  let switched = reduceLiveUpdates([], [
    { kind: "user", text: "Remember the marker." },
    { kind: "event", ...nia, source: { harness: "claude", record: "c1" } },
  ])
  switched = reduceLiveUpdates(switched, [
    { kind: "user", text: "Which marker?" },
    { kind: "event", ...nia, source: { harness: "codex", record: "x1" } },
    { kind: "event", ...nia, source: { harness: "codex", record: "x2" } },
  ])
  // Devin says it twice and names no source.
  switched = reduceLiveUpdates(switched, [
    { kind: "user", text: "And now?" },
    { kind: "event", ...nia },
    { kind: "event", ...nia },
  ])
  assert.deepEqual(
    switched.flatMap((block) => (block.type === "event" ? [block.source?.harness ?? "unnamed"] : [])),
    ["claude", "codex", "unnamed"],
    "the same notice from another harness is that harness's own fact, kept once for it"
  )
  console.log(
    "PASS: Setup notices are kept once per conversation and harness, however many session starts report them"
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

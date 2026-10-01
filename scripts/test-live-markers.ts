import type { SDKAssistantMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mock } from "node:test"
import { reduceLiveUpdates, type LiveUpdate } from "../electron/contracts/live-content.ts"
import { createLiveEngine, type EngineLive } from "../electron/live-engine.ts"
import { ClaudeProjection, claudeRetracted } from "../electron/providers/claude/sdk-projection.ts"
import type { LiveDriverEvent, LiveSessionState } from "../electron/shared.ts"

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
  const markers = () => events.flatMap((event) => event.type === "live-update" && event.update.kind === "event" ? [event.update] : [])
  return { live, events, markers }
}

const clock = mock.method(Date, "now", () => 0)
const at = (ms: number) => clock.mock.mockImplementation(() => ms)
try {
  const engine = createLiveEngine<EngineLive>()

  const claude = session()
  at(1_000)
  engine.activity(claude.live, { kind: "compacting" })
  at(20_000)
  engine.activity(claude.live, { kind: "retrying", attempt: 2, reason: "Overloaded" })
  at(73_000)
  engine.compacted(claude.live, { trigger: "manual" }, "boundary")
  assert.deepEqual(claude.markers(), [{ kind: "event", id: "boundary", label: "Context compacted", detail: "Manual · took 1m 12s" }],
    "compacting is measured from its start to the boundary; a retry on the way is part of it")

  const cursor = session()
  at(0)
  engine.activity(cursor.live, { kind: "compacting" })
  at(8_500)
  engine.activity(cursor.live, null)
  at(9_200)
  engine.compacted(cursor.live, { summary: "Kept the plan" }, "turn:3")
  engine.compacted(cursor.live, { summary: "Kept the plan" }, "turn:3")
  assert.deepEqual(cursor.markers(), [{ kind: "event", id: "turn:3", label: "Context compacted", detail: "took 8s", body: "Kept the plan" }],
    "a summary after compacting stopped still takes its measure, and the same event replayed is drawn once")

  const reported = session()
  engine.activity(reported.live, { kind: "compacting" })
  at(30_000)
  engine.compacted(reported.live, { durationMs: 94_952 })
  assert.equal(reported.markers()[0]?.detail, "took 1m 34s", "a duration the provider recorded wins over the measured one")

  const abandoned = session()
  at(0)
  engine.activity(abandoned.live, { kind: "compacting" })
  engine.patch(abandoned.live, { status: "ready" })
  at(600_000)
  engine.compacted(abandoned.live, { trigger: "automatic" })
  const quick = session()
  engine.activity(quick.live, { kind: "compacting" })
  engine.compacted(quick.live, { trigger: "automatic" })
  assert.deepEqual([...abandoned.markers(), ...quick.markers()].map((marker) => marker.detail), ["Automatic", "Automatic"],
    "a completion long after an abandoned compaction's turn ended, or under a second, claims no duration")

  const noticed = session()
  engine.observe(noticed.live, "status", [
    { kind: "event", event: { label: "Model changed", detail: "after a refusal" } },
    { kind: "event", event: { label: "Hook failed" } },
  ], "message-1")
  engine.observe(noticed.live, "status", [{ kind: "event", event: { label: "Model changed", detail: "after a refusal" } }], "message-1")
  engine.observe(noticed.live, "status", [{ kind: "event", event: { label: "Unnamed" } }])
  engine.observe(noticed.live, "status", [{ kind: "event", event: { label: "Unnamed" } }])
  assert.deepEqual(noticed.markers().map((marker) => marker.id), ["message-1", "message-1:2", undefined, undefined],
    "each marker of one native event has its own id; events without one are never merged")
  console.log("PASS: The engine measures compaction across retries and late summaries, and draws a replayed native event once")
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
    { kind: "retract", ids: ["refused:0", "refused:1", "tool-refused", "missing"] },
    { kind: "tool-update", id: "tool-kept", status: "completed", output: "3 matches" },
    { kind: "text", id: "fallback:0", text: "Here is the parser." },
  ])
  assert.deepEqual(blocks.map((block) => block.type === "event" ? `event:${block.label}` : block.type === "tool" ? `tool:${block.id}:${block.status}` : block.type),
    ["user", "event:Hook finished", "tool:tool-kept:completed", "text"],
    "a marker with the same id replaces its own, and retracted blocks leave while later updates still find their tool")
  const kept = reduceLiveUpdates(blocks, [{ kind: "retract", ids: ["missing"] }])
  assert.equal(kept, blocks, "retracting nothing that is shown changes nothing")
  console.log("PASS: A repeated marker id replaces its marker, and a retraction removes exactly the named blocks")
}

{
  const projection = new ClaudeProjection()
  const message = (uuid: string, id: string, text: string, supersedes?: string[]): SDKAssistantMessage => ({
    type: "assistant",
    parent_tool_use_id: null,
    uuid,
    session_id: "fixture",
    ...(supersedes && { supersedes }),
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "fixture",
      content: [{ type: "text", text, citations: null }, { type: "tool_use", id: `${id}-tool`, name: "Read", input: {} }],
      container: null,
      context_management: null,
      diagnostics: null,
      stop_details: null,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 1, output_tokens: 1, cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null,
        fallback_credit: null, inference_geo: null, iterations: null, output_tokens_details: null, server_tool_use: null, service_tier: null, speed: null,
      },
    },
  })
  const refused = message("uuid-refused", "msg-refused", "I can't help with that.")
  const shown = projection.project(refused)
  const fallback = message("uuid-fallback", "msg-fallback", "Here is the parser.", ["uuid-refused"])
  assert.deepEqual(claudeRetracted(fallback), ["uuid-refused"])
  assert.deepEqual(projection.retract(claudeRetracted(fallback)), [{ kind: "retract", ids: ["msg-refused:0", "msg-refused-tool"] }])
  assert.deepEqual(projection.retract(["uuid-refused"]), [], "a message is withdrawn once")
  let blocks = reduceLiveUpdates([], [{ kind: "user", text: "Write the parser" }, ...shown])
  blocks = reduceLiveUpdates(blocks, [...projection.retract(["uuid-unknown"]), { kind: "retract", ids: ["msg-refused:0", "msg-refused-tool"] }, ...projection.project(fallback)])
  assert.deepEqual(blocks.map((block) => block.type === "text" ? block.text : block.type), ["user", "Here is the parser.", "tool"],
    "the refused reply leaves the transcript and the fallback's stays")
  console.log("PASS: Claude's retraction of a refused reply removes the blocks that reply put in the transcript")

  const stream = (event: unknown) => ({ type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), session_id: "fixture", event }) as SDKMessage
  const streamed = new ClaudeProjection()
  const refusedStream = [
    stream({ type: "message_start", message: { id: "msg-cut" } }),
    stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I can't" } }),
    stream({ type: "message_start", message: { id: "msg-retry" } }),
    stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Here is" } }),
  ].flatMap((event) => streamed.project(event))
  const retry = message("uuid-retry", "msg-retry", "Here is the parser.", [])
  const withdrawn = streamed.withdraw(retry)
  assert.deepEqual(withdrawn, [{ kind: "retract", ids: ["msg-cut:0"] }],
    "a refused reply that only streamed leaves, and the fallback's own stream stays")
  blocks = reduceLiveUpdates([], [{ kind: "user", text: "Write the parser" }, ...refusedStream, ...withdrawn])
  assert.deepEqual(blocks.map((block) => block.type === "text" ? block.text : block.type), ["user", "Here is"])
  streamed.project(retry)
  const notice = { type: "system", subtype: "model_refusal_fallback", retracted_message_uuids: [] } as unknown as SDKMessage
  assert.deepEqual(streamed.withdraw(notice), [], "the turn-end notice finds nothing left to withdraw")
  assert.deepEqual(streamed.withdraw(message("uuid-plain", "msg-plain", "Hi")), [], "an ordinary reply withdraws nothing")
  console.log("PASS: A refused reply that only streamed leaves the transcript when Claude falls back")
}

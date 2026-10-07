import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type {
  SDKAssistantMessage,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk"
import type { JsonValue } from "../electron/codex-app-json.js"
import { ClaudeProjection } from "@mako/sessions/claude-projection"
import {
  deliverLiveUpdates,
  reduceLiveUpdates,
  type LiveBlock,
  type LiveUpdate,
} from "@mako/sessions/live-content"
import { decoderFor, loadFixtures } from "./native-decoding.js"
import { auditId } from "./performance-audit-fixtures.js"

/** Input and output characters a growing call may send per character it gains: only the new ones. */
const MAX_AMPLIFICATION = 1

const assistant: SDKAssistantMessage = {
  type: "assistant",
  parent_tool_use_id: null,
  uuid: auditId(1),
  session_id: "fixture",
  message: {
    id: "message",
    type: "message",
    role: "assistant",
    model: "fixture",
    content: [],
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
function streamed(
  event: Extract<SDKMessage, { type: "stream_event" }>["event"]
): SDKMessage {
  return {
    type: "stream_event",
    uuid: auditId(2),
    session_id: "fixture",
    parent_tool_use_id: null,
    event,
  }
}
const chunks = 64,
  chunk = "x".repeat(256)
const { files } = await loadFixtures()

/**
 * A call that grows by `chunks` frames, each in its own batch, through the
 * harness's decoder and the host's delivery. `content` is the input and
 * output characters sent per character the call gained; `framing` what each
 * delivered frame adds around them. `open` steps of the fixture start the call.
 */
/** Content characters sent per new character, and the characters of framing each frame adds. */
interface Amplification {
  content: number
  framing: number
}

function amplification(fixtureName: string, open: number, frame: (index: number) => JsonValue): Amplification {
  const file = files.find((candidate) => candidate.name === fixtureName)
  assert.ok(file, `No fixture ${fixtureName}`)
  const decoder = decoderFor(file.fixture.harness).open(file.fixture.session)
  const updatesOf = (message: JsonValue): LiveUpdate[] =>
    decoder.decode(message).flatMap((item) => (item.kind === "update" ? [item.update] : []))
  let blocks: LiveBlock[] = []
  for (const step of file.fixture.steps.slice(0, open)) blocks = reduceLiveUpdates(blocks, updatesOf(step.message))
  let sent = 0
  let content = 0
  for (let index = 0; index < chunks; index++) {
    const delivery = deliverLiveUpdates(blocks, updatesOf(frame(index)))
    assert.ok(delivery.updates.length, `${fixtureName}: frame ${index} delivered nothing`)
    blocks = delivery.blocks
    for (const update of delivery.updates) {
      sent += JSON.stringify(update).length
      if (update.kind === "tool-update")
        content += (update.input?.length ?? 0) + (update.inputAppend?.length ?? 0) + (update.output?.length ?? 0) + (update.outputAppend?.length ?? 0)
    }
  }
  return { content: content / (chunks * chunk.length), framing: Math.round((sent - content) / chunks) }
}
const AcpStep = z.object({ params: z.object({ sessionId: z.string(), update: z.object({ toolCallId: z.string() }) }) })
function acpWhole(fixtureName: string, step: number) {
  const file = files.find((candidate) => candidate.name === fixtureName)
  const { params } = AcpStep.parse(file?.fixture.steps[step]?.message)
  return (index: number): JsonValue => ({
    method: "session/update",
    params: { sessionId: params.sessionId, update: {
      sessionUpdate: "tool_call_update", toolCallId: params.update.toolCallId, status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: chunk.repeat(index + 1) } }],
    } },
  })
}
const harnessAmplification = {
  claude: amplification("claude/plan-turn", 16, () => ({
    type: "stream_event", session_id: "uuid-3", parent_tool_use_id: null, uuid: "uuid-19",
    event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: chunk } },
  })),
  codex: amplification("codex/turn-lifecycle", 9, () => ({
    method: "item/commandExecution/outputDelta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", delta: chunk },
  })),
  cursor: amplification("cursor/thinking-agents-compaction", 8, () => ({
    event: "delta", turn: "turn-1", delta: { type: "shell-output", text: chunk },
  })),
  grok: amplification("grok/plan-mode", 2, acpWhole("grok/plan-mode", 2)),
  devin: amplification("devin/plan-approved", 7, acpWhole("devin/plan-approved", 7)),
}
for (const [harness, { content }] of Object.entries(harnessAmplification))
  assert.ok(content <= MAX_AMPLIFICATION, `${harness}: a growing call sends ${content.toFixed(2)} characters of its input or output per new one; the budget is ${MAX_AMPLIFICATION}`)
const text = "x".repeat(200_000)
const long = new ClaudeProjection()
long.project(streamed({ type: "message_start", message: assistant.message }))
long.project(
  streamed({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "", citations: null },
  })
)
const blocks = reduceLiveUpdates(
  [],
  long.project(
    streamed({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    })
  )
)
const final = reduceLiveUpdates(
  blocks,
  long.project({
    ...assistant,
    message: {
      ...assistant.message,
      content: [{ type: "text", text, citations: null }],
    },
  })
)
const streamedText = blocks.find((block) => block.type === "text")
const finalText = final.find((block) => block.type === "text")
assert.ok(streamedText?.type === "text" && finalText?.type === "text")
assert.ok(
  finalText.text === text,
  "Final provider output must preserve the complete streamed answer"
)
const completeTool = new ClaudeProjection()
const toolInput = JSON.stringify({ content: text })
const toolStart = completeTool.project({
  ...assistant,
  message: {
    ...assistant.message,
    id: "large-tool",
    content: [
      {
        type: "tool_use",
        id: "large",
        name: "Write",
        input: { content: text },
      },
    ],
  },
})
assert.ok(
  toolStart.some(
    (update) => update.kind === "tool" && update.input === toolInput
  ),
  "Final tool input reaches the host's durable artifact boundary intact"
)
const toolResult = completeTool.project({
  type: "user",
  uuid: auditId(3),
  session_id: "fixture",
  parent_tool_use_id: null,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "large", content: text }],
  },
})
assert.ok(
  toolResult.some(
    (update) => update.kind === "tool-update" && update.output === text
  ),
  "Final tool output reaches the host's durable artifact boundary intact"
)
const report = {
  source:
    "Actual SDK/app-server projection functions with synthetic protocol frames; no provider prompt sent",
  chunks,
  incomingTextBytes: chunks * chunk.length,
  /** Per streaming harness; OpenCode reports a call's output once, when it ends. */
  amplification: harnessAmplification,
  claudeLongAnswer: {
    streamedChars: streamedText.text.length,
    finalChars: finalText.text.length,
  },
}
const root = await mkdtemp(join(tmpdir(), "mako-payload-performance-"))
await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
console.log(`Provider payload evidence: ${join(root, "result.json")}`)

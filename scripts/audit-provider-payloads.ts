import assert from "node:assert/strict"
import { LineAssembler } from "@mako/sessions"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  SDKAssistantMessage,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { ClaudeProjection } from "../electron/providers/claude/sdk-projection.js"
import {
  consumeStdout,
  MAX_STDOUT_BUFFER,
  type ProtocolContext,
} from "../electron/codex-app-protocol.js"
import {
  reduceLiveUpdates,
  type LiveUpdate,
} from "../electron/contracts/live-content.js"
import { auditId, auditSnapshot } from "./performance-audit-fixtures.js"

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
const claude = new ClaudeProjection()
claude.project(streamed({ type: "message_start", message: assistant.message }))
claude.project(
  streamed({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "tool", name: "Write", input: {} },
  })
)
let claudeBytes = 0
for (let index = 0; index < chunks; index++) {
  const updates = claude.project(
    streamed({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: chunk },
    })
  )
  for (const update of updates)
    if (update.kind === "tool-update")
      claudeBytes += Buffer.byteLength(update.input ?? "")
}
const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
  stdio: ["pipe", "pipe", "pipe"],
})
const exited = once(child, "exit")
const updates: LiveUpdate[] = []
const state = auditSnapshot(1, "codex").session
const context: ProtocolContext = {
  child,
  threadId: "thread",
  currentTurnId: "turn",
  state,
  nextRequestId: 0,
  pending: new Map(),
  items: new Map(),
  background: { running: new Set() },
  stdoutLines: new LineAssembler(MAX_STDOUT_BUFFER),
  exited: false,
  protocol: {
    observeAgents() {},
    handleFatal(message) {
      throw new Error(message)
    },
    updateState(patch) {
      Object.assign(state, patch)
    },
    emitUpdate(update) {
      updates.push(update)
    },
    handleServerRequest() {},
    resolveServerRequest() {},
    clearTurnServerRequests() {},
  },
}
let codexBytes = 0
try {
  for (let index = 0; index < chunks; index++) {
    consumeStdout(
      context,
      Buffer.from(
        JSON.stringify({
          method: "item/commandExecution/outputDelta",
          params: {
            threadId: "thread",
            turnId: "turn",
            itemId: "item",
            delta: chunk,
          },
        }) + "\n"
      )
    )
  }
  assert.equal(updates.length, chunks)
  for (const update of updates)
    if (update.kind === "tool-update")
      codexBytes += Buffer.byteLength(update.output ?? "")
} finally {
  child.kill("SIGTERM")
  await exited
}
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
  claudeToolInputBytes: claudeBytes,
  codexToolOutputBytes: codexBytes,
  amplification: codexBytes / (chunks * chunk.length),
  claudeLongAnswer: {
    streamedChars: streamedText.text.length,
    finalChars: finalText.text.length,
  },
}
const root = await mkdtemp(join(tmpdir(), "mako-payload-performance-"))
await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
console.log(`Provider payload evidence: ${join(root, "result.json")}`)

import assert from "node:assert/strict"
import { Session } from "node:inspector/promises"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeApprovalObserver } from "@mako/host/harnesses/claude/approval-observer"
import { claudeCommandLifecycle } from "@mako/host/harnesses/claude/sdk-message-kinds"

/**
 * What every message from Claude Code costs on its way past the checks that look at all of them, in bytes allocated:
 * two parses that failed on nearly every message took a host to 790 MB at 8 sessions where 417 MB would do. Bytes don't
 * vary with a runner's speed, so this limit needs no yardstick. It sits about three times over today's 1,370 and a
 * fifth of the 19,161 those parses cost. `bench:host-load` can't see this: its Fins write files, and no message
 * reaches a host parser there.
 */
const BYTES_PER_MESSAGE = 4_000
const MESSAGES = 20_000

const words = (chars: number) => "word ".repeat(chars / 5)
function messageOf(wire: string): SDKMessage {
  return JSON.parse(wire)
}
const base = { uuid: "u", session_id: "session", parent_tool_use_id: null }
const kinds = [
  messageOf(JSON.stringify({ ...base, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: words(1_500) }, { type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } }] } })),
  messageOf(JSON.stringify({ ...base, type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "word " } } })),
  messageOf(JSON.stringify({ ...base, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: words(2_000) }] } })),
  messageOf(JSON.stringify({ ...base, type: "result", subtype: "success", result: words(400), is_error: false, num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: {} })),
]

const observer = new ClaudeApprovalObserver("session", [], () => {})
const session = new Session()
session.connect()
await session.post("HeapProfiler.enable")
await session.post("HeapProfiler.startSampling", { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true })
for (let at = 0; at < MESSAGES; at += 1) {
  const message = kinds[at % kinds.length]!
  // As `sdk-driver` does: the lifecycle twice, once to acknowledge and once for a cancelled turn, then the observers.
  claudeCommandLifecycle(message)
  claudeCommandLifecycle(message)
  observer.observe(message)
}
const { profile } = await session.post("HeapProfiler.stopSampling")
session.disconnect()
type Sampled = { selfSize: number; children: Sampled[] }
const sum = (node: Sampled): number => node.children.reduce((total, child) => total + sum(child), node.selfSize)
const perMessage = Math.round(sum(profile.head) / MESSAGES)
assert.ok(perMessage <= BYTES_PER_MESSAGE, `a message cost ${perMessage} bytes, past ${BYTES_PER_MESSAGE}`)
console.log(`Claude messages: ${perMessage} bytes each past the checks every message meets, within ${BYTES_PER_MESSAGE}`)

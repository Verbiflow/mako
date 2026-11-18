// A message's model, reasoning level and fast lane reach the running Claude Code process only when they differ from
// what it has (`tune` in `harnesses/claude/sdk-driver.ts`): each is a round trip the message waits for, and the
// window sends its selection with every message. Counted here against a fake query: the launch's own selection costs
// nothing, a change costs one call that names only what changed, a new model takes the whole selection again, and a
// slash command, which may set them in the process itself, makes the next selection go whole.
//
//   npx tsx scripts/test-claude-tune.ts
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import { createClaudeSdkDriver } from "@mako/host/harnesses/claude/sdk-driver"
import type { SessionSettings } from "@mako/sessions/settings"
import { admitted } from "./fixtures/admitted-start.ts"

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
      else await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }
}

const home = await mkdtemp(join(tmpdir(), "mako-claude-tune-"))
const messages = new Messages()
const events: LiveDriverEvent[] = []
/** Every round trip the driver made to set the selection, in order. */
const calls: string[] = []
let input: AsyncIterator<SDKUserMessage> | undefined
const driver = createClaudeSdkDriver({
  available: () => true,
  configure: async () => ({ options: { env: { CLAUDE_CONFIG_DIR: home } }, account: { name: "fixture-launch" } }),
  configDir: () => home,
  query: async (options) => {
    input = options.prompt[Symbol.asyncIterator]()
    return {
      [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
      initializationResult: async () => ({ commands: [], agents: [], output_style: "default", available_output_styles: [], models: [], account: {} }),
      setModel: async (model) => { calls.push(`model ${model}`) },
      applyFlagSettings: async (settings) => { calls.push(`flags ${JSON.stringify(settings)}`) },
      setPermissionMode: async () => {},
      interrupt: async () => {},
      close: () => messages.close(),
    }
  },
})
const id = "tune-fixture"
const launch: SessionSettings = { model: "claude-one", options: { effort: "high", fast: false } }
await driver.start("/disposable", admitted("claude", { conversationId: id, tuning: launch, emit: (event) => events.push(event) }))
const status = () => events.findLast((event) => event.type === "live-session")?.session.status

/** One whole turn carrying `settings`, and the round trips it made before the message went. */
async function turn(text: string, settings: SessionSettings | undefined): Promise<string[]> {
  const before = calls.length
  const attempt = randomUUID()
  await driver.prompt(id, text, [], settings, { operationId: randomUUID(), attemptId: attempt, report: () => {} })
  const made = calls.slice(before)
  await input?.next()
  messages.send({
    type: "result", subtype: "success", uuid: randomUUID(), session_id: id,
    duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, result: "", stop_reason: "end_turn", total_cost_usd: 0,
    modelUsage: {}, permission_denials: [], queued_turn_count: 0, user_message_uuid: attempt, user_message_uuids: [attempt],
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      fallback_credit: { status: { type: "redeemed" } }, inference_geo: "", iterations: [], output_tokens_details: { thinking_tokens: 0 },
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 }, service_tier: "standard", speed: "standard" },
  })
  for (const deadline = Date.now() + 3_000; status() !== "ready"; await delay(5))
    if (Date.now() > deadline) throw new Error(`the turn "${text}" never ended (${status()})`)
  return made
}

try {
  assert.deepEqual(await turn("the launch's own selection", launch), [], "the process was launched with this selection: nothing is set again")
  assert.deepEqual(await turn("no selection", undefined), [], "a message that names none sets none")
  assert.deepEqual(await turn("reasoning changed", { model: "claude-one", options: { effort: "low", fast: false } }), ['flags {"effortLevel":"low"}'],
    "one round trip, naming only what changed")
  assert.deepEqual(await turn("the same again", { model: "claude-one", options: { effort: "low", fast: false } }), [], "an unchanged selection costs no round trip")
  assert.deepEqual(await turn("fast changed", { model: "claude-one", options: { effort: "low", fast: true } }), ['flags {"fastMode":true}'])
  assert.deepEqual(await turn("the same again", { model: "claude-one", options: { effort: "low", fast: true } }), [])
  assert.deepEqual(await turn("the model changed", { model: "claude-two", options: { effort: "low", fast: true } }), ["model claude-two", 'flags {"effortLevel":"low","fastMode":true}'],
    "a new model takes the reasoning level and the fast lane again, after it")
  assert.deepEqual(await turn("the same again", { model: "claude-two", options: { effort: "low", fast: true } }), [])
  assert.deepEqual(await turn("/effort max", { model: "claude-two", options: { effort: "low", fast: true } }), [], "the command itself goes under the selection the process has")
  assert.deepEqual(await turn("after a command", { model: "claude-two", options: { effort: "low", fast: true } }), ['flags {"effortLevel":"low","fastMode":true}'],
    "a command may have set them in the process: the next message's selection is set whole")
  assert.deepEqual(await turn("the same again", { model: "claude-two", options: { effort: "low", fast: true } }), [])
  const last = events.findLast((event) => event.type === "live-session")?.session.settings
  assert.deepEqual(last, { model: "claude-two", options: { effort: "low", fast: true } }, "the session says the selection it runs on")
  console.log("PASS: Claude's model, reasoning and fast lane are set when they change, not with every message")
} finally {
  await driver.close(id)
  await rm(home, { recursive: true, force: true })
}

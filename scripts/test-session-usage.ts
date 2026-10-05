import assert from "node:assert/strict"
import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk"
import { SessionUsage, carriedUsage, fromInclusiveCounts } from "../electron/session-usage.ts"
import { parseNotification } from "../electron/codex-app-parse.ts"
import { grokModelWindow, grokUsage, GROK_TICKS_PER_USD } from "../electron/providers/grok/usage.ts"
import { grokNotification } from "../electron/providers/grok/notifications.ts"
import { devinUsageUpdate } from "../electron/providers/devin/usage.ts"
import { claudeContextBreakdown } from "../electron/providers/claude/context-breakdown.ts"

// The meter: a call's tokens wait for the window they are measured against.
{
  const meter = new SessionUsage()
  assert.equal(meter.observe({ kind: "call", tokens: { input: 8, cacheRead: 30_000, cacheWrite: 2_000, output: 700 } }), undefined)
  assert.deepEqual(meter.observe({ kind: "window", size: 200_000 }), { used: 32_708, size: 200_000 })
  // The same reading again changes nothing, so nothing is sent.
  assert.equal(meter.observe({ kind: "window", size: 200_000 }), undefined)
  // Running totals replace; turn spend adds; reasoning is carried when any reading has it.
  meter.observe({ kind: "total", tokens: { input: 10, cacheRead: 1, cacheWrite: 2, output: 3 } })
  meter.observe({ kind: "spent", tokens: { input: 5, cacheRead: 5, cacheWrite: 0, output: 5, reasoning: 2 } })
  assert.deepEqual(meter.current?.tokens, { input: 15, cacheRead: 6, cacheWrite: 2, output: 8, reasoning: 2 })
  meter.observe({ kind: "costSpent", amount: 0.25, currency: "USD" }, { kind: "costSpent", amount: 0.5, currency: "USD" })
  assert.deepEqual(meter.current?.cost, { amount: 0.75, currency: "USD" })
  // A compaction that says what is left replaces the reading; one that does not marks it stale.
  assert.equal(meter.observe({ kind: "compacted", after: 9_000 })?.used, 9_000)
  assert.equal(meter.observe({ kind: "compacted" })?.compacted, true)
  const next = meter.observe({ kind: "context", used: 12_000 })
  assert.equal(next?.used, 12_000)
  assert.equal(next?.compacted, undefined)
  // A new conversation in place clears the fill and keeps what was spent.
  const reset = meter.observe({ kind: "reset" })
  assert.equal(reset?.used, undefined)
  assert.equal(reset?.size, undefined)
  assert.equal(reset?.tokens?.input, 15)
}

// OpenAI-style counts include cached input; Mako counts it apart.
assert.deepEqual(fromInclusiveCounts({ input: 21_221, cacheRead: 0, cacheWrite: 21_217, output: 286 }), { input: 4, cacheRead: 0, cacheWrite: 21_217, output: 286 })

// Codex 0.159: the context reading is the last request; the session's spend is the running total.
{
  const parsed = parseNotification("thread/tokenUsage/updated", {
    threadId: "t",
    tokenUsage: {
      total: { totalTokens: 50_000, inputTokens: 48_000, cachedInputTokens: 40_000, cacheWriteInputTokens: 0, outputTokens: 2_000, reasoningOutputTokens: 600 },
      last: { totalTokens: 21_000, inputTokens: 20_500, cachedInputTokens: 19_000, cacheWriteInputTokens: 0, outputTokens: 500, reasoningOutputTokens: 100 },
      modelContextWindow: 400_000,
    },
  })
  assert.ok(parsed && parsed.method === "thread/tokenUsage/updated")
  assert.equal(parsed.used, 21_000)
  assert.equal(parsed.size, 400_000)
  assert.deepEqual(parsed.total, { input: 8_000, cacheRead: 40_000, cacheWrite: 0, output: 2_000, reasoning: 600 })
}

// Grok 1.0.44, shaped as recorded: each call's context, each turn's spend, ticks at 10^10 per dollar.
{
  assert.deepEqual(grokUsage("response_completed", {
    sessionUpdate: "response_completed",
    usage: { input_tokens: 6_289, output_tokens: 277, cache_read_input_tokens: 12_032, cache_creation_input_tokens: 0, reasoning_tokens: 115 },
  }), [{ kind: "call", tokens: { input: 6_289, cacheRead: 12_032, cacheWrite: 0, output: 277, reasoning: 115 } }])
  assert.deepEqual(grokUsage("turn_completed", {
    sessionUpdate: "turn_completed",
    usage: { inputTokens: 105_961, outputTokens: 564, totalTokens: 106_525, cachedReadTokens: 85_248, cacheCreationTokens: 0, reasoningTokens: 239, modelCalls: 5, costUsdTicks: 297_275_600 },
  }), [
    { kind: "spent", tokens: { input: 20_713, cacheRead: 85_248, cacheWrite: 0, output: 564, reasoning: 239 } },
    { kind: "costSpent", amount: 297_275_600 / GROK_TICKS_PER_USD, currency: "USD" },
  ])
  assert.equal(297_275_600 / GROK_TICKS_PER_USD, 0.02972756)
  assert.deepEqual(grokUsage("auto_compact_started", { tokens_used: 403_803, context_window: 500_000 }), [{ kind: "context", used: 403_803, size: 500_000 }])
  assert.deepEqual(grokUsage("auto_compact_completed", { tokens_after: 41_000 }), [{ kind: "compacted", after: 41_000 }])
  const models = { currentModelId: "grok-4.7", availableModels: [{ modelId: "grok-4.6", _meta: { totalContextTokens: 128_000 } }, { modelId: "grok-4.7", _meta: { totalContextTokens: 256_000 } }] }
  assert.equal(grokModelWindow(models), 256_000)
  // The model list names no session: it is the process's, and Mako runs one session per process.
  assert.deepEqual(grokNotification("_x.ai/models/update", models), { kind: "_x.ai/models/update", connectionWide: true, notices: [], usage: [{ kind: "window", size: 256_000 }] })
  const turn = grokNotification("_x.ai/session_notification", { sessionId: "s", update: { sessionUpdate: "turn_completed", prompt_id: "p", stop_reason: "end_turn", usage: { inputTokens: 10, outputTokens: 2 } } })
  assert.deepEqual(turn?.notices, [])
  assert.deepEqual(turn?.usage, [{ kind: "spent", tokens: { input: 10, cacheRead: 0, cacheWrite: 0, output: 2 } }])
}

// Devin: the call's tokens ride in `_meta`; its subagent-tagged copy stays out of the main meter.
assert.deepEqual(devinUsageUpdate({ "cognition.ai/inputTokens": 12_238, "cognition.ai/outputTokens": 60, "cognition.ai/cachedReadTokens": 8_192 }), [
  { kind: "spent", tokens: { input: 4_046, cacheRead: 8_192, cacheWrite: 0, output: 60 } },
])
assert.equal(devinUsageUpdate({ "cognition.ai/inputTokens": 1, "cognition.ai/outputTokens": 1, "cognition.ai/subagent_context": { parentAgentId: "root" } }), null)
assert.deepEqual(devinUsageUpdate(undefined), [])

// Claude's `/context`: categories by kind, and the biggest servers and files inside them.
{
  const response = {
    categories: [
      { name: "System prompt", tokens: 3_000, color: "x", kind: "used" },
      { name: "MCP tools", tokens: 9_000, color: "x", kind: "used" },
      { name: "MCP tools (deferred)", tokens: 40_000, color: "x", kind: "deferred", isDeferred: true },
      { name: "Messages", tokens: 0, color: "x", kind: "used" },
      { name: "Free space", tokens: 150_000, color: "x", kind: "free" },
      { name: "Autocompact buffer", tokens: 33_000, color: "x", kind: "buffer" },
    ],
    totalTokens: 12_000,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    percentage: 6,
    gridRows: [],
    model: "claude",
    memoryFiles: [{ path: "/repo/CLAUDE.md", type: "Project", tokens: 1_500 }, { path: "/tiny.md", type: "User", tokens: 20 }],
    mcpTools: [
      { name: "mcp__a__one", serverName: "a", tokens: 5_000, isLoaded: true },
      { name: "mcp__a__two", serverName: "a", tokens: 1_000, isLoaded: true },
      { name: "mcp__b__one", serverName: "b", tokens: 3_000, isLoaded: true },
      { name: "mcp__c__one", serverName: "c", tokens: 9_000, isLoaded: false },
    ],
    agents: [],
    isAutoCompactEnabled: true,
    apiUsage: null,
  } satisfies SDKControlGetContextUsageResponse
  const breakdown = claudeContextBreakdown(response)
  assert.deepEqual(breakdown.categories.map((category) => category.name), ["System prompt", "MCP tools", "MCP tools (deferred)", "Free space", "Autocompact buffer"])
  assert.deepEqual(breakdown.items, [
    { group: "mcp", name: "a", tokens: 6_000 },
    { group: "mcp", name: "b", tokens: 3_000 },
    { group: "memory", name: "/repo/CLAUDE.md", tokens: 1_500 },
  ])
  assert.equal(breakdown.size, 200_000)
}

// A new process for the same conversation: the context holds, the spend was the old process's.
{
  const before = { harness: "claude", nativeId: "a", usage: { used: 40_000, size: 200_000, compacted: true, tokens: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 }, cost: { amount: 0.5, currency: "USD" } } }
  assert.deepEqual(carriedUsage(before, { harness: "claude", nativeId: "a" }), { used: 40_000, size: 200_000, compacted: true }, "A process that has reported nothing yet keeps the context as full as it was")
  assert.deepEqual(carriedUsage(before, { harness: "claude", nativeId: "a", usage: {} }), {}, "A reading the new process made, even an emptied one, is the reading")
  assert.equal(carriedUsage(before, { harness: "claude", nativeId: "b" }), undefined, "Another native session starts from nothing")
  assert.equal(carriedUsage(before, { harness: "codex", nativeId: "a" }), undefined, "Another harness starts from nothing")
  assert.equal(carriedUsage(before, { harness: "claude" }), undefined, "A session not yet bound carries nothing")
  assert.equal(carriedUsage({ ...before, usage: { tokens: before.usage.tokens } }, { harness: "claude", nativeId: "a" }), undefined, "Spend alone does not carry")
}

console.log("Session usage: one meter across harnesses, each harness's counts normalized, Grok cost in its own unit, Claude's context itemized, context carried across a process restart")

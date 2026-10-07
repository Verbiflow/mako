import assert from "node:assert/strict"
import type { SDKControlGetContextUsageResponse, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { OpenCodeEvent } from "@opencode/client"
import type { Decoded } from "../electron/contracts/native-decoding.ts"
import type { LiveSessionUsage } from "../electron/contracts/providers-acp.ts"
import { SessionUsage, carriedUsage, departedBinding, fromInclusiveCounts, restorableTotals, spendBetween } from "../electron/session-usage.ts"
import { CodexDecoder } from "../electron/providers/codex/decoder.ts"
import { OpenCodeDecoder } from "../electron/providers/opencode/decoder.ts"
import { ClaudeDecoder } from "../electron/providers/claude/decoder.ts"
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

// Devin: the call's tokens ride in `_meta`. Each main reading is repeated tagged `root`; a
// subagent's own call (recorded 2026-10-06: 1,977 in, 41 out) is tagged with its agent id.
assert.deepEqual(devinUsageUpdate({ "cognition.ai/inputTokens": 12_238, "cognition.ai/outputTokens": 60, "cognition.ai/cachedReadTokens": 8_192 }), {
  of: "agent", observations: [{ kind: "spent", tokens: { input: 4_046, cacheRead: 8_192, cacheWrite: 0, output: 60 } }],
})
// Devin 3000.10.23 spells the write count `cachedWriteTokens`, like the read count.
assert.deepEqual(devinUsageUpdate({ "cognition.ai/inputTokens": 12_238, "cognition.ai/outputTokens": 60, "cognition.ai/cachedReadTokens": 8_192, "cognition.ai/cachedWriteTokens": 2_000 }), {
  of: "agent", observations: [{ kind: "spent", tokens: { input: 2_046, cacheRead: 8_192, cacheWrite: 2_000, output: 60 } }],
})
assert.deepEqual(devinUsageUpdate({ "cognition.ai/inputTokens": 1, "cognition.ai/outputTokens": 1, "cognition.ai/subagent_context": { parentAgentId: "root" } }), { of: "repeat" })
assert.deepEqual(devinUsageUpdate({ "cognition.ai/inputTokens": 1_977, "cognition.ai/outputTokens": 41, "cognition.ai/subagent_context": { parentAgentId: "e7ab20e2" } }), {
  of: "subagent", observations: [{ kind: "spent", tokens: { input: 1_977, cacheRead: 0, cacheWrite: 0, output: 41 } }],
})
assert.deepEqual(devinUsageUpdate({ "cognition.ai/inputTokens": 5, "cognition.ai/outputTokens": 5, "cognition.ai/subagent_context": "unrecognised" }), { of: "repeat" }, "A tag Mako can't read is not counted twice")
assert.deepEqual(devinUsageUpdate(undefined), { of: "agent", observations: [] })

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

/** Every state patch's usage the decoded events carry, last one last. */
function readings(out: Decoded<unknown>[]): LiveSessionUsage[] {
  return out.flatMap((item) => item.kind === "state" && item.patch.usage ? [item.patch.usage] : [])
}
const breakdown = (input: number, cached: number, output: number) =>
  ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0 })

// Codex 0.159, as recorded across a restart: the total is the thread's, and a
// resumed app-server first repeats its last reading under the turn that made it.
{
  const usage = (turnId: string, last: ReturnType<typeof breakdown>, total: ReturnType<typeof breakdown>) =>
    ({ method: "thread/tokenUsage/updated", params: { threadId: "t", turnId, tokenUsage: { last, total, modelContextWindow: 400_000 } } })
  const first = new CodexDecoder({ threadId: "t", state: {} })
  first.decode({ method: "turn/started", params: { threadId: "t", turn: { id: "turn-1", items: [], status: "inProgress" } } })
  assert.deepEqual(readings(first.decode(usage("turn-1", breakdown(18_900, 18_000, 26), breakdown(18_900, 18_000, 26)))).at(-1)?.tokens,
    { input: 900, cacheRead: 18_000, cacheWrite: 0, output: 26 }, "A new thread's first call counts itself")
  assert.deepEqual(readings(first.decode(usage("turn-1", breakdown(18_940, 18_500, 24), breakdown(37_840, 36_500, 50)))).at(-1)?.tokens,
    { input: 1_340, cacheRead: 36_500, cacheWrite: 0, output: 50 }, "Each later call adds what the thread total grew by")

  const resumed = new CodexDecoder({ threadId: "t", state: {} })
  const seed = readings(resumed.decode(usage("turn-1", breakdown(18_940, 18_500, 24), breakdown(37_840, 36_500, 50))))
  assert.equal(seed.at(-1)?.tokens, undefined, "The resumed thread's repeat of its last reading spends nothing")
  resumed.decode({ method: "turn/started", params: { threadId: "t", turn: { id: "turn-2", items: [], status: "inProgress" } } })
  const spent = readings(resumed.decode(usage("turn-2", breakdown(22_540, 20_000, 23), breakdown(60_380, 56_500, 73)))).at(-1)
  assert.deepEqual(spent?.tokens, { input: 2_540, cacheRead: 20_000, cacheWrite: 0, output: 23 }, "The first call after a wake is charged once, not with the thread's history")
  assert.deepEqual(spendBetween(undefined, spent).tokens, spent?.tokens)
}

// OpenCode: each step's own spend, the root's and its subagents'; the session's total outlives the process and is not spend.
{
  const decoder = new OpenCodeDecoder("root", "/repo", { launchAccess: "full", contextSize: () => 200_000 })
  decoder.children.add("child")
  const step = (sessionID: string, input: number, read: number, cost: number) => ({
    id: `e-${sessionID}-${input}`, created: 0, type: "session.step.ended", durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: { sessionID, assistantMessageID: "m", finish: "stop", cost, tokens: { input, output: 16, reasoning: 86, cache: { read, write: 0 } } },
  } satisfies OpenCodeEvent)
  assert.deepEqual(readings(decoder.decode({ id: "u", created: 0, type: "session.usage.updated", data: { sessionID: "root", cost: 0.4, tokens: { input: 11_236, output: 43, reasoning: 216, cache: { read: 26_067, write: 0 } } } })), [])
  const root = readings(decoder.decode(step("root", 289, 12_273, 0.01))).at(-1)
  assert.deepEqual(root, { tokens: { input: 289, cacheRead: 12_273, cacheWrite: 0, output: 102, reasoning: 86 }, cost: { amount: 0.01, currency: "USD" }, used: 12_664, size: 200_000 })
  const child = readings(decoder.decode(step("child", 50, 1_000, 0.002))).at(-1)
  assert.equal(child?.used, 12_664, "A subagent's step spends without filling the root's context")
  assert.equal(child?.tokens?.input, 339)
}

// Claude restores its totals on resume when the session was the last to exit in its folder.
{
  const result = (modelUsage: { input: number; read: number; write: number; output: number }, turn: { input: number; read: number; write: number; output: number }, cost: number) => ({
    type: "result", subtype: "success", is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: "", stop_reason: "end_turn",
    total_cost_usd: cost, session_id: "s", uuid: "00000000-0000-4000-8000-000000000000", permission_denials: [],
    usage: {
      input_tokens: turn.input, cache_read_input_tokens: turn.read, cache_creation_input_tokens: turn.write, output_tokens: turn.output,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: turn.write },
      fallback_credit: { status: { type: "redeemed" } }, inference_geo: "", iterations: [], output_tokens_details: { thinking_tokens: 0 },
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 }, service_tier: "standard", speed: "standard",
    },
    modelUsage: { "claude-fable-5-1": { inputTokens: modelUsage.input, cacheReadInputTokens: modelUsage.read, cacheCreationInputTokens: modelUsage.write, outputTokens: modelUsage.output, webSearchRequests: 0, costUSD: cost, contextWindow: 200_000, maxOutputTokens: 32_000 } },
  } satisfies SDKMessage)
  const spentBy = (decoder: ClaudeDecoder, message: SDKMessage) => {
    const reading = readings(decoder.decode(message)).at(-1)
    return { tokens: reading?.tokens, cost: reading?.cost?.amount, native: reading?.native }
  }
  const kept = { tokens: { input: 4, cacheRead: 28_277, cacheWrite: 27_135, output: 16 }, cost: 0.5506 }
  const restored = spentBy(new ClaudeDecoder({ state: { currentMode: null }, restores: { totals: kept } }), result({ input: 6, read: 54_381, write: 31_686, output: 27 }, { input: 2, read: 26_104, write: 4_551, output: 11 }, 0.6487))
  assert.deepEqual(restored.tokens, { input: 2, cacheRead: 26_104, cacheWrite: 4_551, output: 11 }, "Restored totals are a baseline, not this process's spend")
  assert.equal(restored.cost?.toFixed(4), "0.0981")
  assert.deepEqual(restored.native, { tokens: { input: 6, cacheRead: 54_381, cacheWrite: 31_686, output: 27 }, cost: 0.6487 }, "The new totals are kept for the next process")

  const fresh = spentBy(new ClaudeDecoder({ state: { currentMode: null }, restores: { totals: kept } }), result({ input: 2, read: 26_104, write: 4_551, output: 11 }, { input: 2, read: 26_104, write: 4_551, output: 11 }, 0.0981))
  assert.deepEqual(fresh.tokens, { input: 2, cacheRead: 26_104, cacheWrite: 4_551, output: 11 }, "A resume Claude did not restore starts its totals at nothing")
  assert.equal(fresh.cost, 0.0981)

  const another = spentBy(new ClaudeDecoder({ state: { currentMode: null }, restores: { totals: kept } }), result({ input: 3, read: 9_000, write: 90_000, output: 70 }, { input: 2, read: 2_000, write: 1_000, output: 11 }, 2.5))
  assert.deepEqual(another.tokens, { input: 2, cacheRead: 2_000, cacheWrite: 1_000, output: 11 }, "Totals that neither extend the kept ones nor are this turn alone are another session's")
  assert.equal(another.cost, undefined)

  const unknown = new ClaudeDecoder({ state: { currentMode: null }, restores: {} })
  const guessed = spentBy(unknown, result({ input: 6, read: 54_381, write: 31_686, output: 27 }, { input: 2, read: 26_104, write: 4_551, output: 11 }, 0.6487))
  assert.deepEqual(guessed.tokens, { input: 2, cacheRead: 26_104, cacheWrite: 4_551, output: 11 }, "With no kept totals, only the turn's own spend is known to be this process's")
  assert.equal(guessed.cost, undefined)
  const later = spentBy(unknown, result({ input: 8, read: 80_000, write: 32_000, output: 40 }, { input: 2, read: 25_619, write: 314, output: 13 }, 0.7))
  assert.deepEqual(later.tokens, { input: 4, cacheRead: 51_723, cacheWrite: 4_865, output: 24 }, "Later results add what the totals grew by")
  assert.equal(later.cost?.toFixed(4), "0.0513")

  const unresumed = spentBy(new ClaudeDecoder({ state: { currentMode: null } }), result({ input: 2, read: 11_586, write: 14_483, output: 5 }, { input: 2, read: 11_586, write: 14_483, output: 5 }, 0.2928))
  assert.equal(unresumed.cost, 0.2928, "A new session's totals are all its own")
}

// A new process for the same conversation: the context holds, the spend was the old process's.
{
  const before = { harness: "claude", nativeId: "a", usage: { used: 40_000, size: 200_000, compacted: true, tokens: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 }, cost: { amount: 0.5, currency: "USD" } } }
  assert.deepEqual(carriedUsage(before, { harness: "claude", nativeId: "a" }), { used: 40_000, size: 200_000, compacted: true }, "A process that has reported nothing yet keeps the context as full as it was")
  const native = { tokens: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 }, cost: 0.5 }
  assert.deepEqual(carriedUsage({ ...before, usage: { ...before.usage, native } }, { harness: "claude", nativeId: "a" })?.native, native, "The harness's session totals carry for a process that may restore them")
  assert.equal(restorableTotals({ ...before, usage: { native } }, { provider: "claude", nativeId: "a" }), native)
  assert.equal(restorableTotals({ ...before, usage: { native } }, { provider: "claude", nativeId: "b" }), undefined, "Another native session restores nothing of this one")
  const claudeBinding = { provider: "claude", nativeId: "a" }
  const departed = departedBinding(claudeBinding, { ...before, usage: { native } })
  assert.deepEqual(departed, { ...claudeBinding, nativeUsage: native }, "Moving off a binding keeps its native session's totals")
  const otherBinding = { provider: "codex", nativeId: "c" }
  assert.deepEqual(departedBinding(otherBinding, { ...before, usage: { native } }), otherBinding, "Only the binding the session ran is marked")
  const codexSession = { harness: "codex", nativeId: "c", usage: { native: { tokens: { input: 9, cacheRead: 9, cacheWrite: 0, output: 9 } } } }
  assert.deepEqual(restorableTotals(codexSession, departed), native, "Back from another harness, Claude gets the totals it had when the conversation left it")
  const fresher = { tokens: { ...native.tokens, output: 40 }, cost: 0.9 }
  assert.deepEqual(restorableTotals({ ...before, usage: { native: fresher } }, departed), fresher, "The running session's own totals are newer than the kept ones")
  assert.deepEqual(carriedUsage(before, { harness: "claude", nativeId: "a", usage: {} }), {}, "A reading the new process made, even an emptied one, is the reading")
  assert.equal(carriedUsage(before, { harness: "claude", nativeId: "b" }), undefined, "Another native session starts from nothing")
  assert.equal(carriedUsage(before, { harness: "codex", nativeId: "a" }), undefined, "Another harness starts from nothing")
  assert.equal(carriedUsage(before, { harness: "claude" }), undefined, "A session not yet bound carries nothing")
  assert.equal(carriedUsage({ ...before, usage: { tokens: before.usage.tokens } }, { harness: "claude", nativeId: "a" }), undefined, "Spend alone does not carry")
}

console.log("Session usage: one meter across harnesses, each harness's counts normalized, Grok cost in its own unit, Claude's context itemized, context and session totals carried across a process restart, and a wake charged only for its own calls on Codex, OpenCode and Claude")

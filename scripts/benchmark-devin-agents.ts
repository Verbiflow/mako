import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import { cpus } from "node:os"
import { DevinAgents } from "../electron/providers/devin/agents.ts"
import type { SessionNotification } from "@agentclientprotocol/sdk"

// Measures only the provider observer's incremental event path. No RPC,
// transcript parsing, persistence, UI, model or filesystem work is included.
const parent: SessionNotification = { sessionId: "parent", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x".repeat(1024) } } }
const start: SessionNotification = { sessionId: "parent", update: { sessionUpdate: "tool_call_update", toolCallId: "child", status: "in_progress", _meta: { "cognition.ai/subagent_started": { agentId: "child", title: "Fixture", isBackground: true } } } }
const done: SessionNotification = { sessionId: "parent", update: { sessionUpdate: "tool_call_update", toolCallId: "child", status: "completed", _meta: { "cognition.ai/subagent_completed": { agentId: "child", success: true } } } }
const rows = []
for (const count of [1_000, 10_000, 100_000]) {
  const samples = []
  for (let repeat = 0; repeat < 7; repeat++) {
    let published = 0
    const observer = new DevinAgents({ nativeId: "parent", publish: () => { published++ } })
    observer.observe(start)
    const began = performance.now()
    for (let index = 0; index < count; index++) observer.observe(parent)
    const eventsMs = performance.now() - began
    const completing = performance.now()
    observer.observe(done)
    const completionMs = performance.now() - completing
    assert.equal(published, 2, "Parent history neither republishes nor changes child state")
    observer.dispose()
    if (repeat) samples.push({ eventsMs, completionMs }) // Warm once per size.
  }
  rows.push({ parentEvents: count, parentTextBytes: count * 1024, samples })
}
console.log(JSON.stringify({ node: process.version, cpu: cpus()[0]?.model, measuredAt: new Date().toISOString(), scope: "observer only; reused 1 KiB parent text event, one active child; no history allocation or transport cost", rows }, null, 2))

import assert from "node:assert/strict"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import { DevinAgents } from "../electron/providers/devin/agents.ts"
import type { NativeAgentObservation } from "../electron/contracts/native-agents.ts"

const events: NativeAgentObservation[] = []
const observer = new DevinAgents({ nativeId: "native-parent", publish: event => events.push(event) })
const update = (value: SessionNotification["update"], sessionId = "native-parent") => observer.observe({ sessionId, update: value })
const start = (agentId: string, isBackground = true): SessionNotification["update"] => ({
  sessionUpdate: "tool_call_update", toolCallId: agentId, status: "in_progress",
  _meta: { "cognition.ai/subagent_started": { agentId, title: "Same title", profile: "General", model: "SWE-2 High", depth: 1, isBackground } },
})
const complete = (agentId: string, success = true): SessionNotification["update"] => ({
  sessionUpdate: "tool_call_update", toolCallId: agentId, status: success ? "completed" : "failed",
  _meta: { "cognition.ai/subagent_completed": { agentId, success, summary: "Native result", depth: 1 } },
})
const resume = (call: string, child: string): SessionNotification["update"] => ({
  sessionUpdate: "tool_call", toolCallId: call, title: "Resume",
  rawInput: { resume: child, title: "Resumed child", is_background: true },
  _meta: { "cognition.ai/inferenceToolName": "run_subagent" },
})
const result = (toolCallId: string): SessionNotification["update"] => ({ sessionUpdate: "tool_call_update", toolCallId, status: "completed" })

assert.equal(update(start("one"), "foreign-parent"), undefined)
assert.equal(events.length, 0)
assert.equal(update(start("one")), "child")
update(start("two"))
assert.deepEqual(events.map(x => x.nativeId), ["one", "two"], "Parallel children with identical titles keep native identities")
assert.equal(update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "child output" }, _meta: { "cognition.ai/subagent_context": { parentAgentId: "one" } } }), "child")
assert.equal(update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "malformed child output" }, _meta: { "cognition.ai/subagent_context": { parentAgentId: 17 } } }), "child")
assert.equal(update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "parent output" } }), undefined)
update(result("spawn-tool"))
assert.equal(events.at(-1)?.state.kind, "working", "A completed launch tool does not settle a child")
update(complete("one"))
assert.equal(events.at(-1)?.nativeId, "one")
assert.equal(events.at(-1)?.state.kind, "completed")
const settledCount = events.length
update(start("one")); update(complete("one"))
assert.equal(events.length, settledCount, "Duplicate first-run bookends do not revive or re-publish completion")

update(resume("invocation-2", "one"))
assert.equal(events.at(-1)?.nativeRunId, "invocation-2")
assert.equal(events.at(-1)?.state.kind, "working", "Resume blocks before the parent returns")
update(complete("one"))
assert.equal(events.at(-1)?.state.kind, "working", "Unkeyed old completion cannot settle a newer run")
update(result("invocation-2"))
assert.equal(events.at(-1)?.state.kind, "working", "Without native foreground admission, completion could be a background acknowledgement")
update(start("one", false))
update(complete("one"))
assert.equal(events.at(-1)?.state.kind, "working")
update(result("invocation-2"))
assert.equal(events.at(-1)?.state.kind, "completed", "Exact foreground invocation completion settles the resumed child")
update(resume("invocation-3", "one")); update(start("one", false))
update(resume("invocation-2", "one")); update(result("invocation-2")); update(complete("one"))
assert.equal(events.at(-1)?.nativeRunId, "invocation-3")
assert.equal(events.at(-1)?.state.kind, "working", "Replayed old starts/results cannot replace current invocation")
update(result("invocation-3"))
assert.equal(events.at(-1)?.state.kind, "completed")
update(complete("two", false))
assert.equal(events.at(-1)?.state.kind, "failed")
const failure = (toolCallId: string): SessionNotification["update"] => ({ sessionUpdate: "tool_call_update", toolCallId, status: "failed" })
update(resume("missing-attempt", "missing-child")); update(failure("missing-attempt"))
assert.equal(events.at(-1)?.state.kind, "failed", "A rejected admission cannot remain working")
update(resume("missing-retry", "missing-child")); update(failure("missing-attempt"))
assert.equal(events.at(-1)?.nativeRunId, "missing-retry")
assert.equal(events.at(-1)?.state.kind, "working", "An older rejection cannot settle a newer attempt")
update(failure("missing-retry"))
update(start("active")); update(resume("overlap", "active")); update(failure("overlap"))
assert.equal(events.at(-1)?.nativeRunId, "active")
assert.equal(events.at(-1)?.state.kind, "working", "Rejected overlapping admission preserves the active execution")
update(complete("active"))
assert.equal(events.at(-1)?.state.kind, "completed", "The original execution still accepts its own completion")
update(start("overlapping-child")); update(resume("overlapping-admitted", "overlapping-child")); update(start("overlapping-child", false))
update(result("overlapping-admitted")); update(complete("overlapping-child"))
assert.equal(events.at(-1)?.state.kind, "working", "Ambiguous overlapping execution cannot clear earlier active work")
const restored = new DevinAgents({ nativeId: "native-parent", observedAgents: [{ nativeId: "restored", title: "Restored", state: { kind: "unknown", reason: "Disconnected" } }], publish: event => events.push(event) })
restored.observe({ sessionId: "native-parent", update: resume("restored-attempt", "restored") })
restored.observe({ sessionId: "native-parent", update: failure("restored-attempt") })
assert.equal(events.at(-1)?.state.kind, "unknown", "Rejected admission does not invent completion for disconnected work")
restored.dispose()
const beforeDispose = events.length
observer.dispose(); update(start("three"))
assert.equal(events.length, beforeDispose)
console.log("Devin children: native identity, parent/child isolation, background launch, foreground resume, stale completion and disposal passed")

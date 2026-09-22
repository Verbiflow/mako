import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { GrokAgents } from "../electron/providers/grok/agents.ts"
import type { NativeAgentObservation } from "../electron/contracts/native-agents.ts"

const home = await mkdtemp(join(tmpdir(), "mako-grok-children-"))
const parent = "01a0c67a-f346-7541-9a4e-644eb37a64f4"
const child = "01a0c67b-2e11-7fe0-8bec-e0ae3277513d"
const cwd = "/fixture"
const root = join(home, "sessions", encodeURIComponent(cwd), parent, "subagents", child)
await mkdir(root, { recursive: true })
const path = join(root, "meta.json")
const events: NativeAgentObservation[] = []
const sample = {
  subagent_id: child, child_session_id: child, parent_session_id: parent,
  attempt_id: "attempt-1", status: "running", description: "Sleep then reply",
  subagent_type: "general-purpose", effective_model_id: null,
}
await writeFile(path, JSON.stringify(sample))
const observer = new GrokAgents({ home, cwd, nativeId: parent, publish: a => events.push(a) })
const notify = () => observer.observe({ sessionId: parent, update: { sessionUpdate: "tool_call_update", toolCallId: "native-call", status: "completed" } })
async function until(check: () => boolean) {
  const end = Date.now() + 3500
  while (!check() && Date.now() < end) await delay(10)
  assert.ok(check(), "Expected native metadata reconciliation")
}
try {
  await until(() => events.length === 1)
  assert.equal(events[0]?.nativeRunId, "attempt-1")
  assert.equal(events[0]?.state.kind, "working")
  // No terminal notification: fallback metadata read must release the completed attempt.
  await writeFile(path, JSON.stringify({ ...sample, status: "completed" }))
  await until(() => events.at(-1)?.state.kind === "completed")
  await writeFile(path, JSON.stringify({ ...sample, attempt_id: "attempt-2" }))
  notify()
  await until(() => events.at(-1)?.nativeRunId === "attempt-2")
  assert.equal(events.at(-1)?.state.kind, "working")
  // A delayed old tool completion cannot overwrite the current native attempt.
  notify()
  await delay(40)
  assert.equal(events.at(-1)?.nativeRunId, "attempt-2")
  assert.equal(events.at(-1)?.state.kind, "working")
  const count = events.length
  await writeFile(path, '{"torn":')
  notify()
  await delay(40)
  assert.equal(events.length, count)
  await writeFile(path, JSON.stringify({ ...sample, parent_session_id: child, status: "completed" }))
  notify()
  await delay(40)
  assert.equal(events.length, count, "Foreign parent evidence cannot settle this child")
  observer.dispose()
  await writeFile(path, JSON.stringify({ ...sample, attempt_id: "attempt-2", status: "completed" }))
  notify()
  await delay(40)
  assert.equal(events.length, count, "Disposed observer cannot publish")
  // Native launch notifications can precede both the directory and metadata.
  // Discovery must not wait for the idle 30-second poll, nor require another
  // notification from a parent that already returned its final answer.
  const freshParent = "01a0c68e-10ac-7190-891f-b432f1d4e86b"
  const freshRoot = join(home, "sessions", encodeURIComponent(cwd), freshParent)
  await mkdir(freshRoot, { recursive: true })
  const freshEvents: NativeAgentObservation[] = []
  const fresh = new GrokAgents({ home, cwd, nativeId: freshParent, publish: a => freshEvents.push(a) })
  try {
    await fresh.ready
    fresh.observe({ sessionId: freshParent, update: { sessionUpdate: "tool_call_update", toolCallId: "spawn", status: "completed" } })
    await delay(40)
    const childRoot = join(freshRoot, "subagents", child)
    await mkdir(childRoot, { recursive: true })
    await writeFile(join(childRoot, "meta.json"), JSON.stringify({ ...sample, parent_session_id: freshParent }))
    await until(() => freshEvents.at(-1)?.state.kind === "working")
    await writeFile(join(childRoot, "meta.json"), JSON.stringify({ ...sample, parent_session_id: freshParent, status: "completed" }))
    await until(() => freshEvents.at(-1)?.state.kind === "completed")
  } finally { fresh.dispose() }
  // A long-lived parent can have more historical children than the UI roster.
  // Discovery must not silently stop at the first 256 directory entries.
  const manyParent = "01a0c691-0019-7133-b37f-bfc33855b6d3"
  const manyRoot = join(home, "sessions", encodeURIComponent(cwd), manyParent, "subagents")
  const expected = new Set<string>()
  for (let i = 0; i < 260; i++) {
    const id = `00000000-0000-4000-8000-${i.toString().padStart(12, "0")}`
    const directory = join(manyRoot, id)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, "meta.json"), JSON.stringify({ ...sample, parent_session_id: manyParent, subagent_id: id, child_session_id: id, status: i === 259 ? "running" : "completed" }))
    expected.add(id)
  }
  const manyEvents: NativeAgentObservation[] = []
  const many = new GrokAgents({ home, cwd, nativeId: manyParent, publish: a => manyEvents.push(a) })
  try {
    many.observe({ sessionId: manyParent, update: { sessionUpdate: "tool_call_update", toolCallId: "startup-race", status: "completed" } })
    await many.ready
    assert.deepEqual(new Set(manyEvents.map(a => a.nativeId)), expected)
    assert.equal(manyEvents.filter(a => a.state.kind === "working").length, 1)
  } finally { many.dispose() }
} finally {
  observer.dispose()
  await rm(home, { recursive: true, force: true })
}
console.log("Grok native children: current attempt, missing completion, reuse, malformed/foreign evidence and disposal passed")

import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { CodexAgents } from "../electron/providers/codex/agents.ts"
import { CodexAgentStatus, CodexAgentRunsSchema, type CodexAgentRun } from "../electron/providers/codex/agent-status.ts"
import { parseNotification } from "../electron/codex-app-parse.ts"
import type { NativeAgentObservation } from "../electron/contracts/native-agents.ts"

async function until(check: () => boolean) {
  const end = Date.now() + 3000
  while (!check() && Date.now() < end) await delay(5)
  assert.ok(check(), "Expected asynchronous observation")
}
const activity = {
  type: "subAgentActivity" as const,
  id: "subagent-completed-01a0c117-6ac7-7cb1-91bf-666b30a53f17",
  kind: "completed" as const,
  agentThreadId: "01a0c117-6a60-7ed0-b74e-a76f0a23fa1e",
  agentPath: "/root/capy_hoplite_docs",
}
const notification = parseNotification("item/completed", {
  threadId: "parent", turnId: "parent-turn", item: activity,
})
assert.equal(notification?.method, "item/completed", "Recorded terminal activity must pass the wire parser")
assert.equal(CodexAgentRunsSchema.safeParse({ data: [{ id: "run", status: "completed", itemsView: "full", items: [] }] }).success, false)
assert.equal(CodexAgentRunsSchema.safeParse({ data: [{ id: "run", status: "inProgress", itemsView: "notLoaded", items: [] }] }).success, true)

const pending: Array<(run: CodexAgentRun | null) => void> = []
const published: NativeAgentObservation[] = []
const agents = new CodexAgents({
  read: () => new Promise((resolve) => pending.push(resolve)),
  publish: (agent) => published.push(agent),
})
try {
  agents.project({ ...activity, id: "spawn", kind: "started" }, false)
  await until(() => pending.length === 1)
  // A follow-up arrived while an older status request was outstanding.
  agents.project({ ...activity, id: "followup", kind: "interacted" }, false)
  pending[0]!({ id: "old-run", status: "completed" })
  await until(() => pending.length === 2)
  assert.equal(published.length, 0, "Old read completion cannot settle newer activity")
  pending[1]!({ id: "new-run", status: "inProgress" })
  await until(() => published.length === 1)
  assert.equal(published[0]?.nativeRunId, "new-run")
  assert.equal(published[0]?.state.kind, "working")
  // A late completed activity refers to the old run. Read latest, never trust its arrival order.
  const projected = agents.project(activity, false)
  assert.equal(projected[0]?.state.kind, "working")
  await until(() => pending.length === 3)
  pending[2]!({ id: "new-run", status: "inProgress" })
  await until(() => published.length === 2)
  assert.equal(published[1]?.state.kind, "working")
  agents.project({ ...activity, id: "new-completion" }, false)
  await until(() => pending.length === 4)
  pending[3]!({ id: "new-run", status: "completed" })
  await until(() => published.length === 3)
  assert.equal(published[2]?.state.kind, "completed")
  assert.equal(published[2]?.nativeRunId, "new-run")
  const reads = pending.length
  agents.project({ ...activity, id: "historical-start", kind: "started" }, true)
  await delay(30)
  assert.equal(pending.length, reads, "Replay never starts status polling or execution")
} finally { agents.dispose() }

// A missing terminal event still converges through bounded polling.
let reads = 0
const polled: string[] = []
const watcher = new CodexAgentStatus({
  read: async () => ({ id: "poll-run", status: ++reads === 1 ? "inProgress" : "completed" }),
  publish: (_id, run) => polled.push(run.status),
})
try {
  watcher.observe("child")
  await until(() => polled.includes("completed"))
  assert.deepEqual(polled, ["inProgress", "completed"])
  await delay(30)
  assert.equal(reads, 2, "Terminal children do not poll indefinitely")
} finally { watcher.dispose() }

let finish: ((run: CodexAgentRun | null) => void) | undefined
let emissions = 0
const closing = new CodexAgentStatus({
  read: () => new Promise((resolve) => { finish = resolve }),
  publish: () => { emissions += 1 },
})
closing.observe("child")
await until(() => !!finish)
closing.dispose()
finish?.({ id: "old-binding", status: "completed" })
await delay(20)
assert.equal(emissions, 0, "Disposed bindings cannot publish late results")

let calls = 0
const failed = new CodexAgentStatus({
  read: async () => { calls += 1; throw new Error("Unavailable or unsupported") },
  publish: () => { throw new Error("Failure must not become completion") },
})
try {
  failed.observe("child")
  await until(() => calls === 1)
  await delay(30)
  assert.equal(calls, 1, "Failed status reads back off")
} finally { failed.dispose() }
console.log("Codex child status: recorded completion, current-run readback, races, missing event, replay, disposal and backoff passed")

const boundedReads: Array<(run: CodexAgentRun | null) => void> = []
const bounded = new CodexAgentStatus({
  read: () => new Promise((resolve) => boundedReads.push(resolve)),
  publish() {},
})
try {
  for (let i = 0; i < 10; i += 1) bounded.observe(`child-${i}`)
  await until(() => boundedReads.length === 4)
  await delay(25)
  assert.equal(boundedReads.length, 4, "Per-binding status concurrency is bounded")
  boundedReads[0]!({ id: "finished", status: "completed" })
  await until(() => boundedReads.length === 5)
} finally {
  bounded.dispose()
  for (const resolve of boundedReads) resolve(null)
}

const restored: NativeAgentObservation[] = []
const reconnected = new CodexAgents({
  read: async () => ({ id: "resumed-run", status: "completed" }),
  publish: (agent) => restored.push(agent),
})
try {
  reconnected.restore([{ nativeId: "known-child", title: "Retained child", state: { kind: "working" } }])
  await until(() => restored.length === 1)
  assert.equal(restored[0]?.state.kind, "completed")
  assert.equal(restored[0]?.nativeRunId, "resumed-run")
} finally { reconnected.dispose() }

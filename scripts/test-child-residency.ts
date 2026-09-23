import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { LiveConversations } from "../electron/live-conversations.ts"
import { DevinAgents } from "../electron/providers/devin/agents.ts"
import { ApplicationLifecycle } from "../electron/application-lifecycle.ts"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.ts"
import type { LiveSessionState } from "../electron/shared.ts"

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000
  while (!check() && Date.now() < deadline) await delay(5)
  assert.ok(check(), "Expected lifecycle transition")
}
const root = mkdtempSync(join(tmpdir(), "mako-child-residency-"))
const id = randomUUID()
let owner: LiveConversations
let closes = 0
let checkpointEntered = false
let releaseCheckpoint: ((value: string) => void) | undefined
let pauseCheckpoint = false
let catalogPath: string | undefined
const session: LiveSessionState = { id, nativeId: "native-parent", harness: "devin-fixture", cwd: root, status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] }
const driver: ProviderLiveDriver = {
  approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
  provider: "devin-fixture", canResume: true, available: () => true,
  start: async () => session,
  prompt: async () => {
    owner.observe({ type: "live-session", session: { ...session, status: "running" } })
    owner.observe({ type: "live-session", session })
  },
  permission: async () => {}, cancel: async () => {}, setMode: async () => {},
  close: async () => { closes += 1 },
}
owner = new LiveConversations({
  root: join(root, "journals"), appPath: root, driver: () => driver,
  history: async () => null, emit() {}, providerIdleMs: 60_000, providerWarmLimit: 10,
  nativePath: () => catalogPath,
  checkpoint: async () => {
    if (!pauseCheckpoint) return "checkpoint"
    checkpointEntered = true
    return new Promise<string>(resolve => { releaseCheckpoint = resolve })
  },
})
const observer = new DevinAgents({ nativeId: "native-parent", publish: agent => owner.observe({ type: "live-agent", id, agent }) })
const start = () => observer.observe({ sessionId: "native-parent", update: { sessionUpdate: "tool_call_update", toolCallId: "child", status: "in_progress", _meta: { "cognition.ai/subagent_started": { agentId: "child", title: "Native child", isBackground: true } } } })
const complete = () => observer.observe({ sessionId: "native-parent", update: { sessionUpdate: "tool_call_update", toolCallId: "child", status: "completed", _meta: { "cognition.ai/subagent_completed": { agentId: "child", success: true } } } })
try {
  await owner.start(driver.provider, root, { conversationId: id })
  owner.submit(id, randomUUID(), "seed")
  await until(() => owner.snapshot(id)?.requests[0]?.status === "completed" && owner.lifecycleWork().length === 0)
  assert.equal(owner.snapshot(id)?.threadPath, undefined)
  catalogPath = join(root, "native")
  owner.discoverNativePaths()
  assert.equal(owner.snapshot(id)?.control?.bindings[0]?.path, catalogPath,
    "Catalog discovery after the parent turn must attach the native binding")
  await delay(10)
  pauseCheckpoint = true
  assert.equal(owner.hibernateIfIdle(id), true)
  await until(() => checkpointEntered)
  start()
  pauseCheckpoint = false
  releaseCheckpoint?.("new checkpoint")
  await delay(40)
  assert.equal(closes, 0, "Child starting while checkpoint awaited must cancel hibernation")
  assert.equal(owner.snapshot(id)?.session.connection, "connected")
  assert.equal(owner.hibernateIfIdle(id), false, "A ready parent with active child cannot hibernate")
  assert.equal(owner.residency().active, 1, "Residency diagnostics must count active children too")
  let restarts = 0
  const lifecycle = new ApplicationLifecycle({ work: () => owner.lifecycleWork(), ready() {}, stop: async () => {}, apply: async () => { restarts++ }, changed() {} })
  await lifecycle.command({ kind: "wait", action: "restart" })
  assert.equal(restarts, 0)
  complete()
  // A new invocation arriving before the deferred restart check must remain a blocker.
  observer.observe({ sessionId: "native-parent", update: { sessionUpdate: "tool_call", toolCallId: "new-run", title: "Resume", rawInput: { resume: "child" }, _meta: { "cognition.ai/inferenceToolName": "run_subagent" } } })
  observer.observe({ sessionId: "native-parent", update: { sessionUpdate: "tool_call_update", toolCallId: "child", status: "in_progress", _meta: { "cognition.ai/subagent_started": { agentId: "child", title: "Native child", isBackground: false } } } })
  complete() // Delayed completion of the previous execution.
  await lifecycle.tick()
  assert.equal(restarts, 0)
  assert.equal(owner.hibernateIfIdle(id), false)
  assert.equal(owner.snapshot(id)?.nativeAgents?.agents[0]?.nativeRunId, "new-run")
  observer.observe({ sessionId: "native-parent", update: { sessionUpdate: "tool_call_update", toolCallId: "new-run", status: "completed" } })
  await lifecycle.tick()
  assert.equal(restarts, 1)
  assert.equal(owner.hibernateIfIdle(id), true)
  await until(() => owner.snapshot(id)?.session.connection === "hibernated")
  assert.equal(closes, 1)
} finally {
  releaseCheckpoint?.("cleanup")
  observer.dispose(); owner.stop(); rmSync(root, { recursive: true, force: true })
}
console.log("Native child residency: checkpoint race, ready-parent protection, newer run, restart release and idle retirement passed")

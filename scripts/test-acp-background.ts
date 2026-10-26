import assert from "node:assert/strict"
import type { SessionNotification, ToolCallStatus } from "@agentclientprotocol/sdk"
import type { JsonObject } from "@mako/host/contracts/json"
import { createGrokAcpSource } from "@mako/host/harnesses/grok/acp"
import { createDevinAcpSource } from "@mako/host/harnesses/devin/acp"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

const nativeStores = new NativeStores(false)
const devinAcpSource = createDevinAcpSource(nativeStores)

const grokAcpSource = createGrokAcpSource()

// Payload shapes recorded from grok 1.0.41 and devin 3000.6.14 over ACP.
const grok = grokAcpSource.observeBackground?.()
assert.ok(grok?.extension)
const grokTasks = (statuses: string[]): JsonObject => ({
  sessionId: "grok-session",
  update: {
    sessionUpdate: "background_tasks",
    tasks: statuses.map((status, index) => ({
      task_id: `task-${index}`, command: "sleep 25", kind: "bash", status, started_at: "2026-09-26T04:58:57Z",
    })),
  },
  _meta: { eventId: "event" },
})
const counted = (report: ReturnType<NonNullable<typeof grok.extension>>) => report && { sessionId: report.sessionId, running: report.running }
assert.deepEqual(counted(grok.extension("_x.ai/session_notification", grokTasks(["running"]))), { sessionId: "grok-session", running: 1 })
assert.deepEqual(counted(grok.extension("_x.ai/session_notification", grokTasks(["completed", "running"]))), { sessionId: "grok-session", running: 1 })
assert.deepEqual(counted(grok.extension("_x.ai/session_notification", grokTasks(["completed", "completed"]))), { sessionId: "grok-session", running: 0 })
assert.equal(grok.extension("_x.ai/session_notification", { sessionId: "grok-session", update: { sessionUpdate: "turn_completed" } }), undefined)
assert.equal(grok.extension("_x.ai/other", grokTasks(["running"])), undefined)
assert.equal(grok.sessionUpdate, undefined, "only Grok's extension channel reports tasks")
console.log("PASS: Grok background_tasks reports replace the running count")

const turns = grokAcpSource.providerTurns?.()
assert.ok(turns, "Grok reports the end of the turns it starts itself")
const snapshot = (task: JsonObject): JsonObject => ({
  sessionId: "grok-session",
  update: { sessionUpdate: "task_completed", task_snapshot: {
    task_id: "01a0-task", command: "sleep 8; echo BG-DONE", cwd: "/work", output: "BG-DONE\n", truncated: false,
    completed: true, kind: "bash", is_backgrounded: true, signal: null, explicitly_killed: false, ...task,
  } },
})
assert.deepEqual(turns.cause?.("_x.ai/task_completed", snapshot({ exit_code: 0, description: "Sleep briefly then print BG-DONE" })),
  {
    sessionId: "grok-session",
    reason: 'Background command "Sleep briefly then print BG-DONE" completed (exit code 0)',
    cause: { kind: "command", outcome: "finished", name: "Sleep briefly then print BG-DONE", exitCode: 0 },
    body: "```output\nBG-DONE\n```",
  })
assert.equal(turns.cause?.("_x.ai/task_completed", snapshot({ exit_code: 1 }))?.reason, 'Background command "sleep 8; echo BG-DONE" failed (exit code 1)')
assert.equal(turns.cause?.("_x.ai/task_completed", snapshot({ exit_code: null, explicitly_killed: true, description: "Watch" }))?.reason, 'Background command "Watch" was stopped')
assert.equal(turns.cause?.("_x.ai/session_notification", snapshot({ exit_code: 0 })), undefined, "the snapshot arrives on its own method")
const completed = (stop_reason: string): JsonObject => ({ sessionId: "grok-session", update: { sessionUpdate: "turn_completed", prompt_id: "task-completed-01a0-task", stop_reason, elapsed_ms: 13148 } })
assert.deepEqual(turns.ended("_x.ai/session_notification", completed("end_turn")), { sessionId: "grok-session", interrupted: false })
assert.deepEqual(turns.ended("_x.ai/session_notification", completed("cancelled")), { sessionId: "grok-session", interrupted: true })
assert.equal(turns.ended("_x.ai/session_notification", grokTasks(["completed"])), undefined)
console.log("PASS: Grok names the cause of the turn it starts itself and reports its end")

const devinTurns = devinAcpSource.providerTurns?.()
assert.ok(devinTurns?.updateCause, "Devin announces the turns it starts itself in session updates")
const subagent = (key: "cognition.ai/subagent_started" | "cognition.ai/subagent_completed", value: JsonObject, status: ToolCallStatus): SessionNotification => ({
  sessionId: "devin-session",
  update: { sessionUpdate: "tool_call_update", toolCallId: "ag1", status, _meta: { [key]: { agentId: "ag1", depth: 1, ...value } } },
})
assert.equal(devinTurns.updateCause(subagent("cognition.ai/subagent_started", { title: "Run the checks", isBackground: true }, "in_progress")), undefined)
const finished = devinTurns.updateCause(subagent("cognition.ai/subagent_completed", { success: true, summary: "passed" }, "completed"))
const ran = finished?.cause?.kind === "agent" ? finished.cause.durationMs : undefined
assert.ok(ran !== undefined && ran >= 0 && ran < 1_000, "the subagent's run is timed from its start")
assert.deepEqual(finished,
  {
    sessionId: "devin-session",
    reason: 'Subagent "Run the checks" completed',
    cause: { kind: "agent", outcome: "finished", name: "Run the checks", agentId: "ag1", durationMs: ran },
    body: "passed",
  })
assert.equal(devinTurns.updateCause(subagent("cognition.ai/subagent_completed", { success: false, summary: "[Error] Canceled by user" }, "failed"))?.reason, "A subagent failed")
assert.equal(devinTurns.updateCause(subagent("cognition.ai/subagent_completed", { success: true, depth: 2 }, "completed")), undefined, "a nested subagent reports to its parent subagent")
assert.equal(devinTurns.updateCause(subagent("cognition.ai/subagent_started", { title: "Read the notes", isBackground: false }, "in_progress")), undefined)
assert.equal(devinTurns.updateCause(subagent("cognition.ai/subagent_completed", { success: true, summary: "Friday" }, "completed")), undefined,
  "a foreground subagent's completion is its call's result, which the turn waited on")
const stopped = (cause: string): JsonObject => ({ cause, stats: {}, sessionId: "devin-session" })
assert.deepEqual(devinTurns.ended("_cognition.ai/agent_stopped", stopped("complete")), { sessionId: "devin-session", interrupted: false })
assert.deepEqual(devinTurns.ended("_cognition.ai/agent_stopped", stopped("cancelled")), { sessionId: "devin-session", interrupted: true })
assert.equal(devinTurns.ended("_cognition.ai/thinking_complete", stopped("complete")), undefined)
console.log("PASS: Devin names the subagent whose completion starts its turn and reports that turn's end")

const devin = devinAcpSource.observeBackground?.()
assert.ok(devin?.sessionUpdate)
const exec = (status: ToolCallStatus | undefined, meta: JsonObject): SessionNotification => ({
  sessionId: "devin-session",
  update: { sessionUpdate: "tool_call_update", toolCallId: "exec:0#shell", status, _meta: meta },
})
assert.equal(devin.sessionUpdate(exec("in_progress", { "cognition.ai/inferenceToolName": "exec" })), undefined)
const devinCount = (report: ReturnType<NonNullable<typeof devin.sessionUpdate>>) => report && { sessionId: report.sessionId, running: report.running }
assert.deepEqual(devinCount(devin.sessionUpdate(exec("in_progress", {
  "cognition.ai/inferenceToolName": "exec", "cognition.ai/background": true, "cognition.ai/backgroundShellId": "de0493",
}))), { sessionId: "devin-session", running: 1 })
assert.equal(devin.sessionUpdate(exec(undefined, { "cognition.ai/terminalPreview": true })), undefined,
  "a preview update does not end the shell")
assert.deepEqual(devinCount(devin.sessionUpdate(exec("completed", {
  "cognition.ai/inferenceToolName": "exec", terminal_exit: { terminal_id: "de0493", exit_code: 0, signal: null },
}))), { sessionId: "devin-session", running: 0 })
assert.equal(devin.sessionUpdate(exec("completed", {})), undefined, "an ordinary tool completion reports nothing")
console.log("PASS: Devin background shells count until their exec call completes")

const control = (running: number) => {
  const calls: unknown[] = []
  return {
    calls,
    control: {
      sessionId: "session", running,
      request: async (method: string, params: JsonObject) => { calls.push([method, params]) },
      reopen: async () => { calls.push("reopen") },
    },
  }
}
devin.sessionUpdate(exec("in_progress", { "cognition.ai/background": true, "cognition.ai/backgroundShellId": "a1" }))
devin.sessionUpdate({ sessionId: "devin-session", update: { sessionUpdate: "tool_call_update", toolCallId: "exec:1#shell", status: "in_progress", _meta: { "cognition.ai/background": true, "cognition.ai/backgroundShellId": "b2" } } })
const devinStop = control(2)
await devin.stop(devinStop.control)
assert.deepEqual(devinStop.calls, [
  ["_cognition.ai/terminal/killBackgroundShell", { sessionId: "session", shellId: "a1" }],
  ["_cognition.ai/terminal/killBackgroundShell", { sessionId: "session", shellId: "b2" }],
])
const grokStop = control(1)
await grok.stop(grokStop.control)
assert.deepEqual(grokStop.calls, ["reopen"], "Grok ends its tasks by closing and resuming the session")
const grokIdle = control(0)
await grok.stop(grokIdle.control)
assert.deepEqual(grokIdle.calls, [], "with nothing running, Grok's session is left alone")
console.log("PASS: Stop asks Devin to kill each running shell, and reopens a Grok session only while tasks run")

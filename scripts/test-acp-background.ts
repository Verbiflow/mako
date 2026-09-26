import assert from "node:assert/strict"
import type { SessionNotification, ToolCallStatus } from "@agentclientprotocol/sdk"
import type { JsonObject } from "../electron/codex-app-json.ts"
import { grokAcpSource } from "../electron/providers/grok/acp.ts"
import { devinAcpSource } from "../electron/providers/devin/acp.ts"

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
assert.deepEqual(grok.extension("_x.ai/session_notification", grokTasks(["running"])), { sessionId: "grok-session", running: 1 })
assert.deepEqual(grok.extension("_x.ai/session_notification", grokTasks(["completed", "running"])), { sessionId: "grok-session", running: 1 })
assert.deepEqual(grok.extension("_x.ai/session_notification", grokTasks(["completed", "completed"])), { sessionId: "grok-session", running: 0 })
assert.equal(grok.extension("_x.ai/session_notification", { sessionId: "grok-session", update: { sessionUpdate: "turn_completed" } }), undefined)
assert.equal(grok.extension("_x.ai/other", grokTasks(["running"])), undefined)
assert.equal(grok.sessionUpdate, undefined, "only Grok's extension channel reports tasks")
console.log("PASS: Grok background_tasks reports replace the running count")

const devin = devinAcpSource.observeBackground?.()
assert.ok(devin?.sessionUpdate)
const exec = (status: ToolCallStatus | undefined, meta: JsonObject): SessionNotification => ({
  sessionId: "devin-session",
  update: { sessionUpdate: "tool_call_update", toolCallId: "exec:0#shell", status, _meta: meta },
})
assert.equal(devin.sessionUpdate(exec("in_progress", { "cognition.ai/inferenceToolName": "exec" })), undefined)
assert.deepEqual(devin.sessionUpdate(exec("in_progress", {
  "cognition.ai/inferenceToolName": "exec", "cognition.ai/background": true, "cognition.ai/backgroundShellId": "de0493",
})), { sessionId: "devin-session", running: 1 })
assert.equal(devin.sessionUpdate(exec(undefined, { "cognition.ai/terminalPreview": true })), undefined,
  "a preview update does not end the shell")
assert.deepEqual(devin.sessionUpdate(exec("completed", {
  "cognition.ai/inferenceToolName": "exec", terminal_exit: { terminal_id: "de0493", exit_code: 0, signal: null },
})), { sessionId: "devin-session", running: 0 })
assert.equal(devin.sessionUpdate(exec("completed", {})), undefined, "an ordinary tool completion reports nothing")
console.log("PASS: Devin background shells count until their exec call completes")

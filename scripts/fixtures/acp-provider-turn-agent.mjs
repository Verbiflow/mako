// An ACP agent replaying what grok 1.0.41 sent on 2026-09-27 around a turn it
// started itself after a background command finished. The prompt text names
// the recorded sequence to play once the prompted turn has ended.
import { Readable, Writable } from "node:stream"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"

const sessionId = "provider-turn-fixture"
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let cancelled

new AgentSideConnection((connection) => {
  const update = (value) => connection.sessionUpdate({ sessionId, update: value })
  const chunk = (sessionUpdate, text) => update({ sessionUpdate, content: { type: "text", text } })
  const taskCompleted = () => connection.extNotification("_x.ai/task_completed", {
    sessionId,
    update: { sessionUpdate: "task_completed", task_snapshot: {
      task_id: "01a0-task", command: "sleep 8; echo BG-DONE", description: "Sleep briefly then print BG-DONE",
      exit_code: 0, signal: null, explicitly_killed: false, output: "BG-DONE\n", kind: "bash",
    } },
  })
  const turnCompleted = (stop_reason) => connection.extNotification("_x.ai/session_notification", {
    sessionId, update: { sessionUpdate: "turn_completed", prompt_id: "task-completed-01a0-task", stop_reason, elapsed_ms: 1798 },
  })
  const sequences = {
    async "self-started"() {
      await taskCompleted()
      await pause(20)
      await chunk("agent_thought_chunk", "The background task finished.")
      await chunk("agent_message_chunk", "It printed BG-DONE.")
      await turnCompleted("end_turn")
    },
    async cancelled() {
      await taskCompleted()
      await pause(20)
      await chunk("agent_thought_chunk", "Reading the output")
      await new Promise((resolve) => { cancelled = resolve })
      await turnCompleted("cancelled")
      await chunk("agent_thought_chunk", " after the cancel")
    },
    async unannounced() {
      await chunk("agent_message_chunk", "A late chunk with no announced turn.")
    },
  }
  return {
    async initialize() {
      return { protocolVersion: 1, agentCapabilities: { loadSession: false } }
    },
    async newSession() {
      return { sessionId }
    },
    async authenticate() {
      return {}
    },
    async prompt(params) {
      const name = params.prompt.find((block) => block.type === "text")?.text ?? ""
      await chunk("agent_message_chunk", `Started ${name}.`)
      setTimeout(() => void sequences[name]?.(), 30)
      return { stopReason: "end_turn" }
    },
    async cancel() {
      cancelled?.()
    },
  }
}, ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))

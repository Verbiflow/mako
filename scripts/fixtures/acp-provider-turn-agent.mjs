// An ACP agent replaying what grok 1.0.41 and devin 3000.6.14 sent on
// 2026-09-27 around a turn each started itself after background work finished.
// The prompt text names the recorded sequence to play once the prompted turn
// has ended.
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
  const agentStopped = (cause) => connection.extNotification("_cognition.ai/agent_stopped", { cause, stats: {}, sessionId })
  const subagentStarted = () => update({
    sessionUpdate: "tool_call_update", toolCallId: "ag1", status: "in_progress",
    _meta: { "cognition.ai/subagent_started": { agentId: "ag1", title: "Run the checks", task: "Run the checks", profile: "General", depth: 1, isBackground: true, model: "SWE-2 High" } },
  })
  const subagentCompleted = (success, summary) => update({
    sessionUpdate: "tool_call_update", toolCallId: "ag1", status: success ? "completed" : "failed",
    _meta: { "cognition.ai/subagent_completed": { agentId: "ag1", success, summary, depth: 1 } },
  })
  const subagentFinishes = async () => {
    await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "All checks passed." }, _meta: { "cognition.ai/subagent_context": { parentAgentId: "ag1" } } })
    await subagentCompleted(true, "All checks passed.")
    await chunk("agent_thought_chunk", "The subagent finished; I should report it.")
  }
  const sequences = {
    async "devin-self-started"() {
      await subagentFinishes()
      await chunk("agent_message_chunk", "The checks passed.")
      await agentStopped("complete")
    },
    async "devin-self-cancelled"() {
      await subagentFinishes()
      await new Promise((resolve) => { cancelled = resolve })
      await agentStopped("cancelled")
    },
    async "devin-subagent-stopped"() {
      await new Promise((resolve) => { cancelled = resolve })
      await subagentCompleted(false, "[Error] Canceled by user")
      await agentStopped("cancelled")
    },
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
      // A process that dies mid-turn, after its first output and before the
      // prompt's response, as the Cursor SDK child did on an unhandled
      // rejection. Its pipe closes first and the exit follows, as a runtime
      // flushing its logs on the way out does.
      if (name === "exits-mid-turn") {
        await pause(50)
        process.stdout.end()
        setTimeout(() => process.exit(70), 300)
        return new Promise(() => {})
      }
      if (name.startsWith("devin-")) {
        await subagentStarted()
        await agentStopped("complete")
      }
      setTimeout(() => void sequences[name]?.(), 30)
      return { stopReason: "end_turn" }
    },
    async cancel() {
      cancelled?.()
    },
  }
}, ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))

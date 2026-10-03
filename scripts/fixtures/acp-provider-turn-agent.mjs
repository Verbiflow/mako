// An ACP agent replaying what grok 1.0.41 and devin 3000.6.14 sent on
// 2026-09-27 around a turn each started itself after background work finished.
// The prompt text names the recorded sequence to play once the prompted turn
// has ended.
import { Readable, Writable } from "node:stream"
import { AgentSideConnection, RequestError, ndJsonStream } from "@agentclientprotocol/sdk"

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
  // Played inside the prompted turn, as grok 1.0.44 and devin 3000.10.23
  // send them mid-turn.
  const grokUpdate = (update, session = sessionId) => connection.extNotification("_x.ai/session_notification", { sessionId: session, update })
  const inline = {
    async "native-grok"() {
      await grokUpdate({ sessionUpdate: "hook_execution", hook: "PreToolUse" })
      await grokUpdate({ sessionUpdate: "auto_compact_started", tokens_used: 403803, context_window: 500000, percentage: 81, reason: "Context window 81% full" })
      await grokUpdate({ sessionUpdate: "auto_compact_started", tokens_used: 1, context_window: 2, percentage: 50, reason: "A child session" }, "child-session")
      await grokUpdate({ sessionUpdate: "compaction_checkpoint", checkpoint_id: "c1" })
      await grokUpdate({ sessionUpdate: "auto_compact_completed", tokens_before: 403803, tokens_after: 21289, elapsed_ms: 94952, summary_preview: null })
      await grokUpdate({ sessionUpdate: "session_summary_generated", session_summary: "Compacted fixture" })
      await grokUpdate({ sessionUpdate: "scheduled_task_fired" })
      await update({ sessionUpdate: "session_info_update", title: "Renamed by the agent" })
    },
    // Updates the ACP SDK refuses: Grok's own kinds on ACP's method (one
    // completion sent twice, as a replay would), a kind nobody declares, and
    // a known kind missing a required field.
    async "refused-updates"() {
      const own = (update, eventId) => connection.sessionUpdate({ sessionId, update, _meta: { eventId, agentTimestampMs: 1 } })
      await own({ sessionUpdate: "auto_compact_started", tokens_used: 1000, context_window: 2000, percentage: 50 }, "fixture-1")
      const completed = { sessionUpdate: "auto_compact_completed", tokens_before: 1000, tokens_after: 200, elapsed_ms: 4200, summary_preview: null }
      await own(completed, "fixture-2")
      await own(completed, "fixture-2")
      await grokUpdate({ sessionUpdate: "future_vendor_kind", value: { evidence: 42 } })
      await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" }, discardedNativeField: { evidence: 43 } })
      await update({ sessionUpdate: "mystery_update", value: 1 })
      await update({ sessionUpdate: "tool_call", toolCallId: "no-title" })
      await chunk("agent_message_chunk", "Still streaming.")
    },
    // grok 1.0.44 answering /compact, recorded 2026-10-01: only the
    // completion its automatic compactions also send, then the turn's end.
    async "/compact"() {
      await grokUpdate({ sessionUpdate: "auto_compact_completed", tokens_before: 23278, tokens_after: 9100, summary_preview: null })
    },
    async "native-devin"() {
      await connection.extNotification("_cognition.ai/connection_retry", { sessionId, attempt: 1, maxAttempts: 5, isStreamRetry: true })
      await chunk("agent_message_chunk", "Reconnected.")
      await connection.extNotification("_cognition.ai/turn_stats", { sessionId, turnClientMessageId: "m1" })
      await connection.extNotification("_cognition.ai/agent_stopped", { sessionId, cause: "quota_exhausted", errorMessage: "You have used all of your credits.", stats: {} })
    },
  }
  return {
    async initialize() {
      return { protocolVersion: 1, agentCapabilities: { loadSession: false } }
    },
    // MCP servers failing while the session opens, before its id reaches
    // the client, as grok 1.0.44 and devin 3000.10.23 report them.
    async newSession() {
      if (process.env.FIXTURE_PROVIDER === "provider-turn-modes") return {
        sessionId,
        modes: { currentModeId: "default", availableModes: [
          { id: "default", name: "Default" }, { id: "plan", name: "Plan" },
          { id: "refused", name: "Refused" }, { id: "slow", name: "Slow" },
        ] },
      }
      if (process.env.FIXTURE_PROVIDER === "provider-turn-grok") {
        await connection.extNotification("_x.ai/mcp/servers_updated", { mcpServers: [{ name: "okserver" }, { name: "crashes" }] })
        await connection.extNotification("_x.ai/mcp/server_status", { sessionId, name: "crashes", status: "unavailable", reason: "handshake_failed",
          detail: "MCP server 'crashes' handshake failed: connection closed: initialize response" })
        await connection.extNotification("_x.ai/mcp/server_status", { sessionId, name: "okserver", status: "ready", reason: "initialized" })
      }
      if (process.env.FIXTURE_PROVIDER === "provider-turn-devin") {
        const output = (channel, message, session = "") => connection.extNotification("_cognition.ai/output", { sessionId: session, channel, level: "warn", message })
        await output("MCP: missing", "MCP server 'missing' connection failed: cannot find binary path")
        await output("MCP", "Failed to connect to MCP server 'missing' for description: cannot find binary path")
        await output("MCP: crashes", "MCP server 'crashes' connection failed: connection closed: initialize response", sessionId)
        await output("MCP", "Failed to connect to MCP server 'crashes' for description: connection closed: initialize response", sessionId)
      }
      return { sessionId }
    },
    async authenticate() {
      return {}
    },
    async setSessionMode({ modeId }) {
      if (modeId === "refused") throw new RequestError(-32000, "Native mode refused")
      if (modeId === "slow") await pause(300)
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
      if (inline[name]) {
        await inline[name]()
        return { stopReason: "end_turn" }
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

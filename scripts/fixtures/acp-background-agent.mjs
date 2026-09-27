// An ACP agent that starts a background command on the prompt "start" and
// ends it the way the agent named by ACP_BACKGROUND_FIXTURE does, as recorded
// on 2026-09-27. grok 1.0.41 reports its tasks in `background_tasks`, ends
// them on `session/close` and resumes the session with `session/resume`; it
// leaves them running when stdin closes or a turn is cancelled. devin
// 3000.6.14 reports a background exec call, ends its shell on
// `_cognition.ai/terminal/killBackgroundShell` or when stdin closes, and has
// no `session/close`. Both leave their work running on a signal. "stuck"
// never exits on its own. The prompt "work" runs until cancelled.
import { spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"

const agent = process.env.ACP_BACKGROUND_FIXTURE
const sessionId = "background-fixture"
let background
let cancelled
let open = true

const connection = new AgentSideConnection((client) => {
  const chunk = (text) => client.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } })
  const tasks = (running) => client.extNotification("_x.ai/session_notification", {
    sessionId, update: { sessionUpdate: "background_tasks", tasks: running ? [{ task_id: "task-1", status: "running", command: "sleep 300" }] : [] },
  })
  const exec = (status, meta) => client.sessionUpdate({ sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "exec-1", status, _meta: meta } })
  const end = () => {
    background?.kill()
    background = undefined
  }
  return {
    async initialize() {
      return { protocolVersion: 1, agentCapabilities: { loadSession: false, sessionCapabilities: agent === "grok" ? { close: {}, resume: {} } : {} } }
    },
    async newSession() {
      return { sessionId }
    },
    async authenticate() {
      return {}
    },
    async prompt(params) {
      if (!open) throw new Error("Session not found")
      const text = params.prompt.find((block) => block.type === "text")?.text
      if (text === "work") {
        await new Promise((resolve) => { cancelled = resolve })
        return { stopReason: "cancelled" }
      }
      if (text === "start") {
        background = spawn("sleep", ["300"], { stdio: "ignore" })
        if (agent === "grok") await tasks(true)
        if (agent === "devin") await exec("in_progress", { "cognition.ai/background": true, "cognition.ai/backgroundShellId": "shell-1" })
        await chunk(`background ${background.pid}`)
      } else await chunk(`answered ${text}`)
      return { stopReason: "end_turn" }
    },
    async cancel() {
      cancelled?.()
    },
    async closeSession() {
      end()
      await tasks(false)
      open = false
      return {}
    },
    async resumeSession() {
      open = true
      return {}
    },
    async extMethod(method, params) {
      if (agent !== "devin" || method !== "_cognition.ai/terminal/killBackgroundShell" || params.shellId !== "shell-1") return {}
      end()
      await exec("completed", { terminal_exit: { terminal_id: "shell-1", exit_code: -1, signal: null } })
      return {}
    },
  }
}, ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))

void connection.closed.then(() => {
  if (agent === "devin") background?.kill()
  if (agent !== "stuck") process.exit(0)
})

// An ACP agent that starts a background command on its first prompt and ends
// it the way the agent named by ACP_SHUTDOWN_FIXTURE does, as recorded on
// 2026-09-27: grok 1.0.41 stops its tasks on `session/close` and leaves them
// running when stdin closes; devin 3000.6.14 has no `session/close` and stops
// its shells when stdin closes. Both leave them running on a signal. "stuck"
// never exits on its own.
import { spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"

const agent = process.env.ACP_SHUTDOWN_FIXTURE
const sessionId = "shutdown-fixture"
let background

const connection = new AgentSideConnection((client) => ({
  async initialize() {
    return { protocolVersion: 1, agentCapabilities: { loadSession: false, sessionCapabilities: agent === "grok" ? { close: {} } : {} } }
  },
  async newSession() {
    return { sessionId }
  },
  async authenticate() {
    return {}
  },
  async prompt() {
    background = spawn("sleep", ["300"], { stdio: "ignore" })
    await client.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `background ${background.pid}` } } })
    return { stopReason: "end_turn" }
  },
  async cancel() {},
  async closeSession() {
    background?.kill()
    return {}
  },
}), ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))

void connection.closed.then(() => {
  if (agent === "devin") background?.kill()
  if (agent !== "stuck") process.exit(0)
})

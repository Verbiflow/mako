// A native process that fails the way real ones do, speaking just enough of
// one harness protocol (MAKO_STANDIN_PROTOCOL: codex app-server, ACP, the
// Cursor SDK child's wire, Claude Code's stream-json, or OpenCode's launcher,
// which only ever hangs before reporting its API) for
// the real driver to reach the failure. MAKO_STANDIN_BEHAVIOR:
// - "hang": never answers its first request, so startup is still pending.
// - "exit-on-prompt": starts a child that keeps this process's stdout and
//   stderr open, then exits as the prompt arrives, before acknowledging it.
// Its pid and its child's are written to MAKO_STANDIN_PIDS.
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { createInterface } from "node:readline"

const protocol = process.env.MAKO_STANDIN_PROTOCOL
const behavior = process.env.MAKO_STANDIN_BEHAVIOR
const version = process.env.MAKO_STANDIN_VERSION ?? "standin-9.9.9"
// OpenCode's launcher asks the executable its version before serving.
if (process.argv.includes("--version")) {
  process.stdout.write(`${protocol === "opencode" ? "2.0.1" : version}\n`)
  process.exit(0)
}
const pids = { pid: process.pid }
if (behavior === "exit-on-prompt") {
  const child = spawn("sleep", ["300"], { stdio: ["ignore", "inherit", "inherit"] })
  child.unref()
  pids.child = child.pid
}
writeFileSync(process.env.MAKO_STANDIN_PIDS, JSON.stringify(pids))

const send = protocol === "cursor"
  ? ({ id, result }) => process.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`)
  : (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
const prompts = { codex: "turn/start", acp: "session/prompt", cursor: "send" }[protocol]
const results = {
  codex: {
    initialize: () => ({ userAgent: version }),
    "account/read": () => ({ account: null, requiresOpenaiAuth: false }),
    "thread/start": (params) => ({ thread: { id: "standin-thread", cwd: params.cwd } }),
  },
  acp: {
    initialize: () => ({ protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "standin", version } }),
    "session/new": () => {
      const modes = JSON.parse(process.env.MAKO_STANDIN_MODES ?? "[]")
      return { sessionId: "standin-session", ...(modes.length && { modes: { currentModeId: modes[0].id, availableModes: modes } }) }
    },
  },
  cursor: {
    hello: () => ({ wire: 1, sdkVersion: version, node: process.version }),
    me: () => ({ apiKeyName: "standin", createdAt: new Date(0).toISOString() }),
    models: () => ({ models: [{ id: "standin-model", displayName: "Stand-in" }] }),
    open: (params) => ({ agentId: params.agentId }),
  },
  claude: {},
  opencode: {},
}[protocol]
if (!results) throw new Error(`Unknown stand-in protocol ${protocol}`)

// Claude Code's stream-json: control requests are answered; a user message
// opens a turn with `system/init`, which carries the version, and is never
// echoed back, so it is never acknowledged.
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const claude = (message) => {
  if (message.type === "control_request") {
    const response = message.request.subtype === "initialize"
      ? { commands: [], models: [], output_style: "default", available_output_styles: ["default"], account: { email: "standin@example.invalid" } }
      : {}
    return write({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } })
  }
  if (message.type !== "user") return
  write({ type: "system", subtype: "init", uuid: crypto.randomUUID(), session_id: message.session_id || "standin-session", claude_code_version: version,
    cwd: process.cwd(), tools: [], mcp_servers: [], model: "standin-model", permissionMode: "default", slash_commands: [], apiKeySource: "none", output_style: "default" })
  setTimeout(() => process.exit(1), 50)
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (behavior === "hang") return
  if (protocol === "claude") return claude(JSON.parse(line))
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) return
  if (method === prompts) process.exit(1)
  send({ id, result: results[method]?.(params) ?? {} })
})
process.stdin.on("end", () => process.exit(0))

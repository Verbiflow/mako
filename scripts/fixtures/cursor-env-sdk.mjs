import { appendFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"

// Stands in for @cursor/sdk the way SDK 1.0.31 runs tools: each shell or MCP
// child is spawned with `{ ...process.env, ... }` read at call time.
export class ConfigurationError extends Error {}
export class AgentBusyError extends Error {}
export class AgentNotFoundError extends Error {}
export class AuthenticationError extends Error {}
export class CursorSdkError extends Error {}
export class NetworkError extends Error {}
export class RateLimitError extends Error {}

const root = process.cwd()
const trace = (event, value) => appendFileSync(join(root, "trace"), JSON.stringify({ event, value }) + "\n")
const tool = () => execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], {
  env: { ...process.env, PAGER: "cat", CURSOR_AGENT: "1" },
  encoding: "utf8",
})

export const Cursor = {
  configure() {},
  auth: { async status() { return { status: "logged-out" } } },
  async me(options) {
    trace("me", options?.apiKey)
    return { userEmail: "fixture@example.com", apiKeyName: "Mako", createdAt: new Date(0).toISOString() }
  },
  models: {
    async list(options) {
      trace("models", options?.apiKey)
      return []
    },
  },
}

function handle(agentId, options) {
  return {
    agentId, model: options.model,
    async send() {
      trace("tool-env", JSON.parse(tool()))
      return { id: "fixture-run", async *stream() {}, async cancel() {}, async wait() { return { status: "finished" } } }
    },
    close() {},
  }
}

export const Agent = {
  async create(options) {
    trace("open", options.apiKey)
    return handle(options.agentId, options)
  },
  async resume(agentId, options) {
    trace("open", options.apiKey)
    return handle(agentId, options)
  },
}

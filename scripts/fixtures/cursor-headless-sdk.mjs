import { existsSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

export class ConfigurationError extends Error {}
export class AgentBusyError extends Error {}
export class AgentNotFoundError extends Error {}
export class AuthenticationError extends Error {}
export class CursorSdkError extends Error {}
export class NetworkError extends Error {}
export class RateLimitError extends Error {}
export const Cursor = { configure() {} }
const root = process.cwd()
const phase = process.env.MAKO_HEADLESS_FIXTURE_PHASE
const trace = event => appendFileSync(join(root, "trace"), event + "\n")
async function gate(name) {
  const deadline = Date.now() + 15_000
  while (!existsSync(join(root, name))) {
    if (Date.now() >= deadline) throw new Error(`fixture gate ${name} expired`)
    await delay(5)
  }
}
export const Agent = {
  async resume(agentId, options) {
    trace("open")
    if (phase === "open" || phase === "source") await gate("open-go")
    return {
      agentId, model: options.model,
      async send() {
        trace("send")
        if (phase === "send") await gate("send-go")
        let stopped = false
        return {
          id: "fixture-run",
          async cancel() {
            trace("cancel")
            if (phase === "cancel-failure") throw new Error("fixture cancellation failed")
            stopped = true
          },
          async wait() {
            trace("wait")
            await gate("wait-go")
            trace("terminal")
            return { status: stopped ? "cancelled" : "finished" }
          },
        }
      },
      close() { trace("close") },
    }
  },
}

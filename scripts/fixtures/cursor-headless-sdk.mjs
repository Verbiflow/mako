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
    if (!(await options.local.store.agents.get({ agentId }))) {
      const now = Date.now()
      await options.local.store.agents.create({ agent: { agentId, cwd: root, status: "idle", createdAt: now, updatedAt: now } })
    }
    return {
      agentId, model: options.model,
      async send() {
        const now = Date.now()
        await options.local.store.runs.create({ run: { agentId, runId: "fixture-run", turnNumber: 1, status: "running", createdAt: now, updatedAt: now } })
        await options.local.store.agents.update({ agent: { agentId, cwd: root, status: "running", activeRunId: "fixture-run", createdAt: now, updatedAt: now } })
        trace("send")
        if (phase === "send-crash") process.exit(77)
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

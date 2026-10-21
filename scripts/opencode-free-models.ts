import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import { createOpenCodeDriver } from "@mako/host/harnesses/opencode/live-driver"
import { discoverOpenCodeCatalog } from "@mako/host/harnesses/opencode/profile"
import { OpenCodeServers } from "@mako/host/harnesses/opencode/servers"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { admitted } from "./fixtures/admitted-start.ts"

/** How long one model's one-word answer may take. */
const ANSWER_MS = 90_000

/**
 * Two free models OpenCode Zen answers on now, for a live test in its isolated home, `MAKO_OPENCODE_MODEL` and
 * `MAKO_OPENCODE_SECOND_MODEL` choosing first. Zen withdraws free models without notice
 * (`muse-spark-1.3-contributor-free`, then `space-bunny-free` and `mimo-v2.6-flash-free` in October 2026), and lists
 * some it refuses: on 2026-10-20 it listed eight and answered two, the rest "Model unavailable" in about 1 s. So each
 * of the catalog's free models, Zen's default first, is asked for one word, until two answer.
 */
export async function openCodeFreeModels(command: string, env: NodeJS.ProcessEnv, cwd: string): Promise<{ first: string; second: string }> {
  const chosen = [process.env.MAKO_OPENCODE_MODEL, process.env.MAKO_OPENCODE_SECOND_MODEL]
  if (chosen[0] && chosen[1]) return { first: chosen[0], second: chosen[1] }
  const catalog = await discoverOpenCodeCatalog(command, env, cwd, new OpenCodeServers())
  const free = catalog.models.map((model) => model.id).filter((id) => id.startsWith("opencode/") && id.endsWith("-free"))
  const zenDefault = catalog.defaultModel && `${catalog.defaultModel.providerID}/${catalog.defaultModel.id}`
  const candidates = [...new Set([zenDefault, ...free])].filter((id): id is string => id !== undefined && free.includes(id) && !chosen.includes(id))
  const driver = createOpenCodeDriver({ stores: new NativeStores(false), servers: new OpenCodeServers(), approvalRoot: async () => join(cwd, ".free-model-approvals") })
  const answering = chosen.filter((id): id is string => id !== undefined)
  const refused: string[] = []
  for (const model of candidates) {
    if (answering.length >= 2) break
    if (await answers(driver, model, env, cwd)) answering.push(model)
    else refused.push(model)
  }
  if (!answering.length) throw new Error(`OpenCode Zen answered none of its free models (${refused.join(", ")}); set MAKO_OPENCODE_MODEL to one this machine can run`)
  if (refused.length) console.log(`OpenCode Zen refused ${refused.join(", ")}; testing with ${answering.join(" and ")}`)
  return { first: answering[0]!, second: answering[1] ?? answering[0]! }
}

/** Whether `model` answers one word through Mako's driver, the test's own path. */
async function answers(driver: ReturnType<typeof createOpenCodeDriver>, model: string, env: NodeJS.ProcessEnv, cwd: string): Promise<boolean> {
  const id = randomUUID()
  let state: LiveSessionState | undefined
  try {
    await driver.start(cwd, admitted("opencode", { conversationId: id, emit: (event) => { if (event.type === "live-session") state = event.session }, tuning: { model } }, { env }))
    await driver.prompt(id, "Reply with exactly the word ok.", [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => undefined })
    for (const deadline = Date.now() + ANSWER_MS; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 200)))
      if (state && state.status !== "running" && state.lastStop) return state.lastStop === "end_turn"
    return false
  } catch {
    return false
  } finally {
    await Promise.resolve().then(() => driver.close(id)).catch(() => undefined)
  }
}

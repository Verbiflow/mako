import { z } from "zod"
import type { CommitGenerationInput, CommitGenerationResult } from "./shared.js"
import { parseAgentModelId } from "./contracts/utility-work.js"
import { UtilityModelError } from "./utility-model-error.js"
import type { UtilityWork } from "./utility-work.js"
import { KiriCommitEngine } from "./kiri-commit.js"

const inputSchema = z.object({ mode: z.enum(["fast", "deep"]).default("fast"), requestId: z.string().uuid(), cwd: z.string().min(1).max(4_096), prompt: z.string().max(12_000).optional(), model: z.string().max(400).optional() })

/** A model connection answers each of Kiri's calls in seconds. */
const CONNECTION_TIMEOUT_MS = 120_000
/** A harness starts a process for each call, so the same work takes longer. */
const AGENT_TIMEOUT_MS = 300_000

export class CommitGeneration {
  private readonly active = new Map<string, { id: string; controller: AbortController }>()
  private readonly work: UtilityWork
  private readonly engine: KiriCommitEngine
  constructor(work: UtilityWork, engine = new KiriCommitEngine()) {
    this.work = work
    this.engine = engine
  }

  async generate(client: string, input: CommitGenerationInput): Promise<CommitGenerationResult> {
    const parsed = inputSchema.safeParse(input)
    if (!parsed.success) throw new Error("Invalid commit-generation request. Keep custom instructions under 12,000 characters.")
    if (this.active.has(client)) throw new Error("A commit message is already being generated in this window.")
    const request = parsed.data
    const controller = new AbortController()
    this.active.set(client, { id: request.requestId, controller })
    let signal = controller.signal
    try {
      const resolved = await this.work.resolve("commit", request.model)
      if (resolved.kind === "unavailable") throw new Error(resolved.reason)
      const { model } = resolved
      signal = AbortSignal.any([controller.signal, AbortSignal.timeout(parseAgentModelId(model.id) ? AGENT_TIMEOUT_MS : CONNECTION_TIMEOUT_MS)])
      return await this.engine.generate({ client, cwd: request.cwd, mode: request.mode, model, prompt: request.prompt, signal })
    } catch (error) {
      if (signal.aborted) throw new UtilityModelError("timeout", controller.signal.aborted ? "Generation cancelled." : "Generation timed out. Completed analysis can be reused on retry.")
      throw error
    } finally {
      if (this.active.get(client)?.controller === controller) this.active.delete(client)
    }
  }
  cancel(client: string, requestId: string): void {
    const request = this.active.get(client)
    if (request?.id === requestId) { request.controller.abort(); this.active.delete(client) }
  }
  commit(client: string, cwd: string, message: string): Promise<void> { return this.engine.commit(client, cwd, message) }
}

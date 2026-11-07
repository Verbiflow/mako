import { z } from "zod"
import type { MethodTable } from "../base/methods.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { AccessTier } from "../contracts/access.js"
import type { AgentCaller } from "../contracts/agents.js"
import { HarnessUpdateResultSchema } from "../contracts/harness-updates.js"
import type { JsonValue } from "../contracts/json.js"
import { AFTER_ACT, type HarnessActInput, type HarnessActResult } from "../contracts/thread-tools.js"
import type { AgentAskGate } from "./agent-ask-gate.js"

export interface HarnessToolDeps {
  /** The conversation a Session's agent runs in here. */
  conversationOf(session: string): string | undefined
  tier(conversationId: string): AccessTier | undefined
  /** A host call through the table every client calls, decoded: Install and Update as Settings presses them. */
  invoke(channel: "mako:harness-updates" | "mako:harness-install" | "mako:harness-update", args: unknown[]): Promise<JsonValue | undefined>
  /** This host is a cloud machine, whose harnesses come from its image. */
  machine: boolean
  gate: AgentAskGate
  /** How long a call waits for an install to refuse before saying it started. */
  startedAfterMs?: number
}

const ReceiptSchema = z.object({ result: HarnessUpdateResultSchema.optional() }).loose()

/** An agent's or a shell's Install and Update of a harness, through the calls Settings › Harnesses makes. */
export class HarnessTool {
  readonly #deps: HarnessToolDeps

  constructor(deps: HarnessToolDeps) {
    this.#deps = deps
  }

  async act(caller: AgentCaller, input: HarnessActInput): Promise<HarnessActResult> {
    if (input.action === "read") return this.#deps.invoke("mako:harness-updates", []).then((harnesses): HarnessActResult => ({ outcome: "read", harnesses: harnesses ?? null }), (error: Error) => ({ refused: "failed", why: error.message }))
    if (this.#deps.machine) return { refused: "cloud-machine", why: "A cloud machine's harnesses come from its image: they can't be installed or updated here." }
    const own = caller.kind === "agent" ? this.#deps.conversationOf(caller.session) : undefined
    if (caller.kind === "agent" && !own) return { refused: "no-thread", why: "No conversation here has that Session. Call it from a Thread's mako tools, or its shell, where MAKO_SESSION_ID names it." }
    if (!input.harness) return { refused: "no-harness", why: "Name the harness: claude, codex, cursor, grok, opencode or devin." }
    if (own && this.#deps.tier(own) !== "full") {
      const ask = this.#deps.gate.ask(own, { kind: "harness", action: input.action, harness: input.harness })
      return { outcome: "asked", ask: ask.id, next: AFTER_ACT.asked }
    }
    return this.run(input.action, input.harness)
  }

  /** Starts it, as Settings does, and answers once it's under way: an install outlasts a tool call. One refused at once says so. */
  async run(action: "install" | "update", harness: string): Promise<HarnessActResult> {
    const finished = this.#deps.invoke(action === "install" ? "mako:harness-install" : "mako:harness-update", [harness]).then(
      (answer): HarnessActResult => {
        // A package command that failed is a receipt the host resolves with, not a rejection.
        const result = ReceiptSchema.safeParse(answer).data?.result
        if (result?.outcome === "failed") {
          hostWarn("harness-tool", "a harness an agent asked for failed", { action, harness, error: result.message ?? "no words from its updater" })
          return { refused: "failed", why: result.message ?? `${action === "install" ? "Installing" : "Updating"} ${harness} failed.` }
        }
        hostLog("harness-tool", "a harness an agent asked for finished", { action, harness, result: result?.outcome ?? "unsaid" })
        return { outcome: "finished", action, harness, ...(result && { result: result.outcome }) }
      },
      (error: Error): HarnessActResult => {
        hostWarn("harness-tool", "a harness an agent asked for failed", { action, harness, error: error.message })
        return { refused: "failed", why: error.message }
      },
    )
    const started = new Promise<HarnessActResult>((resolve) => {
      setTimeout(() => resolve({ outcome: "started", action, harness, next: AFTER_ACT.started }), this.#deps.startedAfterMs ?? 3_000).unref?.()
    })
    return Promise.race([finished, started])
  }
}

/** `mako:harnesses-act`. */
export function declareHarnessToolMethods(methods: MethodTable, tool: () => HarnessTool | undefined): void {
  methods.handle("mako:harnesses-act", (caller: AgentCaller, input: HarnessActInput) => tool()?.act(caller, input) ?? { refused: "unavailable", why: "This host can't install harnesses." })
}

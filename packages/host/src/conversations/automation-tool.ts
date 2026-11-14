import { z } from "zod"
import { machineCall, NOT_THE_PERSON } from "../base/host-client.js"
import type { MethodTable } from "../base/methods.js"
import type { AccessTier } from "../contracts/access.js"
import type { AgentCaller } from "../contracts/agents.js"
import type { JsonValue } from "../contracts/json.js"
import type { AgentAskWant } from "../contracts/agent-asks.js"
import { AFTER_ACT, type AutomationActInput, type AutomationActResult } from "../contracts/thread-tools.js"
import type { AgentAskGate } from "./agent-ask-gate.js"
import { OnceByKey } from "./once-by-key.js"

export interface AutomationToolDeps {
  /** The conversation a Session's agent runs in here. */
  conversationOf(session: string): string | undefined
  tier(conversationId: string): AccessTier | undefined
  /** A host call through the table every client calls, decoded: each as Settings › Automations makes it. */
  invoke(channel: "mako:automations" | "mako:automation-context" | "mako:run-automation" | "mako:automation-enabled", args: unknown[]): Promise<JsonValue | undefined>
  gate: AgentAskGate
}

type Change = "run" | "on" | "off"

const AutomationIds = z.array(z.object({ id: z.string() }).loose())
const AutomationContext = z.object({ cwd: z.string().min(1), automations: AutomationIds })
const EnabledSchema = z.array(z.object({ id: z.string(), enabled: z.boolean() }).loose())
const FiredSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed") }),
  z.object({ status: z.literal("failed"), error: z.string() }),
  z.object({ status: z.literal("unknown"), error: z.string() }),
  z.object({ status: z.literal("not-run"), why: z.string() }),
])

/** An agent's or a shell's look at the person's automations, and Run now and the switch on each, through Settings' calls. */
export class AutomationTool {
  readonly #deps: AutomationToolDeps
  /** A run is a new conversation, and nothing else settles a repeat of one. */
  readonly #once = new OnceByKey<AutomationActResult>()

  constructor(deps: AutomationToolDeps) {
    this.#deps = deps
  }

  async act(caller: AgentCaller, input: AutomationActInput): Promise<AutomationActResult> {
    if (input.action === "list") return this.#deps.invoke("mako:automations", []).then((automations): AutomationActResult => ({ outcome: "listed", automations: automations ?? [] }), (error: Error) => ({ refused: "failed", why: error.message }))
    const own = caller.kind === "agent" ? this.#deps.conversationOf(caller.session) : undefined
    if (caller.kind === "agent" && !own) return { refused: "no-thread", why: "No conversation here has that Session. Call it from a Thread's mako tools, or its shell, where MAKO_SESSION_ID names it." }
    if (!input.id) return { refused: "no-automation", why: "Name the automation: list gives each one's id." }
    // Run now and the switch say nothing of an id they don't find, so it's read first: a call that did nothing never says done.
    const context = AutomationContext.safeParse(await this.#deps.invoke("mako:automation-context", []).catch(() => undefined)).data
    if (!context) return { refused: "unavailable", why: "Open the automation's workspace before changing it." }
    if (!context.automations.some((each) => each.id === input.id)) return { refused: "no-automation", why: `No automation here has the id ${input.id}: list gives each one's id.` }
    if (own && this.#deps.tier(own) !== "full") {
      const ask = this.#deps.gate.ask(own, { kind: "automation", action: input.action, id: input.id, cwd: context.cwd })
      return { outcome: "asked", ask: ask.id, next: AFTER_ACT.asked }
    }
    const { action, id } = input
    return this.#once.run(JSON.stringify([caller.kind === "agent" ? caller.session : "person", input.clientKey, action, id, context.cwd]), () => this.run(action, id, context.cwd).catch((error: Error) => ({ refused: "failed", why: error.message })))
  }

  /** The person allowed the ask: what the call would have run, and its failure is their answer's to say. */
  async allowed(conversationId: string, want: Extract<AgentAskWant, { kind: "automation" }>, askId: string): Promise<void> {
    // The gate passes this exact durable identity, even if another snapshot read replaced its objects.
    const ask = this.#deps.gate.open(conversationId).find((ask) => ask.id === askId)
    if (ask?.want.kind !== "automation" || ask.want.action !== want.action || ask.want.id !== want.id || ask.want.cwd !== want.cwd) throw new Error("That automation approval is no longer waiting here.")
    if (!want.cwd) throw new Error("This older ask doesn't name its automation's workspace. Keep it and ask again from the intended workspace.")
    const answer = await this.run(want.action, want.id, want.cwd, JSON.stringify([conversationId, ask.id]))
    if ("refused" in answer) throw new Error(answer.why)
  }

  /** Run now, or the switch, as Settings › Automations presses them; what's said is what the host says happened. */
  async run(action: Change, id: string, cwd: string, operation?: string): Promise<AutomationActResult> {
    if (action !== "run") {
      const kept = EnabledSchema.safeParse(await this.#deps.invoke("mako:automation-enabled", [id, action === "on", cwd])).data?.find((each) => each.id === id)
      if (kept?.enabled !== (action === "on")) return { refused: "failed", why: `This automation's trigger can't run here, so it stays ${kept?.enabled ? "on" : "off"}.` }
      return { outcome: "done", action, id }
    }
    // A launch that failed, or a run that never began, resolves with how it went.
    const fired = FiredSchema.safeParse(await this.#deps.invoke("mako:run-automation", [id, operation, cwd])).data
    if (!fired) return { refused: "failed", why: "Mako didn't confirm that automation's launch." }
    if (fired.status === "failed" || fired.status === "unknown") return { refused: "failed", why: fired.error }
    if (fired?.status === "not-run") return { refused: "failed", why: fired.why }
    return { outcome: "done", action, id }
  }
}

/** `mako:automations-act`. */
export function declareAutomationToolMethods(methods: MethodTable, tool: () => Pick<AutomationTool, "act"> | undefined): void {
  methods.handle("mako:automations-act", (caller: AgentCaller, input: AutomationActInput) =>
    caller.kind === "person" && machineCall() ? { refused: "no-thread" as const, why: NOT_THE_PERSON } : tool()?.act(caller, input) ?? { refused: "unavailable", why: "This host has no automations." })
}

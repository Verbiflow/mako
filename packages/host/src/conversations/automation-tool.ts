import type { MethodTable } from "../base/methods.js"
import type { AccessTier } from "../contracts/access.js"
import type { AgentCaller } from "../contracts/agents.js"
import type { JsonValue } from "../contracts/json.js"
import { AFTER_ACT, type AutomationActInput, type AutomationActResult } from "../contracts/thread-tools.js"
import type { AgentAskGate } from "./agent-ask-gate.js"

export interface AutomationToolDeps {
  /** The conversation a Session's agent runs in here. */
  conversationOf(session: string): string | undefined
  tier(conversationId: string): AccessTier | undefined
  /** A host call through the table every client calls, decoded: each as Settings › Automations makes it. */
  invoke(channel: "mako:automations" | "mako:run-automation" | "mako:automation-enabled", args: unknown[]): Promise<JsonValue>
  gate: AgentAskGate
}

type Change = "run" | "on" | "off"

/** An agent's or a shell's look at the person's automations, and Run now and the switch on each, through Settings' calls. */
export class AutomationTool {
  readonly #deps: AutomationToolDeps

  constructor(deps: AutomationToolDeps) {
    this.#deps = deps
  }

  async act(caller: AgentCaller, input: AutomationActInput): Promise<AutomationActResult> {
    if (input.action === "list") return this.#deps.invoke("mako:automations", []).then((automations): AutomationActResult => ({ outcome: "listed", automations }), (error: Error) => ({ refused: "failed", why: error.message }))
    const own = caller.kind === "agent" ? this.#deps.conversationOf(caller.session) : undefined
    if (caller.kind === "agent" && !own) return { refused: "no-thread", why: "No conversation here has that Session. Call it from a Thread's mako tools, or its shell, where MAKO_SESSION_ID names it." }
    if (!input.id) return { refused: "no-automation", why: "Name the automation: list gives each one's id." }
    if (own && this.#deps.tier(own) !== "full") {
      const ask = this.#deps.gate.ask(own, { kind: "automation", action: input.action, id: input.id })
      return { outcome: "asked", ask: ask.id, next: AFTER_ACT.asked }
    }
    return this.run(input.action, input.id).catch((error: Error) => ({ refused: "failed", why: error.message }))
  }

  /** Run now, or the switch, as Settings › Automations presses them. */
  async run(action: Change, id: string): Promise<AutomationActResult> {
    if (action === "run") await this.#deps.invoke("mako:run-automation", [id])
    else await this.#deps.invoke("mako:automation-enabled", [id, action === "on"])
    return { outcome: "done", action, id }
  }
}

/** `mako:automations-act`. */
export function declareAutomationToolMethods(methods: MethodTable, tool: () => AutomationTool | undefined): void {
  methods.handle("mako:automations-act", (caller: AgentCaller, input: AutomationActInput) => tool()?.act(caller, input) ?? { refused: "unavailable", why: "This host has no automations." })
}

import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { MethodTable } from "../base/methods.js"
import { hostLog } from "../base/host-log.js"
import type { AgentAsk, AgentAskWant } from "../contracts/agent-asks.js"
import type { LiveAsks } from "./live-asks.js"

type Run<Kind extends AgentAskWant["kind"]> = (conversationId: string, want: Extract<AgentAskWant, { kind: Kind }>) => void | Promise<void>

/** What each tool does once the person allows what its agent asked. */
export type AskRuns = { [Kind in AgentAskWant["kind"]]: Run<Kind> }

/**
 * One way below full access for every tool of Mako's that acts for the person: the agent's call raises an ask
 * (`LiveAsks`) and answers `asked`; the person's allow runs what the tool would have run on full access.
 */
export class AgentAskGate {
  readonly #asks: Pick<LiveAsks, "open" | "raise" | "settle">
  /** Told once composition has every tool. */
  runs: Partial<AskRuns> = {}

  constructor(asks: Pick<LiveAsks, "open" | "raise" | "settle">) {
    this.#asks = asks
  }

  open(conversationId: string): readonly AgentAsk[] {
    return this.#asks.open(conversationId)
  }

  /** Asks, once: the same want again finds the ask it raised. `same` says what a repeat is, when a want carries its own key. */
  ask(conversationId: string, want: AgentAskWant, same: (open: AgentAskWant) => boolean = (open) => isDeepStrictEqual(open, want)): AgentAsk {
    const known = this.#asks.open(conversationId).find((ask) => same(ask.want))
    if (known) return known
    const ask: AgentAsk = { id: randomUUID(), at: Date.now(), want }
    this.#asks.raise(conversationId, ask)
    return ask
  }

  /** The person's answer. A repeat finds nothing. */
  async answer(conversationId: string, id: string, allow: boolean): Promise<void> {
    const ask = this.#asks.settle(conversationId, id)
    if (!ask) return
    hostLog("agent-asks", allow ? "the person allowed what an agent asked" : "the person refused what an agent asked", { conversation: conversationId, want: ask.want.kind })
    if (allow) await this.#run(conversationId, ask.want)
  }

  /** What was asked says nothing now: the person did it by hand, or the Thread left. */
  retire(conversationId: string, kind: AgentAskWant["kind"]): void {
    for (const ask of this.#asks.open(conversationId)) if (ask.want.kind === kind) this.#asks.settle(conversationId, ask.id)
  }

  #run<Kind extends AgentAskWant["kind"]>(conversationId: string, want: Extract<AgentAskWant, { kind: Kind }>): void | Promise<void> {
    // SAFETY: `runs` is keyed by the want's own kind, so the run found here takes this want.
    const run = this.runs[want.kind as Kind] as Run<Kind> | undefined
    return run?.(conversationId, want)
  }
}

/** `mako:agent-ask-answer`: the person answers on any device, on the host running the conversation. */
export function declareAgentAskMethods(methods: MethodTable, gate: () => AgentAskGate | undefined): void {
  methods.handle("mako:agent-ask-answer", (conversationId: string, id: string, allow: boolean) => gate()?.answer(conversationId, id, allow))
}

import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { MethodTable } from "../base/methods.js"
import { hostLog } from "../base/host-log.js"
import type { AgentAsk, AgentAskAnswer, AgentAskWant } from "../contracts/agent-asks.js"
import type { LiveAsks } from "./live-asks.js"

type Run<Kind extends AgentAskWant["kind"]> = (conversationId: string, want: Extract<AgentAskWant, { kind: Kind }>, askId: string) => void | Promise<void>

/** What each tool does once the person allows what its agent asked. */
export type AskRuns = { [Kind in AgentAskWant["kind"]]: Run<Kind> }

/**
 * One way below full access for every tool of Mako's that acts for the person: the agent's call raises an ask
 * (`LiveAsks`) and answers `asked`; the person's allow runs what the tool would have run on full access.
 */
export class AgentAskGate {
  readonly #asks: Pick<LiveAsks, "open" | "raise" | "settle">
  readonly #allowing = new Map<string, Promise<AgentAskAnswer>>()
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

  /** A failed allow keeps the exact ask; matching answers share its result until it succeeds. */
  async answer(conversationId: string, id: string, allow: boolean): Promise<AgentAskAnswer> {
    const key = JSON.stringify([conversationId, id])
    const running = this.#allowing.get(key)
    if (running) {
      if (!allow) throw new Error("An answer to this ask is already under way.")
      const answer = await running
      return answer.outcome === "answered" ? { ...answer, outcome: "joined" } : answer
    }
    const ask = this.#asks.open(conversationId).find((ask) => ask.id === id)
    if (!ask) return { outcome: "missing", ask: id }
    hostLog("agent-asks", allow ? "the person allowed what an agent asked" : "the person refused what an agent asked", { conversation: conversationId, want: ask.want.kind })
    if (!allow) {
      const settled = this.#asks.settle(conversationId, id)
      return settled ? { outcome: "answered", ask: id, allow: false, want: ask.want } : { outcome: "missing", ask: id }
    }
    // Own this choice before its action starts; failure never removes and recreates a durable ask.
    const outcome = Promise.resolve().then(() => this.#run(conversationId, ask.want, ask.id)).then<AgentAskAnswer>(() => {
      const settled = this.#asks.settle(conversationId, id)
      return settled ? { outcome: "answered", ask: id, allow: true, want: ask.want } : { outcome: "missing", ask: id }
    })
    this.#allowing.set(key, outcome)
    try {
      return await outcome
    } finally {
      this.#allowing.delete(key)
    }
  }

  /** What was asked says nothing now: the person did it by hand, or the Thread left. */
  retire(conversationId: string, kind: AgentAskWant["kind"]): void {
    for (const ask of this.#asks.open(conversationId)) if (ask.want.kind === kind) this.#asks.settle(conversationId, ask.id)
  }

  #run<Kind extends AgentAskWant["kind"]>(conversationId: string, want: Extract<AgentAskWant, { kind: Kind }>, askId: string): void | Promise<void> {
    // SAFETY: `runs` is keyed by the want's own kind, so the run found here takes this want.
    const run = this.runs[want.kind as Kind] as Run<Kind> | undefined
    if (!run) throw new Error("This host can't answer that agent ask yet.")
    return run(conversationId, want, askId)
  }
}

/** `mako:agent-ask-answer`: the person answers on any device, on the host running the conversation. */
export function declareAgentAskMethods(methods: MethodTable, gate: () => AgentAskGate | undefined): void {
  methods.handle("mako:agent-ask-answer", (conversationId: string, id: string, allow: boolean) => gate()?.answer(conversationId, id, allow) ?? { outcome: "unavailable", ask: id })
}

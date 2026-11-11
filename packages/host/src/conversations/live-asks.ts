import { AGENT_ASK_ALLOW, AGENT_ASK_KEEP, agentAskWords, type AgentAsk } from "../contracts/agent-asks.js"
import type { PendingAsk } from "../contracts/live-questions.js"
import type { LivePermissionResponse } from "../contracts/providers-acp.js"
import type { LiveAccess } from "./live-runtime.js"

/** An agent's asks of the person, kept in its conversation's control: saved before the agent hears `asked`, gone once answered. */
export class LiveAsks {
  private readonly host: LiveAccess
  /**
   * What answers an ask, whoever answers it: the person's card, or the Fin's path (`agents_answer`, the person from its
   * Apex's row), which reaches it through `LiveConversations.permission` as a harness's approval does. Set once the
   * host's tools exist (`AgentAskGate.answer`).
   */
  answering: ((conversationId: string, ask: string, allow: boolean) => Promise<void>) | undefined
  constructor(host: LiveAccess) { this.host = host }

  /** An answer to the ask, as an approval's choice names it: `allow` lets it go. */
  async answer(id: string, ask: string, response: LivePermissionResponse): Promise<void> {
    if (!this.answering) throw new Error("This host can't answer an agent's ask yet.")
    await this.answering(id, ask, response.kind === "choice" && response.optionId === AGENT_ASK_ALLOW)
  }

  /** The ask as a harness's approval reads to a Fin's Apex and the person: the card's two answers. */
  pending(id: string): PendingAsk | undefined {
    const ask = this.open(id)[0]
    if (!ask) return undefined
    const words = agentAskWords(ask.want, "")
    return { request: ask.id, kind: "approval", options: [{ optionId: AGENT_ASK_ALLOW, name: words.allow, kind: "allow_once" }, { optionId: AGENT_ASK_KEEP, name: words.keep, kind: "reject_once" }], questions: [], named: true }
  }

  open(id: string): readonly AgentAsk[] {
    const resident = this.host.load(id)
    return resident ? this.host.control(resident).asks ?? [] : []
  }

  raise(id: string, ask: AgentAsk): void {
    const resident = this.host.require(id)
    const control = this.host.control(resident)
    if (control.asks?.some((item) => item.id === ask.id)) return
    resident.snapshot = { ...resident.snapshot, control: { ...control, asks: [...(control.asks ?? []), ask] } }
    this.host.flush(resident)
  }

  /** Takes the ask out, once: a repeat of an answer finds nothing. */
  settle(id: string, ask: string): AgentAsk | undefined {
    const resident = this.host.load(id)
    if (!resident) return undefined
    const control = this.host.control(resident)
    const found = control.asks?.find((item) => item.id === ask)
    if (!found) return undefined
    const asks = control.asks?.filter((item) => item !== found)
    resident.snapshot = { ...resident.snapshot, control: { ...control, asks: asks?.length ? asks : undefined } }
    this.host.flush(resident)
    return found
  }
}

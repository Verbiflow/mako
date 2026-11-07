import type { AgentAsk } from "../contracts/agent-asks.js"
import type { LiveAccess } from "./live-runtime.js"

/** An agent's asks of the person, kept in its conversation's control: saved before the agent hears `asked`, gone once answered. */
export class LiveAsks {
  private readonly host: LiveAccess
  constructor(host: LiveAccess) { this.host = host }

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

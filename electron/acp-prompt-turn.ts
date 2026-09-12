import { randomUUID } from "node:crypto"
import type { PromptResponse } from "@agentclientprotocol/sdk"
import { errorMessage } from "./live-runtime.js"

export type AcpTurnResult =
  | { kind: "completed"; stopReason: PromptResponse["stopReason"] }
  | { kind: "failed"; error: string }

export class AcpPromptTurn {
  readonly id = randomUUID()
  private pending = 0
  private closed = false
  private canceled = false
  private result: AcpTurnResult | undefined

  private readonly settled: (result: AcpTurnResult) => void

  constructor(settled: (result: AcpTurnResult) => void) {
    this.settled = settled
  }

  get acceptsSteering(): boolean {
    return this.pending > 0 && !this.closed && !this.canceled
  }

  cancel(): void {
    if (this.acceptsSteering) this.canceled = true
  }

  async send(prompt: () => Promise<PromptResponse>, kind: "prompt" | "steer" = "prompt"): Promise<void> {
    if (this.closed) throw new Error("This ACP turn has finished")
    if (this.canceled) throw new Error("This ACP turn is stopping")
    this.pending += 1
    try {
      const response = await prompt()
      if (this.result?.kind !== "failed" &&
        (this.result === undefined || this.result.stopReason === "cancelled" || response.stopReason !== "cancelled"))
        this.result = { kind: "completed", stopReason: response.stopReason }
    } catch (error) {
      if (kind === "prompt")
        this.result = { kind: "failed", error: errorMessage({ error }) }
      throw error
    } finally {
      this.pending -= 1
      setImmediate(() => {
        if (this.pending || this.closed || !this.result) return
        this.closed = true
        this.settled(this.canceled && this.result.kind === "completed"
          ? { kind: "completed", stopReason: "cancelled" }
          : this.result)
      })
    }
  }
}

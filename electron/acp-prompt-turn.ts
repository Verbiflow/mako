import { randomUUID } from "node:crypto"
import type { PromptResponse } from "@agentclientprotocol/sdk"
import { errorMessage } from "./live-runtime.js"

export type AcpTurnResult =
  | { kind: "completed"; stopReason: PromptResponse["stopReason"] }
  | { kind: "failed"; error: string }

/** How much of the turn's final text is kept for a provider's reported-failure check. */
const FINAL_TEXT_LIMIT = 4_096

export class AcpPromptTurn {
  readonly id = randomUUID()
  private pending = 0
  private closed = false
  private canceled = false
  private result: AcpTurnResult | undefined
  private final = ""

  private readonly settled: (result: AcpTurnResult) => void

  constructor(settled: (result: AcpTurnResult) => void) {
    this.settled = settled
  }

  get acceptsSteering(): boolean {
    return this.pending > 0 && !this.closed && !this.canceled
  }

  /**
   * The text streamed since the turn's last tool call or thought, bounded to
   * its tail. An agent that writes its own failure into the transcript does
   * so as the very last chunk, so this is what a provider's `reportedFailure`
   * reads.
   */
  get finalText(): string {
    return this.final
  }

  noteText(text: string): void {
    this.final = (this.final + text).slice(-FINAL_TEXT_LIMIT)
  }

  /** A tool call or thought means whatever text follows starts a new final segment. */
  noteActivity(): void {
    this.final = ""
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

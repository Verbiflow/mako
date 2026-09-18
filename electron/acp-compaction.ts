import type {
  PromptResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk"
import type { LiveActionResult } from "./contracts/live-actions.js"
import { COMPACTION_CONFIRMATION_MS } from "./contracts/recovery.js"

/** Protocol differences belong to the provider, not to the shared prompt loop. */
export type AcpCompactionSpec =
  | { kind: "unavailable"; reason: string }
  | {
      kind: "supported"
      command: string
      completion:
        | { kind: "response" }
        | {
            kind: "notification"
            observe(): (
              update: SessionNotification["update"]
            ) => LiveActionResult | undefined
          }
    }

/** One explicitly requested operation; notifications can precede the RPC reply. */
export class AcpCompaction {
  private readonly spec: Extract<AcpCompactionSpec, { kind: "supported" }>
  private readonly settled: (result: LiveActionResult) => void
  private finished = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly observeUpdate:
    | ((update: SessionNotification["update"]) => LiveActionResult | undefined)
    | undefined
  constructor(
    spec: Extract<AcpCompactionSpec, { kind: "supported" }>,
    settled: (result: LiveActionResult) => void
  ) {
    this.spec = spec
    this.settled = settled
    this.observeUpdate =
      spec.completion.kind === "notification"
        ? spec.completion.observe()
        : undefined
  }

  start(send: () => Promise<PromptResponse>): void {
    this.timer = setTimeout(
      () =>
        this.finish({
          kind: "uncertain",
          reason:
            "The provider did not confirm compaction. End the live session before sending again.",
        }),
      COMPACTION_CONFIRMATION_MS
    )
    this.timer.unref?.()
    void Promise.resolve()
      .then(send)
      .then(
        (response) => {
          if (response.stopReason !== "end_turn")
            this.finish({
              kind: "failed",
              reason: `Compaction stopped: ${response.stopReason}`,
            })
          else if (this.spec.completion.kind === "response")
            this.finish({ kind: "completed" })
        },
        (error) =>
          this.finish({
            kind: "uncertain",
            reason: error instanceof Error ? error.message : String(error),
          })
      )
  }

  observe(update: SessionNotification["update"]): void {
    if (this.finished) return
    const result = this.observeUpdate?.(update)
    if (result) this.finish(result)
  }

  private finish(result: LiveActionResult): void {
    if (this.finished) return
    this.finished = true
    clearTimeout(this.timer)
    this.settled(result)
  }

  dispose(): void {
    this.finished = true
    clearTimeout(this.timer)
  }
}

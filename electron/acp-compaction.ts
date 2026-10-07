import type {
  PromptResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk"
import { COMPACTION_FAILED } from "@mako/sessions/events"
import type { LiveActionResult } from "./contracts/live-actions.js"
import type { NativeNotice } from "./contracts/native-activity.js"
import { COMPACTION_CONFIRMATION_MS } from "./contracts/recovery.js"
import type { UsageObservation } from "./session-usage.js"

/** Protocol differences belong to the provider, not to the shared prompt loop. */
export type AcpCompactionSpec =
  | { kind: "unavailable"; reason: string }
  | {
      kind: "supported"
      command: string
      /** A command reply can precede the work it starts; the provider's own notifications confirm it. */
      completion: {
        kind: "notification"
        observe(): (
          update: SessionNotification["update"]
        ) => LiveActionResult | undefined
      }
    }

/** How the harness's own decoded notices settle a compaction Mako asked for, when they do. */
export function compactionOutcome(notices: readonly NativeNotice[], usage: readonly UsageObservation[] = []): LiveActionResult | undefined {
  const failed = notices.find((notice) => notice.kind === "event" && notice.event.label === COMPACTION_FAILED)
  if (failed?.kind === "event") return { kind: "failed", reason: failed.event.detail ?? "Compaction failed" }
  if (notices.some((notice) => notice.kind === "compacted") || usage.some((observation) => observation.kind === "compacted"))
    return { kind: "completed" }
  return undefined
}

/**
 * One explicitly requested operation; notifications can precede the RPC reply.
 * A deadline or a lost reply reports the outcome as unknown but keeps
 * listening: a Devin compaction that outlived the deadline used to have its
 * own "Context compacted" ignored, and the session refused every message
 * until it was ended.
 */
export class AcpCompaction {
  private readonly settled: (result: LiveActionResult) => void
  private finished = false
  private reportedUncertain = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly observeUpdate: (update: SessionNotification["update"]) => LiveActionResult | undefined
  constructor(
    spec: Extract<AcpCompactionSpec, { kind: "supported" }>,
    settled: (result: LiveActionResult) => void
  ) {
    this.settled = settled
    this.observeUpdate = spec.completion.observe()
  }

  start(send: () => Promise<PromptResponse>): void {
    this.timer = setTimeout(
      () =>
        this.uncertain(
          "The provider has not confirmed compaction yet. Its confirmation still completes it; Stop ends it."
        ),
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
        },
        (error) =>
          this.uncertain(error instanceof Error ? error.message : String(error))
      )
  }

  observe(update: SessionNotification["update"]): void {
    if (this.finished) return
    const result = this.observeUpdate(update)
    if (result) this.finish(result)
  }

  /** The harness's own compaction notice, decoded like any other, settles it too. */
  confirm(result: LiveActionResult): void {
    this.finish(result)
  }

  private uncertain(reason: string): void {
    if (this.finished || this.reportedUncertain) return
    this.reportedUncertain = true
    this.settled({ kind: "uncertain", reason })
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

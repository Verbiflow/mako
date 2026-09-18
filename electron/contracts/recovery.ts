import type { LiveAction } from "./live-actions.js"
import type { LiveSessionState } from "./providers-acp.js"

export const COMPACTION_CONFIRMATION_MS = 5 * 60_000

export type CompactionCapability =
  { kind: "supported" } | { kind: "unavailable"; reason: string }

export interface RecoveryCapabilities {
  compaction: CompactionCapability
}

export const UNAVAILABLE_RECOVERY: RecoveryCapabilities = {
  compaction: {
    kind: "unavailable",
    reason:
      "This agent connection does not support verified compaction. Start a new thread and carry over what matters.",
  },
}

/** Shared admission rule for the host and the recovery controls. */
export function compactionAvailable(
  session: LiveSessionState,
  actions: readonly LiveAction[],
  hasPendingMessages: boolean
): boolean {
  return (
    session.connection === "connected" &&
    (session.status === "ready" || session.status === "failed") &&
    !hasPendingMessages &&
    !actions.some(
      (action) =>
        action.state.kind === "dispatching" ||
        action.state.kind === "uncertain" ||
        (action.input.kind === "compact" && action.state.kind === "accepted")
    )
  )
}

import type { LiveAction } from "./live-actions.js"
import type { LiveSessionState } from "./providers-acp.js"

export const COMPACTION_CONFIRMATION_MS = 5 * 60_000

/** Shared admission rule for the host and the recovery controls. */
export function compactionAvailable(
  session: LiveSessionState,
  actions: readonly LiveAction[],
  hasPendingMessages: boolean
): boolean {
  return (
    session.connection !== "starting" &&
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

import type { AcpTurnResult } from "./acp-prompt-turn.js"
import type { LiveSessionState } from "./contracts/providers-acp.js"

/**
 * What a finished turn means for the session: a turn the agent completed is
 * `ready` with its own stop reason, a turn whose prompt call failed is
 * `failed` with that error.
 */
export function turnVerdict(result: AcpTurnResult): Pick<LiveSessionState, "status" | "lastStop" | "error"> {
  if (result.kind === "failed") return { status: "failed", lastStop: "failed", error: result.error }
  return { status: "ready", lastStop: result.stopReason }
}

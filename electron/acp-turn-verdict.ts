import type { SessionNotification } from "@agentclientprotocol/sdk"
import type { AcpPromptTurn, AcpTurnResult } from "./acp-prompt-turn.js"
import { classifyProviderFailure } from "./contracts/provider-failure.js"
import { CONNECTION_LOST_STOP, type LiveSessionState } from "./contracts/providers-acp.js"

/** Feed the running turn what it needs to know about a session update. */
export function observeTurnUpdate(turn: AcpPromptTurn, notification: SessionNotification): void {
  const update = notification.update
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type === "text") turn.noteText(update.content.text)
      return
    case "agent_thought_chunk":
    case "tool_call":
      turn.noteActivity()
      return
    default:
      return
  }
}

/**
 * What a finished turn means for the session. A turn the agent completed is
 * `ready` — unless the provider recognises its own error text as the last
 * thing the agent said, in which case the turn failed and the text is the
 * error. A dropped connection is the one failure that leaves the turn's work
 * intact and worth continuing, so it is marked as such rather than as a
 * message to send again.
 */
export function turnVerdict(
  result: AcpTurnResult,
  finalText: string,
  reportedFailure: ((finalText: string) => string | undefined) | undefined
): Pick<LiveSessionState, "status" | "lastStop" | "error"> {
  if (result.kind === "failed") return { status: "failed", lastStop: "failed", error: result.error }
  const reported = result.stopReason === "cancelled" ? undefined : reportedFailure?.(finalText)
  if (reported === undefined) return { status: "ready", lastStop: result.stopReason }
  const dropped = classifyProviderFailure(reported).kind === "network"
  return { status: "failed", lastStop: dropped ? CONNECTION_LOST_STOP : "failed", error: reported }
}

import type { AcpBackgroundObserver } from "../acp-source.js"

/**
 * Verified 2026-09-26 against devin 3000.6.14: a `run_in_background` shell
 * outlives its turn as an in-progress exec call whose update carries
 * `cognition.ai/background`, and that call completes with `terminal_exit`
 * when the shell exits.
 */
export function devinBackground(): AcpBackgroundObserver {
  const running = new Set<string>()
  return {
    sessionUpdate({ sessionId, update }) {
      if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return undefined
      const before = running.size
      if (update.status === "completed" || update.status === "failed") running.delete(update.toolCallId)
      else if (update._meta?.["cognition.ai/background"] === true) running.add(update.toolCallId)
      return running.size === before ? undefined : { sessionId, running: running.size }
    },
  }
}

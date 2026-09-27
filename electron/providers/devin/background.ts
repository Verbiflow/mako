import { z } from "zod"
import type { AcpBackgroundObserver } from "../acp-source.js"

const backgroundShell = z.object({
  "cognition.ai/background": z.literal(true),
  "cognition.ai/backgroundShellId": z.string(),
})

/**
 * Verified 2026-09-26 against devin 3000.6.14: a `run_in_background` shell
 * outlives its turn as an in-progress exec call whose update carries
 * `cognition.ai/background`, and that call completes with `terminal_exit`
 * when the shell exits.
 *
 * Every other end was checked on 2026-09-27 and completes the call too: a
 * shell killed from outside (`terminal_exit` with exit code -1, within about
 * five seconds) and one stopped by Devin's `kill_shell`. Cancelling a later
 * turn leaves the shell running and reports nothing, which is true. A loaded
 * session replays each call completed and without the background marker.
 */
export function devinBackground(): AcpBackgroundObserver {
  const shells = new Map<string, string>()
  return {
    sessionUpdate({ sessionId, update }) {
      if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return undefined
      const before = shells.size
      if (update.status === "completed" || update.status === "failed") shells.delete(update.toolCallId)
      else {
        const shell = backgroundShell.safeParse(update._meta)
        if (shell.success) shells.set(update.toolCallId, shell.data["cognition.ai/backgroundShellId"])
      }
      return shells.size === before ? undefined : { sessionId, running: shells.size }
    },
    /**
     * The shell's exec call completes as soon as it ends, and no turn follows.
     * Devin answers `{}` whether or not the shell exists.
     */
    async stop(control) {
      await Promise.all([...shells.values()].map((shellId) =>
        control.request("_cognition.ai/terminal/killBackgroundShell", { sessionId: control.sessionId, shellId })))
    },
  }
}

import { z } from "zod"
import type { AcpBackgroundObserver } from "../acp-source.js"
import type { NativeAgentObservation } from "../../contracts/native-agents.js"

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
const ExecCall = z.object({
  title: z.string().nullish(),
  rawInput: z.object({ command: z.string() }).partial().nullish(),
})
const ExecExit = z.object({
  terminal_exit: z.object({ exit_code: z.number().nullish(), signal: z.string().nullish() }),
})

/**
 * Devin's background shells: the running count, and each shell as a roster
 * entry. The update that marks a call backgrounded carries no title or
 * command, so the `tool_call` that opened it is kept until then.
 */
export function devinBackground(): AcpBackgroundObserver {
  const shells = new Map<string, string>()
  const calls = new Map<string, { title?: string; command?: string }>()
  return {
    sessionUpdate({ sessionId, update }) {
      if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return undefined
      if (update.sessionUpdate === "tool_call" && update.kind === "execute") {
        const call = ExecCall.safeParse(update)
        if (call.success) calls.set(update.toolCallId, { title: call.data.title ?? undefined, command: call.data.rawInput?.command })
        if (calls.size > 256) calls.delete(calls.keys().next().value!)
      }
      const before = shells.size
      const items: NativeAgentObservation[] = []
      const call = calls.get(update.toolCallId)
      const entry = (state: NativeAgentObservation["state"], stoppable: boolean): NativeAgentObservation => ({
        nativeId: update.toolCallId,
        title: (call?.title || call?.command || "Background shell").slice(0, 512),
        work: "command",
        ...(call?.command && { detail: call.command.slice(0, 8192) }),
        background: true,
        stoppable,
        source: "devin cognition.ai/background",
        state,
      })
      if (update.status === "completed" || update.status === "failed") {
        if (shells.delete(update.toolCallId)) {
          const exit = ExecExit.safeParse(update._meta).data?.terminal_exit
          const said = exit?.signal ? `Ended by ${exit.signal}` : exit?.exit_code !== undefined && exit.exit_code !== null ? `Exited with code ${exit.exit_code}` : undefined
          items.push(entry(update.status === "failed" ? { kind: "failed", error: said ?? "The shell failed" } : { kind: "completed", ...(said && { summary: said }) }, false))
        }
        calls.delete(update.toolCallId)
      } else {
        const shell = backgroundShell.safeParse(update._meta)
        if (shell.success && !shells.has(update.toolCallId)) {
          shells.set(update.toolCallId, shell.data["cognition.ai/backgroundShellId"])
          items.push(entry({ kind: "working" }, true))
        }
      }
      return shells.size === before && !items.length ? undefined : { sessionId, running: shells.size, items }
    },
    /**
     * The shell's exec call completes as soon as it ends, and no turn follows.
     * Devin answers `{}` whether or not the shell exists.
     */
    async stop(control) {
      await Promise.all([...shells.values()].map((shellId) =>
        control.request("_cognition.ai/terminal/killBackgroundShell", { sessionId: control.sessionId, shellId })))
    },
    async stopOne(control, nativeId) {
      const shellId = shells.get(nativeId)
      if (shellId) await control.request("_cognition.ai/terminal/killBackgroundShell", { sessionId: control.sessionId, shellId })
    },
  }
}

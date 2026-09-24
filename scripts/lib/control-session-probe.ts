/** Direct engine test probe. No MCP server, catalog or transport. */
import {
  createControlSession,
  COMPUTER_TOOL_INPUTS,
} from "../../packages/control-runtime/src/control-session.js"
import { controlFaultData, controlInputMessage } from "@mako/control/control"
import { z } from "zod"
export { BACKGROUND_INPUT_LADDER } from "@mako/control/computer"
export type SessionProbe = ReturnType<typeof controlSessionProbe>
export function controlSessionProbe(
  ...args: Parameters<typeof createControlSession>
) {
  const session = createControlSession(...args)
  return {
    ...session,
    async request(
      input: { method: string; arguments?: unknown },
      options: { signal?: AbortSignal } = {}
    ) {
      let dispatched = false
      try {
        const args = input.arguments ?? {}
        if (input.method === "exec") {
          const parsed = COMPUTER_TOOL_INPUTS.exec.parse(args)
          dispatched = true
          return {
            content: await session.execute(
              parsed,
              options.signal ?? new AbortController().signal
            ),
          }
        }
        const value =
          input.method === "status"
            ? await session.status()
            : input.method === "help"
              ? await session.help(z.record(z.string(), z.json()).parse(args))
              : (() => {
                  throw new Error(`Unknown engine method ${input.method}`)
                })()
        return {
          content: [{ type: "text" as const, text: JSON.stringify(value) }],
        }
      } catch (error) {
        if (options.signal?.aborted) throw error
        const detail = controlFaultData(error)
        const fault = {
          code:
            detail?.code ?? (dispatched ? "control-error" : "invalid-request"),
          outcome:
            detail?.outcome ?? (dispatched ? "unknown" : "not-dispatched"),
          message:
            error instanceof z.ZodError
              ? controlInputMessage(
                  error,
                  "engine input",
                  "Use the session input schema."
                )
              : error instanceof Error
                ? error.message
                : String(error),
        }
        return {
          isError: true,
          structuredContent: fault,
          content: [{ type: "text" as const, text: JSON.stringify(fault) }],
        }
      }
    },
  }
}

import { ControlProgramError } from "@mako/control/program"
import { controlFaultData } from "@mako/control/control"
import type { JsonValue } from "./json.js"
import type { ControlSession } from "./control-session.js"
import type { SessionOperation } from "./control-session-protocol.js"

export type ControlAgentOperation = Extract<
  SessionOperation,
  { method: "js" | "js-reset" }
>
export type ControlAgentRequest = (
  operation: ControlAgentOperation,
  signal: AbortSignal
) => Promise<JsonValue>

/** The same typed bridge serves embedded MCP and worker/socket hosts. */
export function controlAgent(
  session: Pick<ControlSession, "execute" | "resetProgram">
): ControlAgentRequest {
  return async (operation, signal): Promise<JsonValue> => {
    if (operation.method === "js-reset") {
      await session.resetProgram(signal)
      return {
        content: [
          {
            type: "text",
            text: "Program bindings and shared CLI state cleared. Targets and recordings remain owned by this task. The next js call includes documentation; observe before further input.",
          },
        ],
      }
    }
    try {
      const content = await session.execute(
        { source: operation.code },
        signal,
        {
          yield: false,
          mode: "repl",
          timeoutMs: operation.timeout_ms,
        }
      )
      return {
        content: content.length
          ? content
          : [{ type: "text", text: "Completed; no value emitted." }],
      }
    } catch (error) {
      const cause = error instanceof ControlProgramError ? error.cause : error
      const fault = controlFaultData(cause)
      return {
        isError: true,
        content: [
          ...(error instanceof ControlProgramError ? error.output : []),
          {
            type: "text",
            text: JSON.stringify({
              code: fault?.code ?? "script-error",
              outcome: fault?.outcome ?? "unknown",
              message:
                cause instanceof Error
                  ? cause.message
                  : "Control program failed",
              recovery:
                "Earlier statements may have completed. Inspect the exact target; never replay the whole program after uncertainty.",
            }),
          },
        ],
      }
    }
  }
}

import { ControlProgramError, programErrorText } from "@mako/control/program"
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
      return {
        isError: true,
        content: [
          ...(error instanceof ControlProgramError ? error.output : []),
          { type: "text", text: programErrorText(error) },
        ],
      }
    }
  }
}

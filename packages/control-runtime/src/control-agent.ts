import {
  ControlProgramError,
  programErrorText,
  type ControlProgramOutput,
} from "@mako/control/program"
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
          ? joinText(content)
          : [{ type: "text", text: "Completed; no value emitted." }],
      }
    } catch (error) {
      return {
        isError: true,
        content: joinText([
          ...(error instanceof ControlProgramError ? error.output : []),
          { type: "text", text: programErrorText(error) },
        ]),
      }
    }
  }
}

/**
 * MCP clients join a result's text blocks differently, some with nothing
 * between them, so printed lines leave as one block. Images stay separate.
 */
function joinText(
  blocks: readonly ControlProgramOutput[]
): ControlProgramOutput[] {
  const joined: ControlProgramOutput[] = []
  for (const block of blocks) {
    const previous = joined.at(-1)
    if (block.type === "text" && previous?.type === "text")
      joined[joined.length - 1] = {
        type: "text",
        text: `${previous.text}\n${block.text}`,
      }
    else joined.push(block)
  }
  return joined
}

import { controlFaultData, type ControlFaultData } from "@mako/control/control"
import {
  ControlProgramError,
  programErrorText,
  type ControlCellReport,
  type ControlEffect,
  type ControlProgramOutput,
} from "@mako/control/program"
import type { JsonObject, JsonValue } from "./json.js"
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

/**
 * The `_meta` key of a js result's report, for programs that grade or audit
 * a task. Agent clients keep `_meta` from the model, so the report costs no
 * tokens; `structuredContent` would replace or repeat the printed text.
 */
export const JS_REPORT_META = "dev.mako/js"

export type JsReport =
  | ({ status: "completed" } & ControlCellReport)
  | {
      status: "failed"
      /** `code` and `outcome` are absent for a plain script error. */
      error: {
        message: string
        code?: string
        outcome?: ControlFaultData["outcome"]
      }
      effects: ControlEffect[]
    }

export function failedJsReport(error: Error): JsReport {
  const cause = error instanceof ControlProgramError ? error.cause : error
  const fault = controlFaultData(cause)
  return {
    status: "failed",
    error: {
      message: cause.message,
      ...(fault && { code: fault.code, outcome: fault.outcome }),
    },
    effects: error instanceof ControlProgramError ? [...error.effects] : [],
  }
}

function reportMeta(report: JsReport): JsonObject {
  return { [JS_REPORT_META]: report }
}

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
    let report: ControlCellReport = { effects: [] }
    try {
      const content = await session.execute(
        { source: operation.code },
        signal,
        {
          yield: false,
          mode: "repl",
          timeoutMs: operation.timeout_ms,
          report: (cell) => {
            report = cell
          },
        }
      )
      return {
        content: content.length
          ? joinText(content)
          : [{ type: "text", text: "Completed; no value emitted." }],
        _meta: reportMeta({ status: "completed", ...report }),
      }
    } catch (error) {
      return {
        isError: true,
        content: joinText([
          ...(error instanceof ControlProgramError ? error.output : []),
          { type: "text", text: programErrorText(error) },
        ]),
        _meta: reportMeta(
          failedJsReport(
            error instanceof Error ? error : new Error(String(error))
          )
        ),
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

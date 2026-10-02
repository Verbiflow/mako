import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { programErrorText } from "@mako/control/program"
import { ControlJsInputSchema } from "./control-session-protocol.js"
import { controlJsDescription } from "./control-agent-docs.js"

const resultSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({
        type: z.literal("image"),
        data: z.string(),
        mimeType: z.string(),
      }),
    ])
  ),
  _meta: z.record(z.string(), z.json()).optional(),
})
import {
  JS_REPORT_META,
  failedJsReport,
  type ControlAgentRequest,
  type ControlAgentOperation,
} from "./control-agent.js"
export {
  controlAgent,
  JS_REPORT_META,
  type ControlAgentRequest,
  type ControlAgentOperation,
  type JsReport,
} from "./control-agent.js"

/** Transport adapter only. Borrows the owner's existing session through a typed
 * function or private socket client. Closing MCP never closes that session. */
export function createControlMcpServer(
  request: ControlAgentRequest
): McpServer {
  const server = new McpServer({ name: "mako-computer", version: "1.0.0" })
  const invoke = async (
    operation: ControlAgentOperation,
    signal: AbortSignal
  ) => {
    try {
      return resultSchema.parse(await request(operation, signal))
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: programErrorText(error) }],
        ...(operation.method === "js" && {
          _meta: {
            [JS_REPORT_META]: failedJsReport(
              error instanceof Error ? error : new Error(String(error))
            ),
          },
        }),
      }
    }
  }
  server.registerTool(
    "js",
    {
      description: controlJsDescription,
      inputSchema: ControlJsInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (input, extra) => invoke({ method: "js", ...input }, extra.signal)
  )
  server.registerTool(
    "js_reset",
    {
      description:
        "Clear persistent JavaScript bindings and shared CLI program state. Does not close apps, browser tabs, leases or recordings. Wait for any running call to finish first. The next js call returns documentation again. Use control.rewriteDocumentation() when only documentation was lost.",
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (_input, extra) => invoke({ method: "js-reset" }, extra.signal)
  )
  return server
}

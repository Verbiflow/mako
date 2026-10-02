import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import { readOptionalServerEnv } from "../../config/env"
import { backendStatus } from "../../status"
import { yamlResult } from "../result"

export function registerStatusTool(server: McpServer): void {
  server.registerTool(
    "mako_server_status",
    {
      title: "Mako server status",
      description:
        "Read Mako backend health, protocol, deployment, and connector readiness without returning credentials.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () => yamlResult(backendStatus(readOptionalServerEnv()))
  )
}

import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import { readOptionalServerEnv } from "../../config/env"
import { integrationCatalog } from "../../integrations/catalog"
import { yamlResult } from "../result"

export function registerIntegrationsTool(server: McpServer): void {
  server.registerTool(
    "mako_list_integrations",
    {
      title: "List Mako integrations",
      description:
        "List Mako's available backend integrations, capabilities, and connection state without exposing connector credentials.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () => {
      const environment = readOptionalServerEnv()
      return yamlResult(
        integrationCatalog({
          slackConnected: Boolean(environment.SLACK_CONNECTOR),
        })
      )
    }
  )
}

import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import { listSkills, readSkill } from "../../skills/catalog"
import { textResult, yamlResult } from "../result"

export function registerSkillTools(server: McpServer): void {
  server.registerTool(
    "mako_list_skills",
    {
      title: "List Mako skills",
      description:
        "List Mako backend skills with stable identifiers, routing descriptions, and MCP resource URIs.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () => yamlResult(listSkills())
  )
  server.registerTool(
    "mako_read_skill",
    {
      title: "Read a Mako skill",
      description:
        "Read the complete trusted instructions for one Mako backend skill.",
      inputSchema: z.object({
        id: z.literal("mako-operations"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => textResult(await readSkill(id))
  )
}

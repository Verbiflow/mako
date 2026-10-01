import { z } from "zod"
import type { ProviderAcpSource } from "../acp-source.js"

const GrokTool = z.object({ "x.ai/tool": z.object({ name: z.string().trim().min(1).max(512) }) })

/**
 * Grok names its own tools in `_meta["x.ai/tool"].name` (`run_terminal_command`,
 * `use_tool`). Its server-side web search carries no name, only the title
 * `Web search: <query>`.
 */
export const grokToolName: NonNullable<ProviderAcpSource["toolName"]> = (tool) => {
  const parsed = GrokTool.safeParse(tool._meta)
  if (parsed.success) return parsed.data["x.ai/tool"].name
  return /^web search\b/i.test(tool.title) ? "web_search" : undefined
}

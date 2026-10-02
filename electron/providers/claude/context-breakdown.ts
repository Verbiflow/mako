import type { SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk"
import type { ContextBreakdown } from "../../contracts/providers-acp.js"

/** Items under this many tokens add rows without telling anyone where the context went. */
const SMALL_ITEM = 200
const ITEMS_PER_GROUP = 6

/**
 * Claude's `/context` data as the desk's breakdown: the categories it
 * itemizes, and the biggest MCP servers, memory files, agents and skills
 * inside them. Rows are classified by `kind`, never by their English names.
 */
export function claudeContextBreakdown(usage: SDKControlGetContextUsageResponse): ContextBreakdown {
  const servers = new Map<string, number>()
  for (const tool of usage.mcpTools) if (tool.isLoaded !== false) servers.set(tool.serverName, (servers.get(tool.serverName) ?? 0) + tool.tokens)
  const items: ContextBreakdown["items"] = [
    ...largest([...servers].map(([name, tokens]) => ({ group: "mcp" as const, name, tokens }))),
    ...largest(usage.memoryFiles.map((file) => ({ group: "memory" as const, name: file.path, tokens: file.tokens }))),
    ...largest(usage.agents.map((agent) => ({ group: "agents" as const, name: agent.agentType, tokens: agent.tokens }))),
    ...largest((usage.skills?.skillFrontmatter ?? []).map((skill) => ({ group: "skills" as const, name: skill.name, tokens: skill.tokens }))),
  ]
  return {
    used: usage.totalTokens,
    size: usage.rawMaxTokens || usage.maxTokens,
    categories: usage.categories
      .filter((category) => category.tokens > 0)
      .map((category) => ({ name: category.name, tokens: category.tokens, kind: category.kind })),
    items,
  }
}

function largest<T extends { tokens: number }>(items: T[]): T[] {
  return items.filter((item) => item.tokens >= SMALL_ITEM).sort((a, b) => b.tokens - a.tokens).slice(0, ITEMS_PER_GROUP)
}

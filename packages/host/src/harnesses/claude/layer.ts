import type { McpHttpServerConfig } from "@anthropic-ai/claude-agent-sdk"
import { instructionText, replacement, type LayerAdapter } from "../../contracts/mako-layer.js"
import { MAKO_TOOL_TIMEOUT_MS } from "../../tools/index.js"
import { bearerServers } from "../mako-layer.js"

export interface ClaudeLayerFragment {
  /** Appended to the `claude_code` preset, which Claude Code keeps out of its transcript. */
  append?: string
  /** Mako's servers, beside the person's own. */
  servers: Record<string, McpHttpServerConfig>
  /** `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` for the teams the person asked for: never in an Apex, whose team is its Fins. */
  agentTeams(requested: boolean | undefined): "1" | "0" | undefined
}

export const claudeLayer: LayerAdapter<ClaudeLayerFragment> = {
  harness: "claude",
  capabilities: {
    instructions: { kind: "native", via: "system-append", how: "`systemPrompt.append` on the `claude_code` preset", inUse: true },
    toolServing: { kind: "native", via: "http-mcp", how: "`mcpServers` of type http with the grant as a bearer header. The driver serves `mako` in-process when the grant has that server; `mako-computer` stays HTTP", inUse: true },
    removal: { kind: "native", via: "tool-list", how: "`disallowedTools` and `tools` on the query; today only agent teams are taken out, by environment", inUse: false },
    interception: { kind: "native", via: "pre-tool-hook", how: "the `PreToolUse` callback, which denies a routed spawn or native call with a message naming Mako's tool", inUse: true },
    subagents: { kind: "native", via: "declared", how: "the query's `agents` definitions: a `fin` agent whose only tool is `agents_start`", inUse: true },
    hooks: { kind: "native", via: "sdk-hooks", how: "SDK hooks for transcript, compaction, attribution and routing", inUse: true },
    personSetup: "kept",
  },
  apply(layer) {
    const servers: Record<string, McpHttpServerConfig> = {}
    for (const { name, url, authorization } of bearerServers(layer))
      servers[name] = { type: "http", url, headers: { Authorization: authorization }, timeout: MAKO_TOOL_TIMEOUT_MS }
    const teamsOut = replacement(layer, "agent-team") === "remove"
    return {
      ...instructionText(layer) !== undefined && { append: instructionText(layer) },
      servers,
      agentTeams: (requested) => requested === undefined ? undefined : requested && !teamsOut ? "1" : "0",
    }
  },
}

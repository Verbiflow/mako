import { homedir } from "node:os"
import { join } from "node:path"
import type { ProviderMcpSource } from "../mcp-source.js"

export const claudeMcpSource: ProviderMcpSource = {
  provider: "claude",
  readFormat: "named-map",
  command: () => "claude",
  userFiles: (account) => [
    account.dir ? join(account.dir, ".claude.json") : join(homedir(), ".claude.json"),
  ],
  workspaceFiles: (cwd) => [join(cwd, ".mcp.json")],
  cliList: null,
  // Mako's own servers are given MAKO_TOOL_TIMEOUT_MS in sdk-options.ts; without it Claude Code ends a call after 60 seconds.
  callWaitMs: 10 * 60_000,
  write: { kind: "file", format: { root: "mcpServers", command: "string", remote: "transport" } },
}

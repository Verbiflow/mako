import { homedir } from "node:os"
import { join } from "node:path"
import type { ProviderMcpSource } from "../mcp-source.js"

export const cursorMcpSource: ProviderMcpSource = {
  provider: "cursor",
  readFormat: "named-map",
  command: () => "cursor-agent",
  userFiles: () => [join(homedir(), ".cursor", "mcp.json")],
  workspaceFiles: (cwd) => [join(cwd, ".cursor", "mcp.json")],
  cliList: null,
  write: { kind: "file", format: { root: "mcpServers", command: "string", remote: "implicit" } },
}

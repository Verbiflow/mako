import {
  scopedMcpWriteArgs,
  type ProviderMcpSource,
} from "../mcp-source.js"

export const grokMcpSource: ProviderMcpSource = {
  provider: "grok",
  readFormat: "named-map-or-list",
  command: () => "grok",
  userFiles: () => [],
  workspaceFiles: () => [],
  readsCli: true,
  write: { kind: "cli", scopes: "both", args: scopedMcpWriteArgs },
}

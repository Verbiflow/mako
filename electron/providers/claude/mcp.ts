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
  readsCli: false,
  write: { kind: "file", format: "claude" },
}

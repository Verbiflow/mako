import { homedir } from "node:os"
import { join } from "node:path"
import {
  scopedMcpWriteArgs,
  type ProviderMcpSource,
} from "../mcp-source.js"
import { devinExecutable } from "./executable.js"

export const devinMcpSource: ProviderMcpSource = {
  provider: "devin",
  readFormat: "named-map",
  command: () => devinExecutable(),
  userFiles: () => [
    join(homedir(), ".config", "devin", "mcp_config.json"),
    join(homedir(), ".config", "devin", "mcp.json"),
    join(homedir(), ".devin", "mcp.json"),
  ],
  workspaceFiles: (cwd) => [
    join(cwd, ".devin", "mcp_config.local.json"),
    join(cwd, ".devin", "mcp_config.json"),
  ],
  readsCli: false,
  write: { kind: "cli", scopes: "both", args: scopedMcpWriteArgs },
}

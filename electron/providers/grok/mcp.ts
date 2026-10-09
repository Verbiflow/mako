import { join } from "node:path"
import { grokHome } from "@mako/sessions"
import {
  inEveryAncestor,
  scopedMcpWriteArgs,
  type ProviderMcpSource,
} from "../mcp-source.js"

export const grokMcpSource: ProviderMcpSource = {
  provider: "grok",
  readFormat: "named-map-or-list",
  command: () => "grok",
  userFiles: () => [],
  workspaceFiles: () => [],
  cliList: {
    inputs: (env, cwd) => [join(grokHome(env), "config.toml"), ...inEveryAncestor(cwd, ".grok/config.toml")],
  },
  write: { kind: "cli", scopes: "both", args: scopedMcpWriteArgs },
}

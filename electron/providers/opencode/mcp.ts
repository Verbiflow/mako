import { homedir } from "node:os"
import { join } from "node:path"
import type { ProviderMcpSource } from "@mako/host/tools"
import { openCodeExecutable } from "./installation.js"

export const openCodeMcpSource: ProviderMcpSource = {
  provider: "opencode",
  readFormat: "command-array-map",
  command: () => openCodeExecutable(),
  userFiles: () => [
    join(homedir(), ".config", "opencode", "opencode.json"),
  ],
  workspaceFiles: (cwd) => [
    join(cwd, "opencode.json"),
    join(cwd, ".opencode", "opencode.json"),
  ],
  cliList: null,
  write: { kind: "none" },
}

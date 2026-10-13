import { homedir } from "node:os"
import { join } from "node:path"
import type { ProviderMcpSource } from "../../tools/index.js"
import { openCodeExecutable } from "./installation.js"

/** OpenCode's config folder: `OPENCODE_CONFIG_DIR`, or `opencode` in the XDG config folder. */
function configDir(env: NodeJS.ProcessEnv): string {
  return env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
}

/**
 * OpenCode 2 keeps servers under `mcp.servers` in `opencode.json` or
 * `opencode.jsonc`, both JSON with comments; 1.x's `mcp.<name>` still
 * reads. A sync writes the 2.x form into whichever of the files exists,
 * editing it in place so its comments stay.
 */
export const openCodeMcpSource: ProviderMcpSource = {
  provider: "opencode",
  readFormat: "command-array-map",
  command: () => openCodeExecutable(),
  userFiles: () => [join(configDir(process.env), "opencode.json"), join(configDir(process.env), "opencode.jsonc")],
  workspaceFiles: (cwd) => [
    join(cwd, "opencode.json"),
    join(cwd, "opencode.jsonc"),
    join(cwd, ".opencode", "opencode.json"),
    join(cwd, ".opencode", "opencode.jsonc"),
  ],
  cliList: null,
  write: { kind: "file", format: { root: ["mcp", "servers"], command: "array", remote: "remote" } },
}

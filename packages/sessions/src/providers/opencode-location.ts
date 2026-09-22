import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

/** Native OpenCode database locations, shared by catalog and runtime adapters. */
export function openCodeDatabasePaths(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): string[] {
  const root = join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode")
  if (env.OPENCODE_DB) {
    if (env.OPENCODE_DB === ":memory:") return []
    return [isAbsolute(env.OPENCODE_DB) ? env.OPENCODE_DB : join(root, env.OPENCODE_DB)]
  }
  return [join(root, "opencode.db"), join(root, "opencode-next.db")]
}

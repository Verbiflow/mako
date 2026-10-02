import { accessSync, constants } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { resolveExecutable } from "./executable.js"

/**
 * The stdio MCP servers whose command exists nowhere a launcher could find
 * it, for a harness that reports nothing about its servers (Cursor's SDK).
 * Nothing is spawned. The search is wider than PATH, so it can miss a
 * server that will fail but never names one that would have launched.
 */
export function unlaunchableMcpServers(
  servers: Iterable<{ name: string; command?: string; env?: Record<string, string> }>,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const missing: string[] = []
  for (const { name, command, env: own } of servers) {
    if (!command) continue
    if (command.includes("/") && !isAbsolute(command)) {
      try {
        accessSync(resolve(cwd, command), constants.X_OK)
      } catch {
        missing.push(name)
      }
      continue
    }
    if (!resolveExecutable(command, own?.PATH ? { ...env, PATH: own.PATH } : env)) missing.push(name)
  }
  return missing
}

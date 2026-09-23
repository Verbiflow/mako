import { accessSync, constants } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"

/** Runtime tools use explicit PATH; never inspect a developer's agent installs. */
export function resolveExecutable(command: string): string | undefined {
  const candidates = isAbsolute(command) ? [command]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(path => join(path, command))
  return candidates.find(path => {
    try { accessSync(path, constants.X_OK); return true } catch { return false }
  })
}

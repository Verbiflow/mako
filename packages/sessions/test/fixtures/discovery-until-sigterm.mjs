import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"

/**
 * Preloaded into a sync daemon (`node --import`): its discovery's listing of Codex rollouts stays out until the
 * process is sent SIGTERM, and comes back a turn after the daemon's own stop began, so a stop always lands while
 * discovery is pending and discovery resolves while the stopping catalog awaits it.
 */
const readdir = fs.readdir
let release
const signalled = new Promise((resolve) => { release = resolve })
process.once("SIGTERM", () => setImmediate(release))
fs.readdir = async (path, ...rest) => {
  if (String(path).includes("/.codex/sessions")) await signalled
  return readdir(path, ...rest)
}
syncBuiltinESMExports()

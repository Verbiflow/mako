import { existsSync } from "node:fs"

const IONICE = ["/usr/bin/ionice", "/bin/ionice"].find((path) => existsSync(path))

/**
 * A command that yields to the agents already running. macOS: Darwin's
 * background band (`PRIO_DARWIN_BG`), which throttles its CPU and disk and
 * holds it to efficiency cores. Linux: the lowest CPU priority and the
 * lowest best-effort I/O class; not idle class, which a busy disk can starve
 * indefinitely. Children inherit it, so it covers what Git starts.
 */
export function belowAgents(command: string, args: readonly string[]): [string, string[]] {
  if (process.platform === "darwin") return ["/usr/sbin/taskpolicy", ["-b", command, ...args]]
  if (process.platform === "linux")
    return IONICE ? ["nice", ["-n", "19", IONICE, "-c", "2", "-n", "7", command, ...args]] : ["nice", ["-n", "19", command, ...args]]
  return [command, [...args]]
}

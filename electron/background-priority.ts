import { existsSync } from "node:fs"

const IONICE = ["/usr/bin/ionice", "/bin/ionice"].find((path) => existsSync(path))

/**
 * A command that yields CPU to the agents already running, at the lowest
 * priority; on Linux also the lowest best-effort I/O class. Children inherit
 * it, so it covers what Git starts. Not Darwin's background band
 * (`taskpolicy -b`) or Linux's idle I/O class, which a busy machine can
 * starve: with every core busy, the band took a 50,000-file checkout from
 * 3.4 s to 127–142 s, and an agent's own `git status` came out no faster
 * than under `nice`.
 */
export function belowAgents(command: string, args: readonly string[]): [string, string[]] {
  if (process.platform === "darwin") return ["/usr/bin/nice", ["-n", "19", command, ...args]]
  if (process.platform === "linux")
    return IONICE ? ["nice", ["-n", "19", IONICE, "-c", "2", "-n", "7", command, ...args]] : ["nice", ["-n", "19", command, ...args]]
  return [command, [...args]]
}

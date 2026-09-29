import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process"
import { statSync } from "node:fs"
import { trackProviderChild } from "../provider-children.js"

/**
 * A provider was asked to start in a folder that is gone. Node reports that
 * spawn as ENOENT against the executable, which read as "Claude Code is not
 * installed" for a binary that was there, every two minutes, for a
 * worktree an e2e test had deleted.
 */
export class MissingWorkingDirectoryError extends Error {
  readonly cwd: string

  constructor(cwd: string) {
    super(`The folder ${cwd} no longer exists. Open this in a folder that exists.`)
    this.name = "MissingWorkingDirectoryError"
    this.cwd = cwd
  }
}

export function workingDirectoryExists(cwd: string): boolean {
  return statSync(cwd, { throwIfNoEntry: false })?.isDirectory() ?? false
}

export type ProviderSpawnOptions = Omit<SpawnOptions, "stdio" | "cwd"> & { cwd?: string }

/**
 * Starts a provider's process: the harness CLI, app-server, SDK child or
 * discovery probe. Every harness launches through here, so a missing folder
 * fails the same way for each of them, naming the folder, and a long-lived
 * process is recorded for reaping from the moment it exists.
 */
export function spawnProviderProcess(
  command: string,
  args: readonly string[],
  options: ProviderSpawnOptions,
  tracked?: { kind: string; owner: string }
): ChildProcessWithoutNullStreams {
  if (options.cwd !== undefined && !workingDirectoryExists(options.cwd))
    throw new MissingWorkingDirectoryError(options.cwd)
  const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] })
  if (tracked) trackProviderChild(child, tracked)
  return child
}

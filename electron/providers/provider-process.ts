import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process"
import { statSync } from "node:fs"
import { basename } from "node:path"
import { hostWarn } from "../host-log.js"
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
 * fails the same way for each of them, naming the folder, a long-lived
 * process is recorded for reaping from the moment it exists, and its pipes
 * close soon after it exits.
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
  releasePipesAfterExit(child, tracked?.kind ?? basename(command))
  return child
}

/**
 * A process the provider started can inherit its pipes and outlive it; then
 * they never close, and whatever reads them (an SDK's message stream, a Close
 * waiting for the process) waits forever. After a grace for the dead
 * process's last output, Mako closes its own ends, which also ends any stdio
 * server still attached to them.
 */
function releasePipesAfterExit(child: ChildProcess, label: string): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  child.once("close", () => clearTimeout(timer))
  child.once("exit", () => {
    timer = setTimeout(() => {
      hostWarn("provider", "a process the provider started still held its pipes after it exited; closing them", { process: label, pid: child.pid ?? "" })
      child.stdin?.destroy()
      child.stdout?.destroy()
      child.stderr?.destroy()
    }, PIPE_DRAIN_GRACE_MS)
    timer.unref?.()
  })
}

const PIPE_DRAIN_GRACE_MS = 1_000

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process"
import { statSync } from "node:fs"
import { basename } from "node:path"
import { hostLog, hostWarn } from "../host-log.js"
import { trackProviderPid, untrackProviderPid } from "../provider-children.js"

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
 * process is recorded for reaping from the moment it exists, and what it
 * leaves behind when it exits (its pipes, its process group) is ended.
 */
export function spawnProviderProcess(
  command: string,
  args: readonly string[],
  options: ProviderSpawnOptions,
  tracked?: { kind: string; owner: string }
): ChildProcessWithoutNullStreams {
  if (options.cwd !== undefined && !workingDirectoryExists(options.cwd))
    throw new MissingWorkingDirectoryError(options.cwd)
  const group = process.platform !== "win32"
  const child = spawn(command, args, { detached: group, ...options, stdio: ["pipe", "pipe", "pipe"] })
  const pid = child.pid
  if (tracked && pid) trackProviderPid({ pid, executable: child.spawnfile, ...tracked })
  const label = tracked?.kind ?? basename(command)
  const releasePipes = pipeRelease(child, label)
  // One exit listener for all of Mako's cleanup: an SDK that owns the
  // process adds its own (Claude's adds seven), and past ten Node reports a
  // leak that would hide a real one.
  child.once("exit", () => {
    if (tracked && pid) untrackProviderPid(pid)
    releasePipes()
    if (group && pid) endGroup(pid, label)
  })
  return child
}

/**
 * A provider's own children outlive it when it dies: the native binary under
 * an npm wrapper, a tool's shell, an MCP server. Nothing reads them any more,
 * and one still writing the session keeps Mako from reopening it. They share
 * the provider's process group, which ends with it.
 */
function endGroup(pid: number, label: string): void {
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    return
  }
  hostLog("provider", "ending what a provider left running when it exited", { process: label, pid })
  setTimeout(() => {
    try { process.kill(-pid, "SIGKILL") } catch { return }
  }, GROUP_END_GRACE_MS).unref()
}

/**
 * A process the provider started can inherit its pipes and outlive it; then
 * they never close, and whatever reads them (an SDK's message stream, a Close
 * waiting for the process) waits forever. After a grace for the dead
 * process's last output, Mako closes its own ends, which also ends any stdio
 * server still attached to them. Returns what to run when the process exits.
 */
function pipeRelease(child: ChildProcess, label: string): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  child.once("close", () => clearTimeout(timer))
  return () => {
    timer = setTimeout(() => {
      hostWarn("provider", "a process the provider started still held its pipes after it exited; closing them", { process: label, pid: child.pid ?? "" })
      child.stdin?.destroy()
      child.stdout?.destroy()
      child.stderr?.destroy()
    }, PIPE_DRAIN_GRACE_MS)
    timer.unref?.()
  }
}

const PIPE_DRAIN_GRACE_MS = 1_000
const GROUP_END_GRACE_MS = 2_000

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process"
import { statSync } from "node:fs"
import { basename } from "node:path"
import { hostLog, hostWarn } from "../base/host-log.js"
import { trackProviderPid, untrackProviderPid } from "../base/provider-children.js"
import { onWindows } from "../base/platform.js"
import { endChildInput } from "@mako/sessions/child-input"

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
  tracked?: { kind: string; owner: string; session?: string | null }
): ChildProcessWithoutNullStreams {
  if (options.cwd !== undefined && !workingDirectoryExists(options.cwd))
    throw new MissingWorkingDirectoryError(options.cwd)
  const group = !onWindows()
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

/** Whether the process has exited as far as Node has seen, or never started; until then it is this one's unreaped child. */
export function providerProcessGone(child: ChildProcess): boolean {
  return child.pid === undefined || child.exitCode !== null || child.signalCode !== null
}

/** How ending a provider process came out: Node saw it exit, or it was still there a grace after SIGKILL and may still write. */
export type ProviderProcessEnd = "exited" | "outlived"

/** A close that couldn't prove its process gone. Whoever holds the process's place keeps it, and a later close tries again. */
export class ProviderProcessOutlivedError extends Error {
  readonly pid: number | undefined

  constructor(pid: number | undefined) {
    super(`A provider process${pid ? ` (pid ${pid})` : ""} is still running after Mako tried to end it.`)
    this.name = "ProviderProcessOutlivedError"
    this.pid = pid
  }
}

const ending = new WeakMap<ChildProcess, Promise<ProviderProcessEnd>>()

/**
 * Ends a provider process this host spawned, and says how that came out: `first` asks it to go (its input closed, or
 * SIGTERM), then SIGTERM if it hasn't, then SIGKILL, a grace apart; a process still there a grace after SIGKILL is
 * warned of and no longer waited for, which is `outlived`, not `exited`. Every signal goes through the process's own
 * handle and only before Node has seen it exit, while it is this process's unreaped child and its pid can't be
 * another's. A second call joins the first while it runs; one after `outlived` starts over. Never rejects, so it can
 * run in the background; what holds a place on this process uses `closeProviderProcess`.
 */
export function endProviderProcess(child: ChildProcess, first: "input" | "SIGTERM" = "SIGTERM", graceMs = END_GRACE_MS): Promise<ProviderProcessEnd> {
  const already = ending.get(child)
  if (already) return already
  const ended = new Promise<ProviderProcessEnd>((resolve) => {
    if (providerProcessGone(child)) return resolve("exited")
    const timers: ReturnType<typeof setTimeout>[] = []
    const done = (end: ProviderProcessEnd) => {
      for (const timer of timers) clearTimeout(timer)
      child.off("exit", exited)
      child.off("error", failed)
      resolve(end)
    }
    const exited = () => done("exited")
    const failed = () => { if (providerProcessGone(child)) done("exited") }
    child.once("exit", exited)
    child.on("error", failed)
    const signal = (name: NodeJS.Signals) => {
      if (!providerProcessGone(child)) child.kill(name)
    }
    if (first === "input") endChildInput(child)
    else signal("SIGTERM")
    const harder: NodeJS.Signals[] = first === "input" ? ["SIGTERM", "SIGKILL"] : ["SIGKILL"]
    harder.forEach((name, step) => timers.push(setTimeout(() => signal(name), graceMs * (step + 1))))
    timers.push(setTimeout(() => {
      hostWarn("provider", "a provider process outlived SIGKILL; no longer waiting for it", { pid: child.pid ?? "" })
      ending.delete(child)
      done("outlived")
    }, graceMs * (harder.length + 1)))
  })
  ending.set(child, ended)
  return ended
}

/** `endProviderProcess` for what holds a place on the process: resolves only once it's gone, and rejects when it can't say so. */
export async function closeProviderProcess(child: ChildProcess, first: "input" | "SIGTERM" = "SIGTERM", graceMs = END_GRACE_MS): Promise<void> {
  if (await endProviderProcess(child, first, graceMs) === "outlived") throw new ProviderProcessOutlivedError(child.pid)
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
/** How long a provider gets to end at each request before the next, harder one. */
const END_GRACE_MS = 2_000

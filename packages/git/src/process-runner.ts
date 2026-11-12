import { execFile, spawn, fork, type ChildProcess, type SpawnOptions, type ForkOptions } from "node:child_process"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { onWindows } from "./platform.js"

/** Ownership operations injected by a host, or used directly by standalone Git. */
export interface ProcessRunner {
  spawn: typeof spawn
  fork: typeof fork
  close(child: ChildProcess, first?: NodeJS.Signals | number): Promise<void>
  finished(child: ChildProcess): Promise<void>
  /** Providers end leftover helpers with their leader; ordinary streams may still be producing final output. */
  endWithParent(child: ChildProcess): void
}

/** Cleanup helpers cannot join the scope they are reaping. */
const inspect = promisify(execFile)
const endings = new WeakMap<ChildProcess, Promise<void>>()
const lifetimes = new WeakMap<ChildProcess, { close: ProcessRunner["close"]; finished: Promise<void>; endWithParent: () => void }>()
const isArgs = (value: readonly string[] | SpawnOptions | ForkOptions | undefined): value is readonly string[] => Array.isArray(value)

// SAFETY: spawn's stdio overloads pass through unchanged; every child gets an isolated process group.
const spawnOwned = ((file: string, args?: readonly string[] | SpawnOptions, options?: SpawnOptions) => {
  const child = spawn(file, isArgs(args) ? args : [], { ...(isArgs(args) || args === undefined ? options : args), detached: !onWindows() })
  ownChild(child)
  return child
}) as typeof spawn

// SAFETY: fork's args/options and IPC overloads pass through unchanged; every child gets an isolated process group.
const forkOwned = ((file: string | URL, args?: readonly string[] | ForkOptions, options?: ForkOptions) => {
  const child = fork(file, isArgs(args) ? args : [], { ...(isArgs(args) || args === undefined ? options : args), detached: !onWindows() })
  ownChild(child)
  return child
}) as typeof fork

export const processRunner: ProcessRunner = {
  spawn: spawnOwned,
  fork: forkOwned,
  close: (child, first) => {
    const lifetime = lifetimes.get(child)
    return lifetime ? lifetime.close(child, first) : Promise.reject(new Error("The process runner does not own this child"))
  },
  finished: (child) => lifetimes.get(child)?.finished ?? Promise.reject(new Error("The process runner does not own this child")),
  endWithParent: (child) => {
    const lifetime = lifetimes.get(child)
    if (!lifetime) throw new Error("The process runner does not own this child")
    lifetime.endWithParent()
  },
}

/** Retain ownership through natural output drain; an explicit close always starts group cleanup immediately. */
function ownChild(child: ChildProcess): void {
  let endWithParent = false
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
  const cleanup: ProcessRunner["close"] = async (_child, first) => {
    let ending = endings.get(child)
    if (!ending) { ending = stopGroup(child, first ?? "SIGTERM"); endings.set(child, ending) }
    await ending
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([closed, new Promise<void>((resolve) => { timer = setTimeout(resolve, 100) })]) }
    finally { clearTimeout(timer) }
    child.stdin?.destroy()
    child.stdout?.destroy()
    child.stderr?.destroy()
    await closed
  }
  const finished = new Promise<void>((resolve, reject) => {
    const end = () => { void cleanup(child).then(resolve, reject) }
    child.once("exit", () => {
      if (endWithParent) end()
      else void closed.then(() => cleanup(child)).then(resolve, reject)
    })
    child.once("error", (error) => { if (!child.pid || error.name === "AbortError") end() })
  })
  void finished.catch(() => {})
  lifetimes.set(child, { close: cleanup, finished, endWithParent: () => { endWithParent = true } })
}

async function stopGroup(child: ChildProcess, first: NodeJS.Signals | number): Promise<void> {
  const pid = child.pid
  if (!pid) return
  if (onWindows()) {
    if (child.exitCode === null && child.signalCode === null)
      await inspect("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 5_000 })
    return
  }
  let denied: Error | undefined
  const signal = (name: NodeJS.Signals | number) => {
    try { process.kill(-pid, name); return true }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
      if (error instanceof Error && "code" in error && error.code === "EPERM") { denied = error; return true }
      throw error
    }
  }
  if (!signal(first)) return
  const began = Date.now()
  for (;;) {
    await delay(20)
    if (!signal(0)) return
    // macOS can answer EPERM for a group made only of zombies; the table settles that case.
    const { stdout } = await inspect("/bin/ps", ["-A", "-o", "pgid=,stat="], { timeout: 1_500, maxBuffer: 16 * 1024 * 1024 })
    const rows = stdout.split("\n").map((line) => line.trim().split(/\s+/)).filter(([group, state]) => Number(group) > 0 && state)
    if (!rows.length) throw new Error("The owned command's process group could not be checked")
    if (rows.every(([group, state]) => Number(group) !== pid || state?.startsWith("Z"))) return
    if (Date.now() - began >= 100) signal("SIGKILL")
    if (Date.now() - began >= 5_000) throw new Error(`Command process group ${pid} outlived SIGKILL`, { cause: denied })
  }
}

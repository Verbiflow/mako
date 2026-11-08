import { execFile, spawn, fork, type ChildProcess, type ExecFileException, type ExecFileOptions, type SpawnOptions, type ForkOptions } from "node:child_process"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { hostStopping } from "./host-stopping.js"
import { onWindows } from "./platform.js"

/** Process-table reads during cancellation cannot themselves join the stopping scope. */
const inspect = promisify(execFile)
const endings = new WeakMap<ChildProcess, Promise<void>>()
const cleanups = new WeakMap<ChildProcess, () => Promise<void>>()
type CommandResult = { stdout: string; stderr: string }

/** A buffered command, with its child handle, whose whole process group belongs to the host. */
export function hostCommand(file: string, args: readonly string[], options: Omit<ExecFileOptions, "encoding"> = {}) {
  let child!: ChildProcess
  const result = new Promise<CommandResult>((resolve, reject) => {
    child = hostExecFile(file, args, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }))
      else resolve({ stdout, stderr })
    })
  })
  return Object.assign(result, { child })
}

/** UTF-8 buffered output, preserving command failures and the original child handle. */
export function hostExecFile(file: string, args: readonly string[], options: Omit<ExecFileOptions, "encoding">, answer: (error: ExecFileException | null, stdout: string, stderr: string) => void): ChildProcess {
  const { timeout, maxBuffer = 1024 * 1024, killSignal = "SIGTERM", ...launch } = options
  const child = hostSpawn(file, args, { ...launch, stdio: ["pipe", "pipe", "pipe"] })
  const stdout: Buffer[] = [], stderr: Buffer[] = []
  let outBytes = 0, errBytes = 0, failure: ExecFileException | null = null, killed = false
  const stop = () => { killed = true; void endChild(child, killSignal).catch((error: Error) => { failure ??= error }) }
  const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
    const bytes = stream === "stdout" ? outBytes : errBytes
    const kept = chunk.subarray(0, Math.max(0, maxBuffer - bytes))
    if (stream === "stdout") { stdout.push(kept); outBytes += chunk.length }
    else { stderr.push(kept); errBytes += chunk.length }
    if (bytes + chunk.length > maxBuffer && !failure) {
      failure = Object.assign(new Error(`${stream} maxBuffer length exceeded`), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })
      stop()
    }
  }
  child.stdout?.on("data", (chunk: Buffer) => collect("stdout", chunk))
  child.stderr?.on("data", (chunk: Buffer) => collect("stderr", chunk))
  child.on("error", (error: Error) => { failure ??= error })
  const timer = timeout ? setTimeout(stop, timeout) : undefined
  child.once("close", (code, signal) => {
    clearTimeout(timer)
    const out = Buffer.concat(stdout).toString("utf8"), err = Buffer.concat(stderr).toString("utf8")
    if (code !== 0 || signal) failure ??= Object.assign(new Error(`Command failed: ${file} ${args.join(" ")}\n${err}`), { cmd: `${file} ${args.join(" ")}`, code: code ?? undefined, signal: signal ?? undefined, killed: killed || child.killed })
    void endChild(child).then(() => answer(failure, out, err), (error: Error) => answer(error, out, err))
  })
  return child
}

const isArgs = (value: readonly string[] | SpawnOptions | ForkOptions | undefined): value is readonly string[] => Array.isArray(value)

// SAFETY: spawn's overloads differ only in the child's stdio types; the arguments and stdio pass through unchanged, with an owned process group added.
const hostSpawn = ((file: string, args?: readonly string[] | SpawnOptions, options?: SpawnOptions) => {
  hostStopping()?.signal.throwIfAborted()
  const child = spawn(file, isArgs(args) ? args : [], { ...(isArgs(args) || args === undefined ? options : args), detached: !onWindows() })
  followHostChild(child, file)
  return child
}) as typeof spawn

// SAFETY: fork's overloads differ only in args/options; both pass through unchanged, with an owned process group added.
const hostFork = ((file: string | URL, args?: readonly string[] | ForkOptions, options?: ForkOptions) => {
  hostStopping()?.signal.throwIfAborted()
  const child = fork(file, isArgs(args) ? args : [], { ...(isArgs(args) || args === undefined ? options : args), detached: !onWindows() })
  followHostChild(child, String(file))
  return child
}) as typeof fork

export { hostSpawn, hostFork }

/** Register the group until cleanup, rather than treating the parent's closed pipes as proof its work ended. */
function followHostChild(child: ChildProcess, name: string): void {
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
  const cleanup = async () => {
    await endChild(child)
    await Promise.race([closed, delay(100)])
    child.stdin?.destroy()
    child.stdout?.destroy()
    child.stderr?.destroy()
    await closed
  }
  const unregister = hostStopping()?.register(`command ${name} (pid ${child.pid})`, cleanup)
  cleanups.set(child, cleanup)
  child.once("exit", () => { void cleanup().then(unregister, () => {}) })
  child.once("error", (error) => {
    if (!child.pid) unregister?.()
    else if (error.name === "AbortError") void cleanup().then(unregister, () => {})
  })
}

/** Join cleanup for a child created by these runners; never adopt another owner's process group. */
export function closeHostChild(child: ChildProcess): Promise<void> {
  const cleanup = cleanups.get(child)
  if (!cleanup) return Promise.reject(new Error("The child was not started through a host runner"))
  return cleanup()
}

/** Repeated stops join one group cleanup. Only an isolated group this runner created may be signalled. */
function endChild(child: ChildProcess, first: NodeJS.Signals | number = "SIGTERM"): Promise<void> {
  const known = endings.get(child)
  if (known) return known
  const ended = stopGroup(child, first)
  endings.set(child, ended)
  return ended
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

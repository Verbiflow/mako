import type { spawn, fork, ChildProcess, ExecFileException, ExecFileOptions } from "node:child_process"
import { processRunner } from "@mako/git/process-runner"
import { basename } from "node:path"
import { hostStopping, type ProbeOptions } from "./host-stopping.js"

/** Programs that only read the machine, which the host's probe child runs for it (`HostProbes`). */
const PROBES = new Set(["ps", "pgrep", "lsof", "sysctl", "footprint", "vm_stat", "pmset", "notifyutil"])

/** Whether `file args` is one of `PROBES`, itself or lowered with `nice -n <n>` (`belowAgents`). */
export function isProbe(file: string, args: readonly string[]): boolean {
  if (basename(file) === "nice" && args[0] === "-n" && args[2] !== undefined) return isProbe(args[2], args.slice(3))
  return PROBES.has(basename(file))
}

type CommandResult = { stdout: string; stderr: string }

/**
 * A probe that only reads the machine (`ps`, `lsof`, `sysctl`: `isProbe`), run in the host's probe child when it has
 * one (`HostProbes`), so its spawn never holds the host's loop, and here otherwise. It answers as `hostCommand` does.
 */
export function hostProbe(file: string, args: readonly string[], options: ProbeOptions = {}): Promise<CommandResult> {
  const probes = hostStopping()?.probes
  if (probes && isProbe(file, args)) return probes.run(file, args, options)
  return hostCommand(file, args, options)
}

/** A buffered command, with its child handle, whose whole process group belongs to the host. */
export function hostCommand(file: string, args: readonly string[], options: Omit<ExecFileOptions, "encoding"> = {}) {
  let answer!: (error: ExecFileException | null, stdout: string, stderr: string) => void
  const result = new Promise<CommandResult>((resolve, reject) => {
    answer = (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }))
      else resolve({ stdout, stderr })
    }
  })
  const child = hostExecFile(file, args, options, answer)
  return Object.assign(result, { child })
}

/** UTF-8 buffered output, preserving command failures and the original child handle. */
export function hostExecFile(file: string, args: readonly string[], options: Omit<ExecFileOptions, "encoding">, answer: (error: ExecFileException | null, stdout: string, stderr: string) => void): ChildProcess {
  const { timeout, maxBuffer = 1024 * 1024, killSignal = "SIGTERM", ...launch } = options
  const child = hostSpawn(file, args, { ...launch, stdio: ["pipe", "pipe", "pipe"] })
  const stdout: string[] = [], stderr: string[] = []
  let outBytes = 0, errBytes = 0, failure: ExecFileException | null = null, killed = false
  const stop = () => { killed = true; void processRunner.close(child, killSignal).catch((error: Error) => { failure ??= error }) }
  const collect = (stream: "stdout" | "stderr", chunk: string) => {
    const bytes = stream === "stdout" ? outBytes : errBytes
    const length = Buffer.byteLength(chunk)
    // execFile counts UTF-8 bytes but slices the decoded string by UTF-16 units
    // on overflow. Keep that behavior, including a split surrogate at the limit.
    const kept = bytes + length > maxBuffer ? chunk.slice(0, Math.max(0, maxBuffer - bytes)) : chunk
    if (stream === "stdout") { stdout.push(kept); outBytes += length }
    else { stderr.push(kept); errBytes += length }
    if (bytes + length > maxBuffer && !failure) {
      failure = Object.assign(new Error(`${stream} maxBuffer length exceeded`), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })
      child.stdout?.destroy()
      child.stderr?.destroy()
      stop()
    }
  }
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => collect("stdout", chunk))
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => collect("stderr", chunk))
  child.on("error", (error: Error) => { failure ??= error })
  const timer = timeout ? setTimeout(stop, timeout) : undefined
  child.once("close", (code, signal) => {
    clearTimeout(timer)
    const out = stdout.join(""), err = stderr.join("")
    if (code !== 0 || signal) failure ??= Object.assign(new Error(`Command failed: ${file} ${args.join(" ")}\n${err}`), { cmd: `${file} ${args.join(" ")}`, code: code ?? undefined, signal: signal ?? undefined, killed: killed || child.killed })
    void processRunner.close(child).then(() => answer(failure, out, err), (error: Error) => answer(error, out, err))
  })
  return child
}

// SAFETY: the underlying runner preserves Node's stdio overloads; this wrapper only registers ownership.
const hostSpawn = ((...args: Parameters<typeof spawn>) => {
  hostStopping()?.signal.throwIfAborted()
  const child = processRunner.spawn(...args)
  followHostChild(child, args[0])
  return child
}) as typeof spawn

// SAFETY: the underlying runner preserves Node's fork overloads; this wrapper only registers ownership.
const hostFork = ((...args: Parameters<typeof fork>) => {
  hostStopping()?.signal.throwIfAborted()
  const child = processRunner.fork(...args)
  followHostChild(child, String(args[0]))
  return child
}) as typeof fork

export { hostSpawn, hostFork }

function followHostChild(child: ChildProcess, name: string): void {
  const unregister = hostStopping()?.register(`command ${name} (pid ${child.pid})`, () => processRunner.close(child))
  void processRunner.finished(child).then(unregister, () => {})
}

/** Join cleanup without adopting another owner's process group. */
export const closeHostChild = (child: ChildProcess): Promise<void> => processRunner.close(child)

/** A provider's helpers retire with its leader rather than continuing a normal output stream. */
export const endHostChildWithParent = (child: ChildProcess): void => processRunner.endWithParent(child)

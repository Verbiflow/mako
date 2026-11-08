import { execFile, spawn, fork, type ChildProcess, type ExecFileException, type ExecFileOptions } from "node:child_process"
import { promisify } from "node:util"
import { hostStopping, stoppingSignal } from "./host-stopping.js"

const execute = promisify(execFile)

/** A command a host call waits for, registered with the same pre-drain cancellation as provider children and HTTP. */
export function hostCommand(file: string, args: readonly string[], options: Omit<ExecFileOptions, "encoding"> = {}) {
  const stopping = hostStopping()
  stopping?.signal.throwIfAborted()
  const result = execute(file, args, { ...options, encoding: "utf8", signal: stoppingSignal(options.signal) })
  followHostChild(result.child, file)
  return result
}

/** The callback form for readers that need a non-zero command's stdout and exit status too. */
export function hostExecFile(file: string, args: readonly string[], options: Omit<ExecFileOptions, "encoding">, answer: (error: ExecFileException | null, stdout: string, stderr: string) => void): ChildProcess {
  hostStopping()?.signal.throwIfAborted()
  const child = execFile(file, args, { ...options, encoding: "utf8", signal: stoppingSignal(options.signal) }, answer)
  followHostChild(child, file)
  return child
}

// SAFETY: spawn receives unchanged arguments and returns its original child, preserving every Node stdio overload.
const hostSpawn = ((...args: Parameters<typeof spawn>) => {
  hostStopping()?.signal.throwIfAborted()
  const child = spawn(...args)
  followHostChild(child, args[0])
  return child
}) as typeof spawn

// SAFETY: fork receives unchanged arguments and returns its original child, preserving every Node fork overload.
const hostFork = ((...args: Parameters<typeof fork>) => {
  hostStopping()?.signal.throwIfAborted()
  const child = fork(...args)
  followHostChild(child, String(args[0]))
  return child
}) as typeof fork

export { hostSpawn, hostFork }

/** Every host-owned child stays registered until its pipes close, including children that inherited those pipes. */
function followHostChild(child: ChildProcess, name: string): void {
  const stopping = hostStopping()
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
  const unregister = stopping?.register(`command ${name} (pid ${child.pid})`, async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
    const kill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      child.stdin?.destroy()
      child.stdout?.destroy()
      child.stderr?.destroy()
    }, 100)
    try { await closed } finally { clearTimeout(kill) }
  })
  void closed.then(() => unregister?.())
}

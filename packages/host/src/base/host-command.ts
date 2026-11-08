import { execFile, type ExecFileOptions } from "node:child_process"
import { promisify } from "node:util"
import { hostStopping, stoppingSignal } from "./host-stopping.js"

const execute = promisify(execFile)

/** A command a host call waits for, registered with the same pre-drain cancellation as provider children and HTTP. */
export function hostCommand(file: string, args: readonly string[], options: Omit<ExecFileOptions, "encoding"> = {}) {
  const stopping = hostStopping()
  stopping?.signal.throwIfAborted()
  const result = execute(file, args, { ...options, encoding: "utf8", signal: stoppingSignal(options.signal) })
  const child = result.child
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
  const unregister = stopping?.register(`command ${file} (pid ${child.pid})`, async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
    const kill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      // A command's subprocess may have inherited its pipes. No caller reads them after cancellation.
      child.stdin?.destroy()
      child.stdout?.destroy()
      child.stderr?.destroy()
    }, 100)
    try { await closed } finally { clearTimeout(kill) }
  })
  void closed.then(() => unregister?.())
  return result
}

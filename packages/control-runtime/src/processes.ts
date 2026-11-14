import { AsyncLocalStorage } from "node:async_hooks"
import { spawn as nodeSpawn, fork as nodeFork, execFile as nodeExecFile, type ChildProcess, type ExecFileException, type ExecFileOptions } from "node:child_process"
import { promisify } from "node:util"

type Options = Omit<ExecFileOptions, "encoding"> & { encoding?: "utf8" }
type Command = (file: string, args: readonly string[], options?: Options) => Promise<{ stdout: string; stderr: string }> & { child: ChildProcess }
export interface ControlProcesses { spawn: typeof nodeSpawn; fork: typeof nodeFork; command: Command }
const contexts = new AsyncLocalStorage<ControlProcesses>()
const nodeCommand = promisify(nodeExecFile)
/** CLI and worker defaults; an embedded host binds its own lifetime at its call boundary. */
const standalone: ControlProcesses = {
  spawn: nodeSpawn,
  fork: nodeFork,
  command: (file, args, options) => nodeCommand(file, args, { ...options, encoding: "utf8" }),
}

export function withControlProcesses<T>(runner: ControlProcesses, operation: () => T): T { return contexts.run(runner, operation) }
export const command: Command = (file, args, options) => (contexts.getStore() ?? standalone).command(file, args, options)

// SAFETY: all arguments and the original child pass through to the selected runner, preserving each stdio overload.
const spawn = ((...args: Parameters<typeof nodeSpawn>) => (contexts.getStore() ?? standalone).spawn(...args)) as typeof nodeSpawn
// SAFETY: all arguments and the original child pass through to the selected runner, preserving each IPC overload.
const fork = ((...args: Parameters<typeof nodeFork>) => (contexts.getStore() ?? standalone).fork(...args)) as typeof nodeFork
export { spawn, fork }

export function execFile(file: string, args: readonly string[], options: Options, answer: (error: ExecFileException | null, stdout: string, stderr: string) => void): ChildProcess {
  const result = command(file, args, options)
  void result.then(({ stdout, stderr }) => answer(null, stdout, stderr), (error: ExecFileException) => {
    const failure = error instanceof Error ? error : new Error(String(error))
    answer(failure, "stdout" in failure ? String(failure.stdout) : "", "stderr" in failure ? String(failure.stderr) : "")
  })
  return result.child
}

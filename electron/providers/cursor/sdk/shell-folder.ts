import type { ChildProcess } from "node:child_process"
import { createRequire, syncBuiltinESMExports } from "node:module"
import { homedir } from "node:os"
import { basename } from "node:path"
import { z } from "zod"
import { workingDirectoryExists } from "../../provider-process.js"

const SHELLS = new Set(["sh", "bash", "zsh"])

/**
 * Where the SDK's shell tool puts the command in its arguments, or nothing
 * for any other process. SDK 1.0.31 runs `zsh -c <wrapper> -- <command>` or
 * `bash -O extglob -c <wrapper> -- <command>`, behind `--policy … --` when
 * sandboxed; the wrapper evaluates the command and then records the folder
 * it ended in for the next command.
 */
export function shellCommandIndex(command: string, args: readonly string[]): number | undefined {
  let start = 0
  if (!SHELLS.has(basename(command))) {
    const separator = args.indexOf("--")
    if (separator < 0 || !SHELLS.has(basename(args[separator + 1] ?? ""))) return undefined
    start = separator + 2
  }
  const shell = args.slice(start)
  if (shell.length < 4 || shell.at(-2) !== "--") return undefined
  if (!shell.slice(0, -2).some((arg) => /^-[a-z]*c$/.test(arg))) return undefined
  return args.length - 1
}

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`

/** Said on stderr in place of the command, which fails so the wrapper records the new folder. */
export function movedShellCommand(deleted: string, now: string): string {
  const notice = `The shell's folder ${deleted} was deleted, so this command did not run. The shell is now in ${now}. Run the command again, starting with cd if it needs a particular folder.`
  return `builtin printf '%s\\n' ${quote(notice)} >&2; false`
}

/** `spawn(command, args, options)` with a folder; other call shapes are not shells the SDK starts. */
const ShellSpawnSchema = z.tuple([z.string(), z.array(z.string()), z.looseObject({ cwd: z.string() })]).rest(z.unknown())

/** `spawn` as the guard forwards it, whichever overload the caller used. */
type ForwardedSpawn = (...parameters: unknown[]) => ChildProcess

/**
 * The SDK's shell remembers the folder each command ended in and starts the
 * next one there. After `cd /tmp/x` and a later `rm -rf /tmp/x`, every later
 * shell call failed to spawn, `cd` or not; the first failure's orphaned
 * rejection ended the process and the turn with it. A shell whose folder is
 * gone starts in the workspace instead and runs a notice in place of its
 * command, so nothing runs somewhere the agent did not choose and the next
 * command runs in the workspace. Other processes are left to fail as they
 * would.
 */
export function guardShellFolder(workspace: () => string | undefined, warn: (message: string) => void): void {
  const require = createRequire(import.meta.url)
  const childProcess: typeof import("node:child_process") = require("node:child_process")
  // SAFETY: every `spawn` overload accepts the arguments its caller passed,
  // and the guard changes only a shell's command string and its `cwd` string.
  const spawn = childProcess.spawn as ForwardedSpawn
  const guarded = (...parameters: unknown[]) => {
    const call = ShellSpawnSchema.safeParse(parameters).data
    if (call && !workingDirectoryExists(call[2].cwd)) {
      const [command, args] = call
      const index = shellCommandIndex(command, args)
      if (index !== undefined) {
        const candidate = workspace()
        const now = candidate !== undefined && workingDirectoryExists(candidate) ? candidate : homedir()
        const moved = [...args]
        moved[index] = movedShellCommand(call[2].cwd, now)
        warn("a shell's folder was deleted; its command was not run and the shell moved to the workspace")
        parameters = [command, moved, Object.assign({}, parameters[2], { cwd: now }), ...parameters.slice(3)]
      }
    }
    return spawn(...parameters)
  }
  // SAFETY: `guarded` returns what the original `spawn` returns for the same
  // arguments, so it answers every `spawn` overload.
  childProcess.spawn = guarded as typeof childProcess.spawn
  syncBuiltinESMExports()
}

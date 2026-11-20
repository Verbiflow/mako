import { environmentVariable, resolveExecutable } from "../base/executable.js"
import { onWindows } from "../base/platform.js"

/** A shell to start: its program and the words it starts with. */
export interface TerminalShell {
  file: string
  args: string[]
}

/**
 * The shell a terminal opens: the person's login shell on macOS and Linux; on Windows PowerShell 7 (`pwsh`) where it
 * is installed, else Windows PowerShell, which every Windows has, else ComSpec's `cmd.exe`.
 */
export function terminalShell(env: NodeJS.ProcessEnv = process.env): TerminalShell {
  if (!onWindows()) return { file: env.SHELL ?? "/bin/sh", args: ["-l"] }
  for (const name of ["pwsh", "powershell"]) {
    const found = resolveExecutable(name, env)
    if (found) return { file: found, args: ["-NoLogo"] }
  }
  return { file: environmentVariable(env, "COMSPEC") ?? "cmd.exe", args: [] }
}

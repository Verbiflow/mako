import { win32 } from "node:path"

/**
 * Windows' own programs by their whole paths. A bare name is looked for in the working folder before PATH (libuv's
 * search, unless `NoDefaultCurrentDirectoryInExePath` is set), so `taskkill` or `powershell` started in a project
 * whose root holds a `taskkill.exe` would run that.
 */
export function systemRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.SystemRoot || env.SYSTEMROOT || env.windir || "C:\\Windows"
}

export const windowsTaskkill = (env: NodeJS.ProcessEnv = process.env): string => win32.join(systemRoot(env), "System32", "taskkill.exe")
export const windowsPowerShell = (env: NodeJS.ProcessEnv = process.env): string => win32.join(systemRoot(env), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
export const windowsIcacls = (env: NodeJS.ProcessEnv = process.env): string => win32.join(systemRoot(env), "System32", "icacls.exe")

/** ComSpec when it names a program by its whole path, else the system's own cmd.exe. */
export function windowsComSpec(env: NodeJS.ProcessEnv = process.env): string {
  const named = env.ComSpec || env.COMSPEC
  return named && win32.isAbsolute(named) ? named : win32.join(systemRoot(env), "System32", "cmd.exe")
}

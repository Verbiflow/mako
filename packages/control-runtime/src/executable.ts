import { accessSync, constants, statSync } from "node:fs"
import { delimiter, extname, isAbsolute, join } from "node:path"
import { nodePlatform } from "./platform.js"

/**
 * Runtime tools use explicit PATH; never inspect a developer's agent installs.
 *
 * On Windows nothing is searched for: a program another account could put in a PATH folder there (anything made under
 * `C:\` inherits their write) would run as this user, and the control runtime can't ask who may write where. Its tools
 * come by whole path from the host that embeds it (`MAKO_VIDEO_HELPER`, the app's own folder); an absolute command is
 * taken as named, by PATHEXT's extensions when it has none. Elsewhere it must be an executable file on PATH.
 */
export function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = nodePlatform()
): string | undefined {
  const windows = platform === "win32"
  if (windows && !isAbsolute(command)) return undefined
  const names = windows ? windowsNames(command, variable(env, "PATHEXT")) : [command]
  const folders = isAbsolute(command) ? [""] : (env.PATH ?? "").split(delimiter).filter(Boolean)
  for (const folder of folders)
    for (const name of names) {
      const candidate = folder ? join(folder, name) : name
      if (runnable(candidate, windows)) return candidate
    }
  return undefined
}

function windowsNames(command: string, pathext: string | undefined): string[] {
  const extensions = (pathext || ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim().toLowerCase()).filter((ext) => ext.startsWith("."))
  return extensions.includes(extname(command).toLowerCase()) ? [command] : extensions.map((ext) => command + ext)
}

/** Windows names its variables in any case, which a copy of `process.env` no longer forgives. */
function variable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name]
  const key = Object.keys(env).find((key) => key.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

function runnable(candidate: string, windows: boolean): boolean {
  try {
    if (!windows) accessSync(candidate, constants.X_OK)
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

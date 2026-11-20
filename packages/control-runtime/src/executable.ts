import { accessSync, constants, statSync } from "node:fs"
import { delimiter, extname, isAbsolute, join } from "node:path"
import { nodePlatform } from "./platform.js"

/**
 * Runtime tools use explicit PATH; never inspect a developer's agent installs.
 *
 * Windows runs only what ends in one of `PATHEXT`'s extensions (`.COM;.EXE;.BAT;.CMD` when it's unset), so a bare
 * `mako-video` is found as `mako-video.exe`, and the extensionless file npm writes beside `tool.cmd` (a shell script)
 * is never taken for the tool; a command already ending in one is looked for as it is. Windows has no execute bit
 * (`X_OK` there asks only that the file exists), so there a file is what counts; elsewhere it must be an executable
 * file. Windows names `PATH` in any case (`Path` is usual), which a copy of `process.env` no longer forgives.
 */
export function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = nodePlatform()
): string | undefined {
  const windows = platform === "win32"
  const names = windows ? windowsNames(command, variable(env, "PATHEXT", true)) : [command]
  const folders = isAbsolute(command) ? [""] : (variable(env, "PATH", windows) ?? "").split(delimiter).filter(Boolean)
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

function variable(env: NodeJS.ProcessEnv, name: string, anyCase: boolean): string | undefined {
  if (!anyCase || env[name] !== undefined) return env[name]
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

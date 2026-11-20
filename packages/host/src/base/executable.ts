import { accessSync, constants, readdirSync, realpathSync, statSync, type Dirent } from "node:fs"
import { access, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, dirname, extname, isAbsolute, join } from "node:path"
import { onWindows } from "./platform.js"
import { windowsHelperLines, windowsHelperSync } from "./windows-helper.js"

/** nvm's Node versions under `nvmRoot`, newest first, each one's folder of executables. */
function nvmBinsOf(nvmRoot: string, entries: Dirent[]): string[] {
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) =>
      right.localeCompare(left, undefined, { numeric: true })
    )
    .map((version) => join(nvmRoot, version, "bin"))
}

export function executableCandidates(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): string[] {
  if (isAbsolute(command)) return commandNames(command, env)
  const nvmRoot = join(home, ".nvm", "versions", "node")
  const nvmBins = (() => {
    try {
      return nvmBinsOf(nvmRoot, readdirSync(nvmRoot, { withFileTypes: true }))
    } catch {
      return []
    }
  })()
  return candidatesIn(command, env, home, nvmBins)
}

/**
 * An environment's variable by `name`, in any case on Windows, which names `PATH` as `Path` and forgives the case; a
 * copy of `process.env` no longer does.
 */
export function environmentVariable(env: NodeJS.ProcessEnv, name: string, windows = onWindows()): string | undefined {
  if (!windows || env[name] !== undefined) return env[name]
  const key = Object.keys(env).find((key) => key.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

/**
 * The names `command` is found by in a folder: on Windows only those ending in one of `PATHEXT`'s extensions
 * (`.COM;.EXE;.BAT;.CMD` when it's unset), so `grok` is `grok.cmd` or `grok.exe` and never the extensionless shell
 * script npm writes beside its shim; a command already ending in one is looked for as it is.
 */
export function commandNames(command: string, env: NodeJS.ProcessEnv, windows = onWindows()): string[] {
  if (!windows) return [command]
  const extensions = (environmentVariable(env, "PATHEXT", true) || ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim().toLowerCase()).filter((ext) => ext.startsWith("."))
  return extensions.includes(extname(command).toLowerCase()) ? [command] : extensions.map((ext) => command + ext)
}

function candidatesIn(command: string, env: NodeJS.ProcessEnv, home: string, nvmBins: string[]): string[] {
  const names = commandNames(command, env)
  if (isAbsolute(command)) return names
  if (onWindows()) return windowsFolders(env, home).flatMap((directory) => names.map((name) => join(directory, name)))
  return [
    // A relative folder on Windows' PATH (`.`, or empty) is the working folder: never looked in.
    ...(environmentVariable(env, "PATH") ?? "").split(delimiter).filter((folder) => folder && (!onWindows() || isAbsolute(folder))),
    env.NVM_BIN,
    join(home, ".local", "bin"),
    join(home, ".codex", "bin"),
    join(home, ".claude", "bin"),
    join(home, ".cursor", "bin"),
    join(home, ".grok", "bin"),
    join(home, ".opencode", "bin"),
    join(home, ".bun", "bin"),
    ...nvmBins,
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]
    .filter((directory) => directory !== undefined)
    .flatMap((directory) => names.map((name) => join(directory, name)))
}

/**
 * Where Windows' launches look: PATH's whole-path folders (a relative one, `.` or empty, is the working folder), then
 * the harnesses' own installs under the user's profile and npm's global folder. Never a POSIX folder, which Windows
 * reads from the drive's root (`/usr/local/bin` is `C:\usr\local\bin`) where any account may make it.
 */
function windowsFolders(env: NodeJS.ProcessEnv, home: string): string[] {
  const appData = env.APPDATA || join(home, "AppData", "Roaming")
  return [
    ...(environmentVariable(env, "PATH") ?? "").split(delimiter).filter((folder) => folder && isAbsolute(folder) && /^[a-zA-Z]:[\\/]|^\\\\/.test(folder)),
    join(home, ".local", "bin"),
    join(home, ".codex", "bin"),
    join(home, ".claude", "bin"),
    join(home, ".cursor", "bin"),
    join(home, ".grok", "bin"),
    join(home, ".opencode", "bin"),
    join(home, ".bun", "bin"),
    join(appData, "npm"),
  ]
}

/**
 * Whether a program found in `folder` is this user's choice, on Windows: in their own profile or the system's
 * folder, or anywhere `mako-windows trusted` finds owned and writable only by this user, SYSTEM, administrators or
 * TrustedInstaller, as every folder above it is for deleting or renaming. A folder on PATH that another account can
 * write to (anything made under `C:\` inherits that) is passed by: a program planted there would run as this user.
 * Without the helper, the Program Files folders count too, as Windows makes them (administrators' alone): an
 * installer that loosened one is the risk taken until the helper is installed.
 */
export function trustedFolder(folder: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): boolean {
  if (!onWindows()) return true
  if (underAny(folder, [home, env.SystemRoot || env.SYSTEMROOT || "C:\\Windows"])) return true
  const said = windowsHelperSync(["trusted", folder])?.[0]
  return said === undefined ? underAny(folder, programFiles(env)) : said === "trusted"
}

const programFiles = (env: NodeJS.ProcessEnv): string[] => [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432].filter((folder): folder is string => Boolean(folder))

/** `trustedFolder`, off the thread. */
async function trustedFolderAsync(folder: string, env: NodeJS.ProcessEnv, home: string): Promise<boolean> {
  if (!onWindows()) return true
  if (underAny(folder, [home, env.SystemRoot || env.SYSTEMROOT || "C:\\Windows"])) return true
  const said = (await windowsHelperLines(["trusted", folder]))?.[0]
  return said === undefined ? underAny(folder, programFiles(env)) : said === "trusted"
}

/**
 * Whether `path` is one of `folders` or inside one, in any case as Windows names them, each by its long name through
 * any link (`C:\Users\RUNNER~1` is `C:\Users\runneradmin`).
 */
function underAny(path: string, folders: readonly string[]): boolean {
  const real = (folder: string) => {
    try {
      return realpathSync.native(folder)
    } catch {
      return folder
    }
  }
  const lower = real(path).toLowerCase().replace(/[\\/]+$/, "")
  return folders.some((folder) => {
    const base = real(folder).toLowerCase().replace(/[\\/]+$/, "")
    return lower === base || lower.startsWith(`${base}\\`) || lower.startsWith(`${base}/`)
  })
}

export function environmentForExecutable(
  executable: string,
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const bin = dirname(executable)
  const paths = (environmentVariable(env, "PATH") ?? "").split(delimiter).filter(Boolean)
  // One PATH, under the name the environment already had it by: Windows would see two in any case as one.
  const key = Object.keys(env).find((key) => key.toUpperCase() === "PATH" && onWindows()) ?? "PATH"
  return {
    ...env,
    [key]: [bin, ...paths.filter((path) => path !== bin)].join(delimiter),
  }
}

export function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): string | null {
  for (const candidate of executableCandidates(command, env, home)) {
    try {
      // Windows has no execute bit (`X_OK` asks only that it exists): there a file is what runs, from a folder only this
      // user or the system can put it in, when it was looked for rather than named.
      if (!onWindows()) accessSync(candidate, constants.X_OK)
      else if (!statSync(candidate).isFile() || (!isAbsolute(command) && !trustedFolder(dirname(candidate), env, home))) continue
      return candidate
    } catch {
      continue
    }
  }
  return null
}

/**
 * Where the host's launches find their executables, without holding its thread: `resolveExecutable` asks the disk
 * about each folder in turn while the thread waits, and one launch's walk waited 400 ms on a busy disk with thirty
 * Fins at work. What a walk found is kept for the command and the folders it was looked for in, and found again by
 * asking only whether it is still there; a command not found is looked for whole each time, as it may be installed
 * since.
 */
export class Executables {
  private readonly found = new Map<string, string>()

  async find(command: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<string | null> {
    const key = [command, environmentVariable(env, "PATH") ?? "", env.NVM_BIN ?? "", home].join("\0")
    const kept = this.found.get(key)
    if (kept && await runs(kept) && (isAbsolute(command) || await trustedFolderAsync(dirname(kept), env, home))) return kept
    this.found.delete(key)
    const found = await findExecutable(command, env, home)
    if (found) this.found.set(key, found)
    return found
  }
}

/** `resolveExecutable`, awaited: the same folders in the same order, asked of the disk off the thread. */
export async function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<string | null> {
  const nvmRoot = join(home, ".nvm", "versions", "node")
  const candidates = isAbsolute(command)
    ? commandNames(command, env)
    : candidatesIn(command, env, home, await readdir(nvmRoot, { withFileTypes: true }).then((entries) => nvmBinsOf(nvmRoot, entries), () => []))
  for (const candidate of candidates)
    if (await runs(candidate) && (isAbsolute(command) || await trustedFolderAsync(dirname(candidate), env, home))) return candidate
  return null
}

async function runs(path: string): Promise<boolean> {
  try {
    if (!onWindows()) await access(path, constants.X_OK)
    else return (await stat(path)).isFile()
    return true
  } catch {
    return false
  }
}

import { accessSync, constants, readdirSync, statSync, type Dirent } from "node:fs"
import { access, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, dirname, extname, isAbsolute, join } from "node:path"
import { onWindows } from "./platform.js"
import { windowsHelperLines, windowsHelperSync } from "./windows-helper.js"
import { parseVerdict, trustedWithoutAsking, trustedWithoutHelper } from "./executable-trust.js"
import { hostStopping } from "./host-stopping.js"

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
/** PATHEXT's extensions, lowered (`.COM;.EXE;.BAT;.CMD` when it's unset). */
export function pathExtensions(env: NodeJS.ProcessEnv): string[] {
  return (environmentVariable(env, "PATHEXT", true) || ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim().toLowerCase()).filter((ext) => ext.startsWith("."))
}

export function commandNames(command: string, env: NodeJS.ProcessEnv, windows = onWindows()): string[] {
  if (!windows) return [command]
  const extensions = pathExtensions(env)
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
/** PATH's folders on a drive, as Windows' launches search them. */
export function windowsPathFolders(env: NodeJS.ProcessEnv = process.env): string[] {
  return (environmentVariable(env, "PATH") ?? "").split(delimiter).filter((folder) => /^[a-zA-Z]:[\\/]/.test(folder))
}

export function windowsFolders(env: NodeJS.ProcessEnv, home: string): string[] {
  const appData = env.APPDATA || join(home, "AppData", "Roaming")
  return [
    // A drive's folders only: never a relative one (the working folder) or a network share's.
    ...windowsPathFolders(env),
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
 * Where a program Windows' launches found by searching really is, when it is this user's choice
 * (`executable-trust.ts`): that path is what's started, never the one it was found by. On a host's thread a verdict it
 * keeps answers; one it hasn't seen is asked once, waiting, and kept. Elsewhere the program as found.
 */
export function trustedProgram(file: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string | undefined {
  if (!onWindows()) return file
  const plain = trustedWithoutAsking(file, { env, home })
  if (plain) return plain
  const trust = hostStopping()?.trust
  const verdict = trust?.known(file) ?? trust?.checkNow(file, env) ?? parseVerdict(windowsHelperSync(["trusted", "-"], `${file}\n`)?.[0]) ?? trustedWithoutHelper(file, env)
  return verdict.trusted ? verdict.real : undefined
}

/** `trustedProgram`, off the thread. */
async function trustedProgramAsync(file: string, env: NodeJS.ProcessEnv, home: string): Promise<string | undefined> {
  if (!onWindows()) return file
  const plain = trustedWithoutAsking(file, { env, home })
  if (plain) return plain
  const trust = hostStopping()?.trust
  let verdict = trust?.known(file)
  if (!verdict && trust) {
    await trust.check([file], env)
    verdict = trust.known(file)
  }
  verdict ??= parseVerdict((await windowsHelperLines(["trusted", "-"], `${file}\n`))?.[0]) ?? trustedWithoutHelper(file, env)
  return verdict.trusted ? verdict.real : undefined
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
      else if (!statSync(candidate).isFile()) continue
      else if (!isAbsolute(command)) {
        // Windows: the program where it really is, when it's this user's choice; that is what's started.
        const real = trustedProgram(candidate, env, home)
        if (!real) continue
        return real
      }
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
    if (kept && await runs(kept)) {
      const real = isAbsolute(command) ? kept : await trustedProgramAsync(kept, env, home)
      if (real) return real
    }
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
  for (const candidate of candidates) {
    if (!(await runs(candidate))) continue
    const real = isAbsolute(command) ? candidate : await trustedProgramAsync(candidate, env, home)
    if (real) return real
  }
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

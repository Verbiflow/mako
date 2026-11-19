import { accessSync, constants, readdirSync, type Dirent } from "node:fs"
import { access, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, dirname, isAbsolute, join } from "node:path"

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
  if (isAbsolute(command)) return [command]
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

function candidatesIn(command: string, env: NodeJS.ProcessEnv, home: string, nvmBins: string[]): string[] {
  return [
    ...(env.PATH ?? "").split(delimiter).filter(Boolean),
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
    .map((directory) => join(directory, command))
}

export function environmentForExecutable(
  executable: string,
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const bin = dirname(executable)
  const paths = (env.PATH ?? "").split(delimiter).filter(Boolean)
  return {
    ...env,
    PATH: [bin, ...paths.filter((path) => path !== bin)].join(delimiter),
  }
}

export function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): string | null {
  for (const candidate of executableCandidates(command, env, home)) {
    try {
      accessSync(candidate, constants.X_OK)
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
    const key = [command, env.PATH ?? "", env.NVM_BIN ?? "", home].join("\0")
    const kept = this.found.get(key)
    if (kept && await runs(kept)) return kept
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
    ? [command]
    : candidatesIn(command, env, home, await readdir(nvmRoot, { withFileTypes: true }).then((entries) => nvmBinsOf(nvmRoot, entries), () => []))
  for (const candidate of candidates) if (await runs(candidate)) return candidate
  return null
}

async function runs(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

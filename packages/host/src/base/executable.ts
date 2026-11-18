import { accessSync, constants, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, isAbsolute, join } from "node:path"

export function executableCandidates(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): string[] {
  if (isAbsolute(command)) return [command]
  const nvmRoot = join(home, ".nvm", "versions", "node")
  const nvmBins = (() => {
    try {
      return readdirSync(nvmRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) =>
          right.localeCompare(left, undefined, { numeric: true })
        )
        .map((version) => join(nvmRoot, version, "bin"))
    } catch {
      return []
    }
  })()
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

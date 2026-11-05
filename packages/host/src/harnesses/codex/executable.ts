import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, readdir, realpath } from "node:fs/promises"
import { arch, homedir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import {
  environmentForExecutable,
  resolveExecutable,
} from "../../base/executable.js"
import { nodePlatform, onMac } from "../../base/platform.js"

const run = promisify(execFile)

export function codexExecutableCandidates(env = process.env): string[] {
  if (env.CODEX_EXECUTABLE) {
    const explicit = resolveExecutable(env.CODEX_EXECUTABLE, env)
    return explicit ? [explicit] : []
  }
  const commands = ["codex"]
  if (onMac()) {
    for (const root of ["/Applications", join(homedir(), "Applications")])
      for (const app of ["ChatGPT.app", "Codex.app"])
        commands.push(join(root, app, "Contents", "Resources", "codex"))
  }
  return [
    ...new Set(
      commands.flatMap((command) => {
        const path = resolveExecutable(command, env)
        return path ? [path] : []
      })
    ),
  ]
}

/**
 * What a Codex start reads from disk: npm's `codex` is a script that runs the native build its platform's package
 * carries (`@openai/codex-<platform>/vendor/<target>/bin/codex`), in the package's own node_modules or beside it.
 * Any other install is the native build itself.
 */
export async function codexStartFiles(env = process.env): Promise<string[]> {
  const command = await resolveCodexExecutable(env)
  if (!command) return []
  const real = await realpath(command).catch(() => command)
  if (!real.endsWith(".js")) return [real]
  const root = dirname(dirname(real))
  const builds = await Promise.all([join(root, "node_modules", "@openai"), dirname(root)].map(async (scope) => {
    const names = (await readdir(scope).catch(() => [])).filter((name) => name.startsWith("codex-"))
    return Promise.all(names.map(async (name) => {
      const vendor = join(scope, name, "vendor")
      return (await readdir(vendor).catch(() => [])).map((target) => join(vendor, target, "bin", "codex"))
    }))
  }))
  return [real, ...builds.flat(2)]
}

/** npm's platform packages for Codex, and the Rust target each one's `vendor` folder is named for. */
const CODEX_BUILDS = new Map([
  ["darwin-arm64", { name: "codex-darwin-arm64", target: "aarch64-apple-darwin" }],
  ["darwin-x64", { name: "codex-darwin-x64", target: "x86_64-apple-darwin" }],
  ["linux-arm64", { name: "codex-linux-arm64", target: "aarch64-unknown-linux-musl" }],
  ["linux-x64", { name: "codex-linux-x64", target: "x86_64-unknown-linux-musl" }],
  ["win32-arm64", { name: "codex-win32-arm64", target: "aarch64-pc-windows-msvc" }],
  ["win32-x64", { name: "codex-win32-x64", target: "x86_64-pc-windows-msvc" }],
])

const MANAGERS = ["CODEX_MANAGED_BY_NPM", "CODEX_MANAGED_BY_BUN", "CODEX_MANAGED_BY_PNPM", "CODEX_MANAGED_BY_VITE_PLUS"]

export interface CodexLaunch {
  executable: string
  /** What npm's script sets for the native build: which package it was installed from, and by what. */
  env: Record<string, string | undefined>
}

/**
 * What runs `command` for a session. npm's `codex` is a Node script that finds its platform's native build, sets
 * two variables, and waits on it while forwarding signals: a Node runtime per Codex session that does nothing else
 * (29 MB resident beside the build's 141 MB, 2026-11-04). The build is started directly, with those variables;
 * any other install, or a script whose build isn't where npm puts it, starts as it is.
 */
export async function codexLaunch(command: string, platform = `${nodePlatform()}-${arch()}`): Promise<CodexLaunch> {
  const as = { executable: command, env: {} }
  const build = CODEX_BUILDS.get(platform)
  const real = await realpath(command).catch(() => command)
  if (!build || !real.endsWith(".js")) return as
  const root = dirname(dirname(real))
  const binary = platform.startsWith("win32") ? "codex.exe" : "codex"
  for (const scope of [join(root, "node_modules", "@openai"), dirname(root)]) {
    const native = join(scope, build.name, "vendor", build.target, "bin", binary)
    if (!(await access(native, constants.X_OK).then(() => true, () => false))) continue
    const env: Record<string, string | undefined> = Object.fromEntries(MANAGERS.map((name) => [name, undefined]))
    env[await codexManager(root)] = "1"
    env.CODEX_MANAGED_PACKAGE_ROOT = root
    return { executable: native, env }
  }
  return as
}

/** The package manager npm's script would name for `root`; its own fallback is npm. */
async function codexManager(root: string): Promise<string> {
  if (root.includes(join(".bun", "install", "global"))) return "CODEX_MANAGED_BY_BUN"
  for (let folder = root; dirname(folder) !== folder; folder = dirname(folder)) {
    const modules = join(folder, "node_modules")
    if (!(await access(join(modules, ".modules.yaml")).then(() => true, () => false))) continue
    if ((await realpath(join(modules, "@openai", "codex")).catch(() => undefined)) === root) return "CODEX_MANAGED_BY_PNPM"
  }
  return "CODEX_MANAGED_BY_NPM"
}

/** Check configuration compatibility before creating any native thread. Explicit selection is respected. */
export async function resolveCodexExecutable(
  env = process.env
): Promise<string | null> {
  const candidates = codexExecutableCandidates(env)
  if (env.CODEX_EXECUTABLE || candidates.length < 2)
    return candidates[0] ?? null
  for (const command of candidates) {
    try {
      await run(command, ["features", "list"], {
        env: environmentForExecutable(command, env),
        timeout: 5_000,
        maxBuffer: 256 * 1024,
        windowsHide: true,
      })
      return command
    } catch {
      /* The next installed CLI may understand a newer configuration format. */
    }
  }
  // Preserve the selected CLI's actual startup diagnostic when no compatible installation exists.
  return candidates[0] ?? null
}

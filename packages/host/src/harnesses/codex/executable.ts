import { hostCommand } from "../../base/host-command.js"
import { constants } from "node:fs"
import { access, readFile, readdir, realpath } from "node:fs/promises"
import { arch, homedir } from "node:os"
import { basename, dirname, join, parse, resolve } from "node:path"
import {
  environmentForExecutable,
  resolveExecutable,
} from "../../base/executable.js"
import { isJsonObject, stringValue } from "../../base/json-values.js"
import { nodePlatform, onMac } from "../../base/platform.js"
import type { JsonValue } from "../../contracts/json.js"

const run = hostCommand

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
 * (29 MB resident beside the build's 141 MB, 2026-11-04). The build is started directly, with those variables,
 * only when `command` is that package's own bin and the build is where the script looks. Anything else, including
 * an explicit wrapper that merely sits beside a platform package, starts as it is. `env` is the environment that
 * process is about to get: the script reads its package manager from there, and from the entrypoint's own path.
 */
export async function codexLaunch(
  command: string,
  platform = `${nodePlatform()}-${arch()}`,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexLaunch> {
  const as = { executable: command, env: {} }
  const build = CODEX_BUILDS.get(platform)
  const real = await realpath(command).catch(() => command)
  if (!build || !real.endsWith(".js")) return as
  const root = await officialCodexRoot(real)
  if (!root) return as
  const binary = platform.startsWith("win32") ? "codex.exe" : "codex"
  for (const scope of [join(root, "node_modules", "@openai"), dirname(root)]) {
    const native = join(scope, build.name, "vendor", build.target, "bin", binary)
    if (!(await access(native, constants.X_OK).then(() => true, () => false))) continue
    const launch: Record<string, string | undefined> = Object.fromEntries(MANAGERS.map((name) => [name, undefined]))
    launch[await codexManager(root, command, dirname(real), env)] = "1"
    launch.CODEX_MANAGED_PACKAGE_ROOT = root
    return { executable: native, env: launch }
  }
  return as
}

/** `@openai/codex`'s package root when `real` is that package's own bin script, resolved. */
async function officialCodexRoot(real: string): Promise<string | undefined> {
  const root = dirname(dirname(real))
  const text = await readFile(join(root, "package.json"), "utf8").catch(() => undefined)
  if (!text) return
  const meta = jsonObject(text)
  if (!meta || stringValue(meta.name) !== "@openai/codex") return
  for (const bin of binPaths(meta.bin)) {
    if ((await realpath(join(root, bin)).catch(() => undefined)) === real) return root
  }
  return
}

function jsonObject(text: string) {
  let value: JsonValue
  try {
    value = JSON.parse(text)
  } catch {
    return
  }
  return isJsonObject(value) ? value : undefined
}

function binPaths(bin: JsonValue | undefined): string[] {
  const one = stringValue(bin)
  if (one) return [one]
  const many = isJsonObject(bin) ? bin : undefined
  if (!many) return []
  return Object.values(many).flatMap((target) => {
    const path = stringValue(target)
    return path ? [path] : []
  })
}

/**
 * The variable npm's `bin/codex.js` would set. Walks the real package and the lexical entrypoint, Vite+ metadata
 * before pnpm's, then Bun's user agent, exec path and install directory. Its own fallback is npm.
 */
async function codexManager(root: string, entry: string, scriptDir: string, env: NodeJS.ProcessEnv): Promise<string> {
  for (const start of new Set([root, dirname(resolve(entry))])) {
    const filesystemRoot = parse(start).root
    for (let current = start; current !== filesystemRoot; current = dirname(current)) {
      if (await vitePlusOwns(current, root)) return "CODEX_MANAGED_BY_VITE_PLUS"
      if (await pnpmOwns(join(current, "node_modules"), root)) return "CODEX_MANAGED_BY_PNPM"
    }
    if (await pnpmOwns(join(filesystemRoot, "node_modules"), root)) return "CODEX_MANAGED_BY_PNPM"
  }
  const userAgent = env.npm_config_user_agent ?? ""
  if (/\bbun\//.test(userAgent)) return "CODEX_MANAGED_BY_BUN"
  if ((env.npm_execpath ?? "").includes("bun")) return "CODEX_MANAGED_BY_BUN"
  // The script's own directory, as its `__dirname`, not the path it was invoked through.
  if (bunGlobal(scriptDir)) return "CODEX_MANAGED_BY_BUN"
  return "CODEX_MANAGED_BY_NPM"
}

function bunGlobal(place: string): boolean {
  return place.includes(".bun/install/global") || place.includes(".bun\\install\\global")
}

async function pnpmOwns(modules: string, root: string): Promise<boolean> {
  if (!(await access(join(modules, ".modules.yaml")).then(() => true, () => false))) return false
  return (await realpath(join(modules, "@openai", "codex")).catch(() => undefined)) === root
}

async function vitePlusOwns(packagesDir: string, root: string): Promise<boolean> {
  if (basename(packagesDir) !== "packages") return false
  const text = await readFile(join(packagesDir, "@openai", "codex.json"), "utf8").catch(() => undefined)
  if (!text) return false
  const meta = jsonObject(text)
  if (!meta || stringValue(meta.name) !== "@openai/codex") return false
  const installId = stringValue(meta.installId) ?? ""
  const installDir = installId.startsWith("#")
    ? join(packagesDir, `@openai/codex${installId}`)
    : join(packagesDir, "@openai", "codex", installId)
  for (const modules of [join(installDir, "lib", "node_modules"), join(installDir, "node_modules")]) {
    if ((await realpath(join(modules, "@openai", "codex")).catch(() => undefined)) === root) return true
  }
  return false
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

import { execFile } from "node:child_process"
import { readdir, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import {
  environmentForExecutable,
  resolveExecutable,
} from "../../base/executable.js"
import { onMac } from "../../base/platform.js"

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

import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { resolveExecutable } from "../../executable.js"

/**
 * The Devin CLI Mako launches. The standalone install comes first because it
 * updates itself; `cli.devin.ai/install.sh` links ~/.local/bin/devin, which
 * the shared resolver searches with PATH. Devin.app and Zed each carry a
 * full CLI of their own, `acp` included, updated with that app.
 */
export function devinExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.DEVIN_CLI_PATH
  if (configured && existsSync(configured)) return configured
  const standalone = resolveExecutable("devin", env)
  if (standalone) return standalone
  if (process.platform !== "darwin") return null
  for (const applications of ["/Applications", join(homedir(), "Applications")]) {
    const bundled = join(
      applications,
      "Devin.app",
      "Contents",
      "Resources",
      "app",
      "extensions",
      "windsurf",
      "devin",
      "bin",
      "devin"
    )
    if (existsSync(bundled)) return bundled
  }
  const registry = join(
    homedir(),
    "Library",
    "Application Support",
    "Zed",
    "external_agents",
    "registry",
    "devin"
  )
  try {
    for (const version of readdirSync(registry).sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true })
    )) {
      const executable = join(registry, version, "bin", "devin")
      if (existsSync(executable)) return executable
    }
  } catch {
    return null
  }
  return null
}

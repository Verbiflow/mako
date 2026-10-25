import { existsSync } from "node:fs"
import { readdir, realpath } from "node:fs/promises"
import { dirname, join } from "node:path"
import { resolveCodexExecutable } from "@mako/host/harnesses/codex/executable"

/** The native Codex binary Mako runs; the npm launcher runs one from its platform package. */
export async function codexBinary(): Promise<string | null> {
  const launcher = await resolveCodexExecutable()
  if (!launcher) return null
  const real = await realpath(launcher)
  if (!real.endsWith(".js")) return real
  // The platform package is the launcher's dependency: nested under its package, or hoisted beside it.
  const platform = join("node_modules", `@openai/codex-${process.platform}-${process.arch}`, "vendor")
  for (let folder = dirname(dirname(real)); folder !== dirname(folder); folder = dirname(folder)) {
    const vendor = join(folder, platform)
    if (!existsSync(vendor)) continue
    const [target] = await readdir(vendor)
    return target ? join(vendor, target, "bin", "codex") : null
  }
  return null
}

/** The Claude Code the Agent SDK bundles, which Mako runs. */
export function claudeSdkBinary(): string {
  return new URL(`../node_modules/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`, import.meta.url).pathname
}

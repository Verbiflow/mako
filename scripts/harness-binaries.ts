import { readdir, realpath } from "node:fs/promises"
import { dirname, join } from "node:path"
import { resolveCodexExecutable } from "../electron/providers/codex/executable.ts"

/** The native Codex binary Mako runs; the npm launcher runs one from its platform package. */
export async function codexBinary(): Promise<string | null> {
  const launcher = await resolveCodexExecutable()
  if (!launcher) return null
  const real = await realpath(launcher)
  if (!real.endsWith(".js")) return real
  const vendor = join(dirname(real), "..", "node_modules", `@openai/codex-${process.platform}-${process.arch}`, "vendor")
  const [target] = await readdir(vendor)
  return target ? join(vendor, target, "bin", "codex") : null
}

/** The Claude Code the Agent SDK bundles, which Mako runs. */
export function claudeSdkBinary(): string {
  return new URL(`../node_modules/@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`, import.meta.url).pathname
}

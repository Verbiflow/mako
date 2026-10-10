import { existsSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { z } from "zod"
import { resolveExecutable } from "@mako/host/base/executable"
import { claudeExecutablePath } from "./sdk-process.js"
import { onWindows } from "@mako/host/base/platform"

export type ClaudeRuntime =
  | { kind: "configured"; executable: string }
  | { kind: "bundled"; executable: string }

/**
 * The Claude Code executable Mako's sessions run, and therefore the one model
 * discovery and the Settings version row must read: `CLAUDE_CODE_EXECUTABLE`
 * when set, otherwise the build the Agent SDK ships. The SDK and its build
 * are released in lockstep, so a newer `claude` on PATH is never substituted.
 */
export function claudeRuntime(
  env: NodeJS.ProcessEnv = process.env
): ClaudeRuntime | null {
  if (env.CLAUDE_CODE_EXECUTABLE) {
    const executable = resolveExecutable(env.CLAUDE_CODE_EXECUTABLE, env)
    return executable ? { kind: "configured", executable } : null
  }
  const executable = bundledClaudeExecutable()
  return executable ? { kind: "bundled", executable } : null
}

/** The user's own `claude`, unless it is the executable sessions already run. */
export function terminalClaudeExecutable(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const terminal = resolveExecutable("claude", env)
  const runtime = claudeRuntime(env)
  if (!terminal || !runtime) return terminal
  return sameFile(terminal, runtime.executable) ? null : terminal
}

/**
 * The build the Agent SDK ships, found as the SDK finds it. npm installs the
 * one package that matches this machine, so the C library is asked only when
 * both Linux builds are there; that report takes some 20 ms.
 */
export function bundledClaudeExecutable(): string | null {
  const require = createRequire(import.meta.url)
  const suffix = onWindows() ? ".exe" : ""
  const found = bundledPackages().flatMap((name) => {
    try {
      const path = claudeExecutablePath(require.resolve(`@anthropic-ai/claude-agent-sdk-${name}/claude${suffix}`))
      return existsSync(path) ? [{ name, path }] : []
    } catch {
      return []
    }
  })
  if (found.length < 2) return found[0]?.path ?? null
  const musl = muslRuntime()
  return (found.find(({ name }) => name.endsWith("-musl") === musl) ?? found[0]!).path
}

const ProcessReportSchema = z.object({
  header: z.object({ glibcVersionRuntime: z.string().optional() }).optional(),
})

function bundledPackages(): string[] {
  const { platform, arch } = process
  if (platform === "android") return [`linux-${arch}-android`]
  if (platform !== "linux") return [`${platform}-${arch}`]
  return [`linux-${arch}`, `linux-${arch}-musl`]
}

// The SDK's own test: a Node built against glibc reports its version.
function muslRuntime(): boolean {
  const report = ProcessReportSchema.safeParse(process.report?.getReport())
  return report.success && report.data.header?.glibcVersionRuntime === undefined
}

function sameFile(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return left === right
  }
}

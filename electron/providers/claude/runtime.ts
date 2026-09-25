import { existsSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { resolveExecutable } from "../../executable.js"
import { claudeExecutablePath } from "./sdk-process.js"

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

let bundled: string | null | undefined

export function bundledClaudeExecutable(): string | null {
  if (bundled !== undefined) return bundled
  const require = createRequire(import.meta.url)
  const suffix = process.platform === "win32" ? ".exe" : ""
  for (const name of bundledPackages()) {
    try {
      const path = claudeExecutablePath(
        require.resolve(`@anthropic-ai/claude-agent-sdk-${name}/claude${suffix}`)
      )
      if (existsSync(path)) return (bundled = path)
    } catch {
      continue
    }
  }
  return (bundled = null)
}

// Must follow the SDK's own lookup order, or Settings and discovery would read
// a different build than the one sessions launch.
function bundledPackages(): string[] {
  const { platform, arch } = process
  if (platform === "android") return [`linux-${arch}-android`]
  if (platform !== "linux") return [`${platform}-${arch}`]
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined
  const musl = report !== undefined && report.header?.glibcVersionRuntime === undefined
  return musl
    ? [`linux-${arch}-musl`, `linux-${arch}`]
    : [`linux-${arch}`, `linux-${arch}-musl`]
}

function sameFile(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return left === right
  }
}

import { existsSync, readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { resolveExecutable } from "../../base/executable.js"
import { claudeExecutablePath } from "./sdk-process.js"
import { onLinux, onWindows } from "../../base/platform.js"
import type { HarnessUpdateCommand } from "../../contracts/harness-updates.js"
import { CLAUDE_VERSIONS } from "./versions.js"

export type ClaudeRuntime =
  | { kind: "configured"; executable: string }
  | { kind: "bundled"; executable: string }
  /**
   * The SDK's own build, installed by Mako beside the host rather than with it (`claudeInstall`): a host made without
   * Claude among its harnesses carries no build, and Settings installs this one. The same build the SDK would choose,
   * which it's told the path of, as it can't find it from where it's installed.
   */
  | { kind: "installed"; executable: string }

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
  if (executable) return { kind: "bundled", executable }
  const installed = installedClaudeExecutable()
  return installed ? { kind: "installed", executable: installed } : null
}

/** The SDK's version, whose build sessions run: an installed build of another version isn't it. */
const SDK_VERSION = CLAUDE_VERSIONS.bundled?.version

/** Where Mako installs the SDK's build when the host has none (`claudeInstall`). */
export function claudeInstallRoot(): string {
  return join(homedir(), ".local", "share", "mako", "claude-code")
}

/** Whether `executable` is the SDK's own build that Mako installed (`claudeInstall`), not one configured elsewhere. */
export function installedClaudeBuild(executable: string): boolean {
  return executable === installedClaudeExecutable()
}

/** The build `claudeInstall` put in place, when it is the SDK's own version. */
function installedClaudeExecutable(): string | null {
  for (const name of bundledPackages()) {
    const folder = join(claudeInstallRoot(), "node_modules", "@anthropic-ai", `claude-agent-sdk-${name}`)
    const executable = join(folder, onWindows() ? "claude.exe" : "claude")
    try {
      if (JSON.parse(readFileSync(join(folder, "package.json"), "utf8")).version === SDK_VERSION && existsSync(executable)) return executable
    } catch {
      // Not installed, or not readable: the next name, or none.
    }
  }
  return null
}

/**
 * Installs the SDK's build for this machine, the platform package npm would have installed beside the SDK, into
 * `claudeInstallRoot`: what Settings offers on a host made without Claude. None where the SDK ships no build.
 */
export function claudeInstall(): HarnessUpdateCommand[] {
  if (!SDK_VERSION) return []
  const name = bundledPackages().find((each) => each.endsWith("-musl") === (onLinux() && muslRuntime())) ?? bundledPackages()[0]
  if (!name) return []
  return [{
    label: "Install with npm",
    command: "npm",
    args: ["install", "--prefix", claudeInstallRoot(), "--no-save", "--no-audit", "--no-fund", `@anthropic-ai/claude-agent-sdk-${name}@${SDK_VERSION}`],
  }]
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

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { HarnessUpdateInfo } from "../contracts/harness-updates.js"
import type { ProviderCapability } from "./registry.js"

const run = promisify(execFile)

export interface ProviderUpdateSource extends ProviderCapability {
  check(env: NodeJS.ProcessEnv): Promise<HarnessUpdateInfo>
}

interface CliUpdateOptions {
  /** Resolve the binary the driver actually launches. */
  binary(env: NodeJS.ProcessEnv): string | null | Promise<string | null>
  /** Arguments that print the installed version. */
  versionArgs?: string[]
  /** The npm package, when the CLI publishes one — feeds `latest` and the npm update path. */
  npmPackage?: string
  /** The CLI's own updater, used when the binary lives in a self-managed home. */
  selfUpdate?: { command: string; args: string[]; label: string }
  /** Path fragments meaning another app owns this install, e.g. Zed's registry. */
  managedBy?: [needle: string, owner: string][]
}

const VERSION_ARGS = ["--version"]

function parseVersion(output: string): string | undefined {
  return output.match(/\d+(?:\.\d+)+(?:[-.\w]*)?/)?.[0]
}

async function commandVersion(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<string | undefined> {
  try {
    const { stdout } = await run(binary, args, {
      env,
      timeout: 8_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    })
    return parseVersion(stdout)
  } catch {
    return undefined
  }
}

async function npmLatest(
  pkg: string,
  env: NodeJS.ProcessEnv
): Promise<string | undefined> {
  try {
    const { stdout } = await run("npm", ["view", pkg, "version"], {
      env,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * One check for CLI runtimes: which binary the driver would launch, what it
 * reports as its version, who owns updates (app bundle, Zed's registry, brew,
 * the CLI's own updater, or npm), and what the public latest is.
 */
export function cliUpdateSource(
  provider: string,
  options: CliUpdateOptions
): ProviderUpdateSource {
  return {
    provider,
    async check(env) {
      const binary = await options.binary(env)
      if (!binary) return {}
      const info: HarnessUpdateInfo = { binary }
      info.installed = await commandVersion(
        binary,
        options.versionArgs ?? VERSION_ARGS,
        env
      )
      const managed = options.managedBy?.find(([needle]) => binary.includes(needle))
      const app = binary.match(/\/([^/]+\.app)\/Contents\//)
      if (managed) {
        info.channel = "managed"
        info.managedBy = managed[1]
      } else if (app) {
        info.channel = "app"
        info.managedBy = app[1]
      } else if (binary.includes("Cellar") || binary.startsWith("/opt/homebrew")) {
        info.channel = "brew"
        if (options.npmPackage)
          info.update = {
            label: "Update with Homebrew",
            command: "brew",
            args: ["upgrade", options.npmPackage.split("/").pop()!],
          }
      } else if (options.selfUpdate) {
        info.channel = "self"
        info.update = options.selfUpdate
      } else if (options.npmPackage) {
        info.channel = "npm"
        info.update = {
          label: "Update with npm",
          command: "npm",
          args: ["install", "-g", options.npmPackage],
        }
      }
      if (options.npmPackage)
        info.latest = await npmLatest(options.npmPackage, env)
      return info
    },
  }
}

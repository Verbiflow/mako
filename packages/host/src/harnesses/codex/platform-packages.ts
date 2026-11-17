import { nodePlatform } from "../../base/platform.js"

/** The platforms `@openai/codex` ships a binary package for, as its `optionalDependencies` name them. */
const CODEX_PLATFORMS = new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"])

/**
 * This machine's Codex binary package at `version`, as `@openai/codex` names
 * it: `@openai/codex-<platform>`, an alias of `@openai/codex@<version>-<platform>`.
 * Installed beside the CLI by the same command, so a download npm would skip
 * as optional fails the install instead (`RuntimeUpdateSource.npmCompanions`).
 */
export function codexPlatformPackages(version: string, platform: string = nodePlatform(), arch: string = process.arch): string[] {
  const target = `${platform}-${arch}`
  return CODEX_PLATFORMS.has(target) ? [`@openai/codex-${target}@npm:@openai/codex@${version}-${target}`] : []
}

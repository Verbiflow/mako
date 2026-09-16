import type { ProviderCapability } from "./registry.js"

/**
 * What a provider knows about the runtime it launches, stated once.
 *
 * The provider says where its binary is, which package publishes it and
 * which updaters exist. `electron/runtime-updates.ts` does the rest for every
 * provider alike: reads the installed version, places the binary's real path
 * on one channel (npm, bun, pnpm, Homebrew, the CLI's own installer, an app
 * bundle, another app's registry), asks the registry what is current, runs
 * the update and tells discovery the binary changed. A provider never
 * spawns `npm` or reads a version itself.
 */
export interface ProviderUpdateSource extends ProviderCapability {
  /** Resolve the binary the driver actually launches. */
  binary(env: NodeJS.ProcessEnv): string | null | Promise<string | null>
  /** Arguments that print the installed version. Default `--version`. */
  versionArgs?: string[]
  /** The npm package, when the CLI publishes one: feeds `latest` and the npm, bun and pnpm plans. */
  npmPackage?: string
  /** The Homebrew formula or cask, when the CLI ships one. Without it a brew install is shown, never upgraded. */
  homebrew?: { name: string; cask?: boolean }
  /**
   * The CLI's own updater, and the install root its installer owns. Chosen
   * only when the binary's path is inside that root: the same `claude` from
   * npm updates through npm, and `claude update` would refuse it.
   */
  native?: {
    label: string
    args: string[]
    ownsPath(path: string): boolean
  }
  /** Path fragments meaning another app owns this install, e.g. Zed's registry. */
  managedBy?: [needle: string, owner: string][]
}

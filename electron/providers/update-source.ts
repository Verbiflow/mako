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
export interface RuntimeUpdateSource {
  /** Stable installation key within this provider. */
  id?: string
  label?: string
  description?: string
  primary?: boolean
  /** Require the verified release, including for package-manager updates. */
  pinVersion?: boolean
  /** Resolve release policy from the version the host read, never from a filename. */
  release?(version: string, binary: string, real: string): RuntimeRelease

  /** Resolve the binary the driver actually launches. */
  binary(env: NodeJS.ProcessEnv): string | null | Promise<string | null>
  /** Arguments that print the installed version. Default `--version`. */
  versionArgs?: string[]
  /** The npm package, when the CLI publishes one: feeds `latest` and the npm, bun and pnpm plans. */
  npmPackage?: string
  npmTag?: string
  githubRelease?: string
  acceptsLatest?(installed: string, latest: string): boolean
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
    /** Never run a moving channel target; require a verified public version. */
    pinVersion?: boolean
  }
  /** Path fragments meaning another app owns this install, e.g. Zed's registry. */
  managedBy?: [needle: string, owner: string][]
}

export type RuntimeRelease = Omit<
  RuntimeUpdateSource,
  "id" | "binary" | "release"
>

export interface ProviderUpdateSource
  extends ProviderCapability, RuntimeUpdateSource {
  /** Other installations of the same provider, independently checked and updated. */
  installations?: RuntimeUpdateSource[]
}

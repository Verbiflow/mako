import type { HarnessUpdateCommand } from "../contracts/harness-updates.js"
import type { HarnessVersions } from "../contracts/harness-versions.js"
import type { ProviderCapability } from "./registry.js"

/**
 * What a provider knows about the runtime it launches, stated once.
 *
 * The provider says where its binary is, which package publishes it and
 * which updaters exist. `packages/host/src/harnesses/runtime-updates.ts` does the rest for every
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
  /**
   * The versions Mako runs: the oldest its client speaks, the newest its
   * session flows passed on, and the version each shared feature needs.
   * Declaring them pins every install and Update to `tested`
   * (`pinnedPolicy`), unless sessions run a `bundled` build. An
   * installation without its own inherits its provider's.
   */
  versions?: HarnessVersions
  /**
   * Whether an installed version is older than `versions.oldest`, for a
   * harness whose builds aren't ordered by version number. Default: the
   * ordinary version comparison.
   */
  belowOldest?(version: string): boolean
  /** Supported installed versions. Retired versions are omitted from Settings, including cached readings. */
  supportsVersion?(version: string): boolean
  /** Resolve release policy from the version the host read, never from a filename. */
  release?(
    version: string,
    binary: string,
    real: string,
    env: NodeJS.ProcessEnv
  ): RuntimeRelease
  /** Provider updater subprocess dependencies, resolved in desktop environments too. */
  updateEnvironment?(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv

  /** Resolve the binary the driver actually launches. */
  binary(env: NodeJS.ProcessEnv): string | null | Promise<string | null>
  /** Arguments that print the installed version. Default `--version`. */
  versionArgs?: string[]
  /** The npm package, when the CLI publishes one: feeds `latest` and the npm, bun and pnpm plans. */
  npmPackage?: string
  /** The dist-tag, or the exact version, the registry answers as current. Default `latest`. */
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
    /**
     * The command that installs one exact version, for a CLI whose own
     * updater only goes to the vendor's newest (Grok's `update`). Without
     * it a pinned update passes the version to `args`, as `opencode upgrade
     * <version>` takes it.
     */
    installVersion?(version: string): HarnessUpdateCommand
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
  /**
   * How to install the CLI when no binary is found, most preferred first.
   * Settings offers the first plan whose command exists on this machine, so
   * every install must land where `binary` looks. Empty only when the
   * provider needs no local CLI.
   */
  install: HarnessUpdateCommand[]
}

/**
 * The vendor's documented `curl … | bash` installer; pipefail so a failed
 * download fails the install. `version` is passed to the script, for an
 * installer that takes one (`bash -s 1.0.46`).
 */
export function scriptInstall(url: string, version?: string): HarnessUpdateCommand {
  if (version !== undefined && !/^[\w.+-]+$/.test(version))
    throw new Error(`${version} is not a version an installer can take`)
  return {
    label: "Install",
    command: "/bin/bash",
    args: ["-o", "pipefail", "-c", `curl -fsSL ${url} | bash${version === undefined ? "" : ` -s ${version}`}`],
  }
}

/**
 * The update policy a declaration of versions implies: the registry is
 * asked for `tested` exactly, only `tested` is accepted as current, and
 * every update, the CLI's own included, goes there and never lower. A
 * source whose sessions run a bundled build keeps its own policy, since its
 * binary is the person's CLI.
 */
export function pinnedPolicy<T extends RuntimeUpdateSource>(source: T): T {
  const versions = source.versions
  if (!versions || versions.bundled) return source
  const { tested } = versions
  return {
    ...source,
    pinVersion: true,
    npmTag: source.npmTag ?? tested,
    acceptsLatest: source.acceptsLatest ?? ((_installed: string, latest: string) => latest === tested),
    native: source.native && { ...source.native, pinVersion: true },
  }
}

export function npmInstall(name: string, version = "latest"): HarnessUpdateCommand {
  return { ...npmUpdate(`${name}@${version}`), label: "Install with npm" }
}

/**
 * npm 12 blocks install scripts by default and still exits 0, so a package
 * whose postinstall finishes the install (Claude copies its native binary
 * over a stub) is left broken while the update reports success. This one
 * package's scripts are allowed; npm 11 accepts the flag silently.
 */
export function npmUpdate(name: string): HarnessUpdateCommand {
  return {
    label: "Update with npm",
    command: "npm",
    args: [
      "install",
      "-g",
      `--allow-scripts=${name.slice(0, name.lastIndexOf("@"))}`,
      name,
    ],
  }
}

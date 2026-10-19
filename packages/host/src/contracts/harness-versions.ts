import { z } from "zod"
import type { HarnessFeatureKey } from "./harness-features.js"
import { compareVersions, parseVersion } from "./runtime-version.js"

/**
 * Which versions of a harness Mako runs, stated once on its `updates`
 * source, and what the window reads of it.
 *
 * Mako runs the version a person has, from `oldest` up, and never moves
 * anyone back. Its installs and its Update go to `tested`; a newer install
 * is kept and run, and Settings › Agents notes it quietly in the row's
 * secondary text. Below `oldest` is the only case that stops a session, and
 * a version Mako couldn't read never stops one.
 */
export interface HarnessVersions {
  /**
   * The oldest version whose protocol Mako's client speaks, proven by the
   * session flows passing against that build. Left out when nothing proves
   * one: then no installed version is refused.
   */
  oldest?: string
  /** The newest version the session flows passed on. Installs and Update go here and never lower. */
  tested: string
  /** When `tested` (and `oldest`, when declared) were last checked, and how. */
  checked: { on: string; how: string }
  /**
   * Where the vendor publishes its releases, which the daily bump job
   * (`scripts/bump-harness-versions.ts`) reads: an npm package, or a
   * manifest whose `version` is the newest. For a bundled runtime, the
   * bundled package.
   */
  feed: { npm: string } | { manifest: string }
  /**
   * Sessions run a build that ships in Mako's lockfile, so `tested` is that
   * build's and no install is pinned: the binary Settings updates is the
   * person's own CLI, left on its vendor's updates.
   */
  bundled?: {
    package: string
    version: string
    /**
     * When npm published `version`, as its `time` says: where the bundled
     * build stands among the builds of a program whose stores it imports.
     */
    released?: string
    /**
     * A program of the harness whose stores the bundled build continues by
     * importing them, numbered by the day each build was made
     * (`cursor-agent`). Its records are compared with the bundled build
     * placed on that numbering by `released`: a build made after the bundled
     * one was published may write what it doesn't know.
     */
    imports?: string
  }
  /**
   * Where the dates the vendor published each release are read, for sessions
   * whose records name no writer and whose harness left no log or install
   * that does (`ReleaseTimelines`, `@mako/sessions/record-releases`).
   */
  releases?: { npm: string }
  /**
   * A shared feature a later release added: the version it needs and how
   * that's known. Declared only with evidence (release notes, the generated
   * protocol of an older build); where the ACP handshake advertises what a
   * harness supports, that answers instead of a version.
   */
  features?: Partial<Record<HarnessFeatureKey, { version: string; evidence: string }>>
}

/** Where an installed version stands against its harness's declaration. */
export const VersionStandingSchema = z.enum([
  /** Older than Mako's client speaks: the one case that stops a session. */
  "below-oldest",
  /** From `oldest` up to `tested`: runs, and Update is offered. */
  "supported",
  "tested",
  /** Newer than Mako has tested: runs, with no warning anywhere but a quiet line in Settings. */
  "newer",
])
export type VersionStanding = z.infer<typeof VersionStandingSchema>

/** What the window reads of a runtime's declaration, beside its reading. Absent when the version is unreadable. */
export const RuntimeVersionsSchema = z.object({
  oldest: z.string().optional(),
  tested: z.string(),
  standing: VersionStandingSchema,
  /** Each shared feature this installation is too old for, with the version it needs. */
  needs: z.record(z.string(), z.string()).optional(),
})
export type RuntimeVersions = z.infer<typeof RuntimeVersionsSchema>

/**
 * Where `installed` stands. `belowOldest` replaces the ordinal comparison
 * for a harness whose builds aren't ordered by version (OpenCode's dev and
 * beta builds count builds), so the floor is the same rule its launch uses.
 */
export function versionStanding(
  installed: string,
  versions: Pick<HarnessVersions, "oldest" | "tested">,
  belowOldest?: (installed: string) => boolean
): VersionStanding {
  const below = belowOldest
    ? belowOldest(installed)
    : versions.oldest !== undefined && compareVersions(installed, versions.oldest) < 0
  if (below) return "below-oldest"
  const order = compareVersions(installed, versions.tested)
  return order > 0 ? "newer" : order === 0 ? "tested" : "supported"
}

/** Each declared feature `installed` is older than, with the version it needs. */
export function featureNeeds(
  installed: string,
  versions: Pick<HarnessVersions, "features">
): Partial<Record<HarnessFeatureKey, string>> | undefined {
  // SAFETY: Object.entries of a Partial<Record<HarnessFeatureKey, …>> yields only its keys.
  const entries = Object.entries(versions.features ?? {}) as [HarnessFeatureKey, { version: string }][]
  const needs = entries.filter(([, floor]) => compareVersions(installed, floor.version) < 0)
  return needs.length ? Object.fromEntries(needs.map(([key, floor]) => [key, floor.version])) : undefined
}

/** A runtime's declaration as the window reads it, or nothing when its version is unknown. */
export function runtimeVersions(
  installed: string | undefined,
  versions: HarnessVersions | undefined,
  belowOldest?: (installed: string) => boolean
): RuntimeVersions | undefined {
  if (!installed || !versions || versions.bundled) return undefined
  const reading: RuntimeVersions = { tested: versions.tested, standing: versionStanding(installed, versions, belowOldest) }
  if (versions.oldest !== undefined) reading.oldest = versions.oldest
  const needs = featureNeeds(installed, versions)
  if (needs) reading.needs = needs
  return reading
}

/**
 * Whether a session saved under one runtime version may continue under
 * another. Both at or above the declared oldest: the client speaks both, as
 * the session flows proved at the floor. Without a floor, a change stays
 * unproven.
 */
export function versionsCompatible(from: string, to: string, oldest: string | undefined): boolean {
  if (compareVersions(from, to) === 0) return true
  if (oldest === undefined) return false
  return compareVersions(from, oldest) >= 0 && compareVersions(to, oldest) >= 0
}

/** The sentence a below-oldest runtime gets, wherever it's said. */
export function belowOldestText(label: string, installed: string, oldest: string | undefined): string {
  return oldest
    ? `${label} ${installed} is older than Mako supports. Mako needs ${oldest} or newer.`
    : `${label} ${installed} is older than Mako supports.`
}

/** The version a cloud machine installs to restore a session, and why that one (`cloudRuntime`). */
export interface CloudRuntime {
  version: string
  /**
   * `wrote`: the newest version that wrote the session's records; `laptop`:
   * the laptop's install, newer than that; `oldest`: both were older than
   * Mako's client speaks; `tested`: neither is known, so the image's own;
   * `bundled`: sessions run the build Mako ships, so the machine runs Mako's.
   */
  why: "wrote" | "laptop" | "oldest" | "tested" | "bundled"
}

/**
 * Which version of a harness a cloud machine installs before it restores a
 * session there: the newest version that wrote the session's records
 * (`newestWriter` in `@mako/sessions/record-writers`), or the laptop's if
 * that's newer, so the records always go into the same version or a newer
 * one (`restoreGate`) and a session moved back finds what it left; never
 * below `oldest`. With neither known, `tested`, what images install. A
 * harness whose sessions run a build Mako ships has no choice to make: the
 * machine runs Mako's, and a newer writer waits for a newer Mako there as
 * on a laptop.
 */
export function cloudRuntime(versions: Pick<HarnessVersions, "oldest" | "tested" | "bundled">, wrote: string | null, laptop: string | null): CloudRuntime {
  if (versions.bundled) return { version: versions.tested, why: "bundled" }
  const known = (version: string | null) => (version && parseVersion(version) === version.trim().replace(/^v/i, "") ? version.trim().replace(/^v/i, "") : null)
  const writer = known(wrote)
  const local = known(laptop)
  const newest = writer && local ? (compareVersions(local, writer) > 0 ? { version: local, why: "laptop" as const } : { version: writer, why: "wrote" as const })
    : writer ? { version: writer, why: "wrote" as const }
      : local ? { version: local, why: "laptop" as const }
        : null
  if (!newest) return { version: versions.tested, why: "tested" }
  if (versions.oldest !== undefined && compareVersions(newest.version, versions.oldest) < 0) return { version: versions.oldest, why: "oldest" }
  return newest
}

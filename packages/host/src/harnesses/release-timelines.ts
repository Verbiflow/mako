import { npmReleaseTimeline, NpmTimesSchema, npmTimelineKey, readReleaseTimelines, writeReleaseTimeline, type NpmTimes } from "@mako/sessions/record-releases"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { ProviderUpdateSource } from "./update-source.js"
import { registryJson } from "./registry-fetch.js"

/**
 * Each harness's release dates, as its registry publishes them
 * (`HarnessVersions.releases`), kept for the record store's evidence pass in
 * `records/evidence/releases.json` (`@mako/sessions/record-releases`). Read
 * at most once a day, with the deadline every public reading has
 * (`registryJson`), and never waited on: the pass reads whatever the file
 * holds, and a session it couldn't bound is looked at again once a newer
 * timeline lands.
 */

const DAY_MS = 24 * 60 * 60 * 1000
/** A packument with every version's metadata: Grok's is about 400 KB. */
const PACKUMENT_LIMIT = 4 * 1024 * 1024

export interface ReleaseTimelinesOptions {
  /** The record store's evidence folder. */
  evidence: string
  sources: () => ProviderUpdateSource[]
  /** When the registry says each version of a package was published, injectable for tests. */
  packument?: (npmPackage: string) => Promise<NpmTimes>
  now?: () => number
}

export class ReleaseTimelines {
  private refreshing: Promise<void> | null = null
  private readonly options: ReleaseTimelinesOptions

  constructor(options: ReleaseTimelinesOptions) {
    this.options = options
  }

  /** Reads every declared timeline older than a day; concurrent callers share the pass. */
  refresh(): Promise<void> {
    this.refreshing ??= this.read().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async read(): Promise<void> {
    const now = this.options.now?.() ?? Date.now()
    const kept = readReleaseTimelines(this.options.evidence)
    const packages = new Set(this.options.sources().flatMap((source) => source.versions?.releases?.npm ?? []))
    for (const npmPackage of packages) {
      const key = npmTimelineKey(npmPackage)
      const held = kept[key]
      if (held && now - held.checkedAt < DAY_MS) continue
      try {
        const packument = await (this.options.packument ?? npmPackument)(npmPackage)
        const timeline = npmReleaseTimeline(npmPackage, packument, now)
        writeReleaseTimeline(this.options.evidence, key, timeline)
        hostLog("records", "release dates read", { package: npmPackage, releases: timeline.releases.length })
      } catch (error) {
        hostWarn("records", "release dates couldn't be read", { package: npmPackage, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
}

function npmPackument(npmPackage: string): Promise<NpmTimes> {
  return registryJson(`https://registry.npmjs.org/${npmPackage.replace("/", "%2F")}`, NpmTimesSchema, { limit: PACKUMENT_LIMIT, what: "npm registry" })
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { z } from "zod"
import { statedVersion } from "./record-writers.js"
import { compareVersions } from "./runtime-version.js"

/**
 * When a vendor published each release of a harness, as its public registry
 * says, for sessions whose records name no writer and whose harness left no
 * log or install that does (`record-evidence.ts`). A build can't write a
 * session before it was published, so the newest release published before a
 * session's last write is the newest that could have written it: a `range`
 * whose `bound` is `releases`.
 *
 * The host reads each timeline from the registry at most once a day, with
 * the same deadline as its public version reading (`RuntimeUpdates`), and
 * keeps it in `records/evidence/releases.json`; the backfill's pass only
 * reads that file, so nothing waits on the network.
 */

export const RELEASES_FILE = "releases.json"

const ReleaseSchema = z.object({ version: z.string(), at: z.number() })
const TimelineSchema = z.object({
  /** Where it was read: `npm:<package>`. */
  source: z.string(),
  /** When the registry was last read: a release published after it isn't in `releases` yet. */
  checkedAt: z.number(),
  releases: z.array(ReleaseSchema),
})
export type ReleaseTimeline = z.infer<typeof TimelineSchema>

const TimelinesSchema = z.record(z.string(), TimelineSchema)
export type ReleaseTimelines = z.infer<typeof TimelinesSchema>
/** The file: its timelines, and whatever else a newer Mako keeps in it, carried through a rewrite. */
const ReleasesFileSchema = z.object({ version: z.literal(1), timelines: TimelinesSchema.catch({}) }).loose()

function readFile(file: string): z.infer<typeof ReleasesFileSchema> {
  try {
    return ReleasesFileSchema.parse(JSON.parse(readFileSync(file, "utf8")))
  } catch {
    return { version: 1, timelines: {} }
  }
}

/** The timelines kept beside the record store's other evidence, or none when there's no file yet. */
export function readReleaseTimelines(evidence: string): ReleaseTimelines {
  return readFile(join(evidence, RELEASES_FILE)).timelines
}

/** Keeps `timeline` under `key` (`npm:<package>`), beside the others, replacing the file whole. */
export function writeReleaseTimeline(evidence: string, key: string, timeline: ReleaseTimeline): void {
  const file = join(evidence, RELEASES_FILE)
  const kept = readFile(file)
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ ...kept, timelines: { ...kept.timelines, [key]: timeline } }))
  renameSync(temporary, file)
}

/** What a timeline reads of an npm packument: when each version was published (and `created`, `modified`). */
export const NpmTimesSchema = z.object({ time: z.record(z.string(), z.string()) })
export type NpmTimes = z.infer<typeof NpmTimesSchema>

/** An npm packument's `time` as a timeline: every version, prereleases too, with when it was published. */
export function npmReleaseTimeline(npmPackage: string, packument: NpmTimes, checkedAt: number): ReleaseTimeline {
  const releases = Object.entries(packument.time).flatMap(([version, at]) => {
    const stated = statedVersion(version)
    const time = Date.parse(at)
    return stated && Number.isFinite(time) ? [{ version: stated, at: time }] : []
  })
  return { source: `npm:${npmPackage}`, checkedAt, releases: releases.sort((a, b) => a.at - b.at) }
}

/** The key a harness's npm timeline is kept under. */
export function npmTimelineKey(npmPackage: string): string {
  return `npm:${npmPackage}`
}

/**
 * A day's margin past the last write: a vendor's own installer may serve a
 * build some hours before its registry publishes it. On this Mac, Grok's
 * builds 0.2.93, 1.0.3, 1.0.4 and 1.0.46 were each installed after npm
 * published them.
 */
export const RELEASE_MARGIN_MS = 24 * 60 * 60 * 1000

export type ReleaseBound = { ok: true; upTo: string; newest: { version: string; at: number } } | { ok: false; why: string }

/**
 * The newest version `timeline` had published by `last` (plus the margin),
 * prereleases included, ordered by version rather than by date, since a
 * patch to an older line can be published after a newer release. Refused
 * when the timeline was read before then, so a release it doesn't list yet
 * could be newer.
 */
export function releaseBound(timeline: ReleaseTimeline | undefined, last: number, margin = RELEASE_MARGIN_MS): ReleaseBound {
  if (!timeline) return { ok: false, why: "Mako hasn't read its release dates yet" }
  const until = last + margin
  if (timeline.checkedAt < until) return { ok: false, why: `its release dates (${timeline.source}) were read ${new Date(timeline.checkedAt).toISOString()}, before ${new Date(until).toISOString()}` }
  const published = timeline.releases.filter((release) => release.at <= until)
  if (!published.length) return { ok: false, why: `${timeline.source} lists no release published by ${new Date(until).toISOString()}` }
  const newest = published.reduce((best, release) => (compareVersions(release.version, best.version) > 0 ? release : best))
  return { ok: true, upTo: newest.version, newest }
}

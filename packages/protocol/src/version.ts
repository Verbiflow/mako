import { z } from "zod"

/**
 * The version every envelope carries (`v` on operations, replies and events). Each side checks it exactly, so it
 * changes only when an envelope does; what a link adds goes in `LINK_VERSION`, which links negotiate.
 */
export const PROTOCOL_VERSION = 1

/**
 * The newest version of a runtime's link this build speaks, agreed at enrolment. 2 adds the runtime's `activity`
 * frame: whether it's working on a Thread, which keeps the Thread's machine running, and nothing else does. 3 adds
 * media (`media.ts`): live streams its clients watch, as binary messages beside the frames. Every envelope stays at
 * `PROTOCOL_VERSION` on every link version.
 */
export const LINK_VERSION = 3

/** The first link version a runtime may send `activity` on; a gateway that agreed less never sees one. */
export const ACTIVITY_VERSION = 2

/** The first link version a gateway may ask a runtime for media on; a runtime that agreed less is never asked. */
export const MEDIA_VERSION = 3

/**
 * The link versions this build can speak. A gateway keeps older versions working for runtimes that wake
 * weeks after they paused; raise `min` only when no supported runtime needs the old one.
 */
export const SUPPORTED_VERSIONS = { min: 1, max: LINK_VERSION } as const

export const VersionRangeSchema = z
  .object({
    min: z.number().int().positive(),
    max: z.number().int().positive(),
  })
  .strict()
  .refine((range) => range.min <= range.max, "min is above max")

export type VersionRange = z.infer<typeof VersionRangeSchema>

/** The highest version both sides speak, or null when the ranges don't meet. */
export function negotiate(
  ours: VersionRange,
  theirs: VersionRange
): number | null {
  const version = Math.min(ours.max, theirs.max)
  return version >= Math.max(ours.min, theirs.min) ? version : null
}

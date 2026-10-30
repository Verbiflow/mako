import { z } from "zod"

/**
 * The version every envelope carries (`v` on operations, replies and events). Each side checks it exactly, so it
 * changes only when an envelope does; what a link adds goes in `LINK_VERSION`, which links negotiate.
 */
export const PROTOCOL_VERSION = 1

/**
 * The newest version of a runtime's link this build speaks, agreed at enrolment. 2 adds the runtime's `activity`
 * frame: whether it's working on a Thread, which keeps the Thread's machine running, and nothing else does. 3 adds
 * media (`media.ts`): live streams its clients watch, as binary messages beside the frames. 4 added a `listing` frame
 * keyed by cloud Thread, which a gateway takes and drops. 5 adds the runtime's `sessions` frame: its Sessions as the
 * account's list shows them, keyed by Mako's own IDs under the one-owner rule (`thread-listing.ts`). 6 lets a `sessions` row name its native
 * session, and list one Mako hasn't opened (a terminal's), with how its owner opens it. 7 adds `port-open`: a request to
 * an app the runtime serves on one of its ports, answered on a media stream (`ports.ts`). 8 adds `going-quiet`: the runtime
 * says it's going away on purpose (sleep, quit, sign-out) before it goes. 9 numbers what a runtime sends of a watched
 * conversation (`live`'s `n`), so a gateway takes a resend once and says on a new link what it last relayed (`watch`'s
 * `after`), and lets `live` carry a trace (`correlationId`) and `sessions` say when each row changed and when it was
 * reported (`changedAt`, `reportedAt`). 10 lets a `sessions` row say what a waiting Session waits on the person for
 * (`waitingFor`: an approval, a question, or anything else). 11 lets a `sessions` row say that its Thread is on its way
 * between a device and the cloud, and how far (`move`). Every envelope stays at `PROTOCOL_VERSION` on every link version.
 */
export const LINK_VERSION = 11

/** The first link version a runtime may send `activity` on; a gateway that agreed less never sees one. */
export const ACTIVITY_VERSION = 2

/** The first link version a gateway may ask a runtime for media on; a runtime that agreed less is never asked. */
export const MEDIA_VERSION = 3

/** The link version whose `listing` frame a gateway takes and drops: runtimes from 2026-10-24 that speak 4 send it. */
export const LISTING_VERSION = 4

/** The first link version a runtime may send `sessions` on; a gateway that agreed less never sees one. */
export const SESSIONS_VERSION = 5

/** The first link version a `sessions` row may carry `nativeId` and `capture` on: a gateway that agreed less refuses them. */
export const NATIVE_SESSIONS_VERSION = 6

/** The first link version a gateway may send `port-open` on; a runtime that agreed less is never asked. */
export const PORTS_VERSION = 7

/** The first link version a runtime may send `going-quiet` on; a gateway that agreed less never sees one. */
export const QUIET_VERSION = 8

/**
 * The first link version whose `live` frames carry the runtime's number (`n`) and a trace, whose `watch` says what was
 * last relayed of each conversation (`after`), and whose `sessions` rows say when they changed (`changedAt`) and when the
 * report went (`reportedAt`). A gateway that agreed less refuses all four.
 */
export const NUMBERED_LIVE_VERSION = 9

/** The first link version whose `sessions` rows say what a waiting Session waits on (`waitingFor`); a gateway that agreed less refuses it. */
export const WAITING_FOR_VERSION = 10

/** The first link version whose `sessions` rows say a Thread on its way between a device and the cloud (`move`); a gateway that agreed less refuses it. */
export const MOVES_VERSION = 11

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

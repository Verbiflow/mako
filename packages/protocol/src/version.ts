import { z } from "zod"

/** The version this build speaks when it starts a conversation. */
export const PROTOCOL_VERSION = 1

/**
 * The versions this build can speak. A gateway keeps older versions working for runtimes that wake
 * weeks after they paused; raise `min` only when no supported runtime needs the old one.
 */
export const SUPPORTED_VERSIONS = { min: 1, max: PROTOCOL_VERSION } as const

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

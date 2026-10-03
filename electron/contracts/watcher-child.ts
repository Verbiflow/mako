import { z } from "zod"

/**
 * A point in the file system's history (FSEvents on macOS), as parcel's
 * snapshot file holds it: the event id, and the time in nanoseconds. Both
 * are past what a double holds exactly, so they stay digits.
 */
export const HistoryMarkSchema = z.object({ id: z.string().regex(/^\d+$/), at: z.string().regex(/^\d+$/) }).strict()
export type HistoryMark = z.infer<typeof HistoryMarkSchema>

/** What the host asks of the watcher child. Ids are the host's and never reused. */
export const WatcherRequestSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("sub"), id: z.number().int(), root: z.string(), ignore: z.array(z.string()) }),
  z.object({ t: z.literal("unsub"), id: z.number().int() }),
  /** Where the history stands now. */
  z.object({ t: z.literal("mark"), id: z.number().int() }),
  /** Every path under each root changed after `mark`, one root at a time. */
  z.object({ t: z.literal("since"), id: z.number().int(), mark: HistoryMarkSchema, roots: z.array(z.string()) }),
])
export type WatcherRequest = z.infer<typeof WatcherRequestSchema>

export const WatchEventSchema = z.object({ path: z.string(), type: z.enum(["create", "update", "delete"]) })
export type WatchEvent = z.infer<typeof WatchEventSchema>

export const WatcherReplySchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("ready"), id: z.number().int() }),
  z.object({ t: z.literal("failed"), id: z.number().int(), message: z.string() }),
  z.object({ t: z.literal("events"), id: z.number().int(), events: z.array(WatchEventSchema) }),
  z.object({ t: z.literal("dropped"), id: z.number().int() }),
  /** Whether the child's own canary is heard: false once it misses twice running, true when it's heard again. */
  z.object({ t: z.literal("delivery"), ok: z.boolean() }),
  z.object({ t: z.literal("marked"), id: z.number().int(), mark: HistoryMarkSchema }),
  /** `lost` roots had events dropped by the system, so their paths may be incomplete. */
  z.object({ t: z.literal("history"), id: z.number().int(), paths: z.array(z.string()), lost: z.array(z.string()) }),
])
export type WatcherReply = z.infer<typeof WatcherReplySchema>

/** `MAKO_WATCHER_CANARY_TEST`, for tests only: a shorter beat, and a canary that hears nothing while `deafWhile` exists. */
export const CanaryTestSchema = z.object({
  everyMs: z.number().int().positive().optional(),
  withinMs: z.number().int().positive().optional(),
  deafWhile: z.string().optional(),
})
export type CanaryTest = z.infer<typeof CanaryTestSchema>

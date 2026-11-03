import { z } from "zod"

/**
 * A point in the file system's history (FSEvents on macOS), as parcel's
 * snapshot file holds it: the event id, and the time in nanoseconds. Both
 * are past what a double holds exactly, so they stay digits.
 */
/** The folder under the temporary folder where the watcher child keeps the history marks it reads with. */
export const HISTORY_SCRATCH = "mako-history"

export const HistoryMarkSchema = z.object({ id: z.string().regex(/^\d+$/), at: z.string().regex(/^\d+$/) }).strict()
export type HistoryMark = z.infer<typeof HistoryMarkSchema>

/** What the host asks of the watcher child. Ids are the host's and never reused. */
export const WatcherRequestSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("sub"), id: z.number().int(), root: z.string(), ignore: z.array(z.string()) }),
  z.object({ t: z.literal("unsub"), id: z.number().int() }),
  /** Where the history stands now. */
  z.object({ t: z.literal("mark"), id: z.number().int() }),
  /**
   * Every path under each root changed after `mark`, one root at a time.
   * Paths in or under an `ignore` folder are counted per folder and left
   * out, so a busy machine's churn stays in the child. `exclude` folders
   * inside a root are left out by fseventsd itself, before they're sent,
   * stat-ed or counted: at most `MAX_EXCLUDED` of them per root.
   */
  z.object({ t: z.literal("since"), id: z.number().int(), mark: HistoryMarkSchema, roots: z.array(z.string()), ignore: z.array(z.string()), exclude: z.array(z.string()).optional() }),
])

/** FSEventStreamSetExclusionPaths ignores the whole list when it holds more than eight. */
export const MAX_EXCLUDED = 8
export type WatcherRequest = z.infer<typeof WatcherRequestSchema>

export const WatchEventSchema = z.object({ path: z.string(), type: z.enum(["create", "update", "delete"]) })
export type WatchEvent = z.infer<typeof WatchEventSchema>

/**
 * Who dropped events, as FSEvents says when it asks for a rescan: this
 * process didn't read them in time (`client`), the kernel's queue to
 * fseventsd overflowed (`kernel`), or fseventsd coalesced a burst
 * (`coalesced`).
 */
export const DropReasonSchema = z.enum(["client", "kernel", "coalesced"])
export type DropReason = z.infer<typeof DropReasonSchema>

export const WatcherReplySchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("ready"), id: z.number().int() }),
  z.object({ t: z.literal("failed"), id: z.number().int(), message: z.string() }),
  z.object({ t: z.literal("events"), id: z.number().int(), events: z.array(WatchEventSchema) }),
  z.object({ t: z.literal("dropped"), id: z.number().int(), reason: DropReasonSchema.optional() }),
  /**
   * Whether the child's own canary is heard: false once it goes unheard
   * twice running, true when it's heard again. `lagMs` is how late the
   * slowest of its recent beats arrived, sent again whenever it moves a
   * second either way.
   */
  z.object({ t: z.literal("delivery"), ok: z.boolean(), lagMs: z.number().nonnegative().optional() }),
  z.object({ t: z.literal("marked"), id: z.number().int(), mark: HistoryMarkSchema }),
  /**
   * `lost` roots had events dropped by the system, so their paths may be
   * incomplete. `ignored` counts paths per `ignore` folder, in its order.
   * `caughtUpMs` is the wait for the history to hold the read's own
   * sentinel, `readMs` the replays themselves.
   */
  z.object({
    t: z.literal("history"), id: z.number().int(), paths: z.array(z.string()), lost: z.array(z.string()), ignored: z.array(z.number().int()),
    caughtUpMs: z.number().nonnegative().optional(), readMs: z.number().nonnegative().optional(),
  }),
])
export type WatcherReply = z.infer<typeof WatcherReplySchema>

/** Delivery later than this is slow: said in the log and Diagnostics, never a reason to stop listening. */
export const SLOW_DELIVERY_MS = 5_000
/**
 * While delivery is slow, each watch also looks for changes itself this
 * often. An fseventsd that far behind was seen holding back one stream's
 * events for minutes while its canary's still came.
 */
export const CALM_POLL_MS = 15_000

/**
 * `MAKO_WATCHER_CANARY_TEST`, for tests only: a shorter beat, a canary that
 * hears nothing while `deafWhile` exists, and one that hears each beat
 * `lagMs` late, as an fseventsd that delivers in batches does.
 */
export const CanaryTestSchema = z.object({
  everyMs: z.number().int().positive().optional(),
  withinMs: z.number().int().positive().optional(),
  deafWhile: z.string().optional(),
  lagMs: z.number().int().positive().optional(),
})
export type CanaryTest = z.infer<typeof CanaryTestSchema>

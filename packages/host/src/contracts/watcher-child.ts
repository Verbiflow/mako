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
   * stat-ed or counted: at most `MAX_EXCLUDED` of them per root. With
   * `perFolder`, each folder one level into a root sends at most that many
   * paths, and one that had more is named in the reply's `capped`.
   */
  z.object({ t: z.literal("since"), id: z.number().int(), mark: HistoryMarkSchema, roots: z.array(z.string()), ignore: z.array(z.string()), exclude: z.array(z.string()).optional(), perFolder: z.number().int().positive().optional() }),
  /**
   * Every process on the machine as `ps` prints it (`pid ppid pgid rss lstart command`), read here so the spawn and
   * its wait leave the host's loop: the apps' marks and traces ask for it every few seconds while an app runs.
   */
  z.object({ t: z.literal("table"), id: z.number().int() }),
  /**
   * Only the processes of `runs` (each a group's leader and when it started), read, parsed and matched here: a look at
   * running apps needs a few dozen rows of a busy Mac's thousands, and parsing and matching all of them held the host's
   * loop. `self` is the host, never one of a run's processes.
   */
  z.object({ t: z.literal("members"), id: z.number().int(), self: z.number().int(), runs: z.array(z.object({ pid: z.number().int(), startedMs: z.number() })) }),
  /**
   * A probe that only reads the machine (`ps`, `lsof`, `sysctl`; the child refuses any other), run here so its spawn
   * never holds the host's loop (`HostProbes`). `cancel` ends one under way.
   */
  z.object({
    t: z.literal("run"),
    id: z.number().int(),
    file: z.string(),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    timeout: z.number().int().nonnegative().optional(),
    maxBuffer: z.number().int().positive().optional(),
  }),
  z.object({ t: z.literal("cancel"), id: z.number().int() }),
  /** How late a folder of the child's own hears `beats` writes, one after another: delivery measured now, not over the last minute. */
  z.object({ t: z.literal("probe"), id: z.number().int(), beats: z.number().int().positive().max(20) }),
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

/** A process as `ps` gives it: what a run's look reads of it. */
export const ProcessRowSchema = z.object({ pid: z.number().int(), ppid: z.number().int(), pgid: z.number().int(), rssKb: z.number(), startedMs: z.number(), command: z.string() })

export const WatcherReplySchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("table"), id: z.number().int(), text: z.string() }),
  z.object({ t: z.literal("members"), id: z.number().int(), rows: z.array(ProcessRowSchema) }),
  /** A probe's answer: its exit `code` (or `signal`), its output, and `failure` when it couldn't run or was cut short. */
  z.object({
    t: z.literal("ran"),
    id: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    code: z.number().int().nullable(),
    signal: z.string().nullable(),
    failure: z.object({ message: z.string(), code: z.string().optional() }).optional(),
    killed: z.boolean(),
  }),
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
  /** Each beat the canary hears, with how late: the host's read of fseventsd's health is taken over these. */
  z.object({ t: z.literal("beat"), lagMs: z.number().nonnegative() }),
  /** A probe's beats, how late each was heard; one never heard within the probe's wait is left out. */
  z.object({ t: z.literal("probed"), id: z.number().int(), lagsMs: z.array(z.number().nonnegative()) }),
  z.object({ t: z.literal("marked"), id: z.number().int(), mark: HistoryMarkSchema }),
  /**
   * `lost` roots had events dropped by the system, so their paths may be
   * incomplete. `ignored` counts paths per `ignore` folder, in its order.
   * `caughtUpMs` is the wait for the history to hold the read's own
   * sentinel, `readMs` the replays themselves.
   */
  z.object({
    t: z.literal("history"), id: z.number().int(), paths: z.array(z.string()), lost: z.array(z.string()), ignored: z.array(z.number().int()),
    /** Folders past `perFolder`, and how many paths they left unsent. */
    capped: z.array(z.string()).optional(), unsent: z.number().int().nonnegative().optional(),
    caughtUpMs: z.number().nonnegative().optional(), readMs: z.number().nonnegative().optional(),
  }),
])
export type WatcherReply = z.infer<typeof WatcherReplySchema>

/**
 * Delivery later than this makes every watch poll as well. Far later than a
 * degraded fseventsd is said to be (`DEGRADED_LAG_MS` in
 * `file-events-service.ts`): this is when the watches stop trusting it.
 */
export const SLOW_DELIVERY_MS = 5_000
/**
 * While delivery is slow, each watch also looks for changes itself this
 * often. A degraded fseventsd was seen holding back one stream's events for
 * minutes while its canary's still came.
 */
export const CALM_POLL_MS = 15_000

/**
 * `MAKO_WATCHER_CANARY_TEST`, for tests only: a shorter beat, a canary that
 * hears nothing while `deafWhile` exists, and one that hears each beat (and
 * each probe's) `lagMs` late, as a degraded fseventsd delivers.
 */
export const CanaryTestSchema = z.object({
  everyMs: z.number().int().positive().optional(),
  withinMs: z.number().int().positive().optional(),
  deafWhile: z.string().optional(),
  lagMs: z.number().int().positive().optional(),
})
export type CanaryTest = z.infer<typeof CanaryTestSchema>

import { z } from "zod"

/**
 * How this device's Sessions stand in the account (`mako:sync-status`), for Settings › Account. With Mako Cloud,
 * every Thread worked in within the last 7 days goes up whole, in turn: the Sessions at work now, then the last day,
 * then the rest of the week, the newest first. Each Session goes up twice: as Mako draws it (its
 * reading copy, which any device shows at once) and as its harness wrote it (its records, from which it continues
 * anywhere). Counted from what the account confirmed holding, which the stores keep beside what they push.
 */
export const SyncTierNameSchema = z.enum(["now", "day", "week"])
export type SyncTierName = z.infer<typeof SyncTierNameSchema>

export const SyncTierSchema = z.object({
  tier: SyncTierNameSchema,
  sessions: z.number().int().nonnegative(),
  threads: z.number().int().nonnegative(),
  /** Another device can read it as it is now. */
  readable: z.number().int().nonnegative(),
  /** Its records are in this Mac's record store, which the backfill fills first. */
  held: z.number().int().nonnegative(),
  /** Its records are in the account through their last capture. */
  whole: z.number().int().nonnegative(),
  /** Both: readable and whole. */
  inCloud: z.number().int().nonnegative(),
  threadsInCloud: z.number().int().nonnegative(),
})
export type SyncTier = z.infer<typeof SyncTierSchema>

export const SyncFailureViewSchema = z.object({
  at: z.number(),
  harness: z.string(),
  nativeId: z.string(),
  message: z.string(),
  correlationId: z.string().optional(),
  /** When the Session began failing this way; `at` is its newest try. */
  since: z.number().optional(),
})
export type SyncFailureView = z.infer<typeof SyncFailureViewSchema>

/** The record store's backfill as its last pass wrote it beside the store: how far it has taken this Mac's sessions. */
export const SyncBackfillSchema = z.object({ sessions: z.number().int().nonnegative(), done: z.number().int().nonnegative(), startedAt: z.number(), endedAt: z.number().optional() })

export const SyncStatusSchema = z.discriminatedUnion("state", [
  /** Nothing leaves this Mac: signed out, or the account's plan has no cloud. */
  z.object({ state: z.literal("off"), reason: z.enum(["signed-out", "no-cloud"]) }),
  /** Signed in with the cloud, and the catalog hasn't said yet. */
  z.object({ state: z.literal("starting"), sessions: z.number().int().nonnegative() }),
  z.object({
    /** `synced`: every Session in the window is in the cloud; `paused`: catching up waits on a low battery or Low Power Mode. */
    state: z.enum(["syncing", "synced", "paused", "failing"]),
    sessions: z.number().int().nonnegative(),
    tiers: z.array(SyncTierSchema),
    /** Pushes in flight now. */
    sending: z.number().int().nonnegative(),
    /** Sessions changed since their copy went up, waiting for their turn. */
    stale: z.number().int().nonnegative(),
    lastSuccessAt: z.number().optional(),
    failures: z.array(SyncFailureViewSchema),
    backfill: SyncBackfillSchema.optional(),
  }),
])
export type SyncStatus = z.infer<typeof SyncStatusSchema>

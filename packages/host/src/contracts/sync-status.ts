import type { SyncFailureKind } from "@mako/sessions/scoped-uploads"
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

/** What kind of failure keeps a Session out of the account, as the sync daemon tells (`SyncFailureKind`). */
export const SyncFailureKindSchema = z.enum(["refused", "unreachable", "conflict", "unread", "failed"]) satisfies z.ZodType<SyncFailureKind>

/**
 * A Session not synced: its pushes have failed for a while and been tried again since (the sync daemon's rule,
 * `LASTING_MS`), so a failure the next try heals is never one. It stays until the Session goes.
 */
export const SyncFailureViewSchema = z.object({
  at: z.number(),
  harness: z.string(),
  nativeId: z.string(),
  /** The account's words and the call it answered, for an operator: the person reads `kind`'s (`syncFailureWords`). */
  message: z.string(),
  correlationId: z.string().optional(),
  kind: SyncFailureKindSchema.optional(),
  /** When the Session began failing, in a row; `at` is its newest try. */
  since: z.number().optional(),
})
export type SyncFailureView = z.infer<typeof SyncFailureViewSchema>

/** What a person reads of a Session not synced: what happened, in a few words, and what Mako does about it. */
export interface SyncFailureWords {
  what: string
  next: string
}

/**
 * The words for each kind. The rail, Settings and Diagnostics all say it this way; the account's own words are one
 * disclosure away.
 */
const FAILURE_WORDS = {
  refused: { what: "The account turned down part of it", next: "Mako sends it again on its own, less often each time. If it keeps happening, copy the details." },
  unreachable: { what: "Mako can't reach the account", next: "It sends it again on its own once the account answers." },
  conflict: { what: "It went on in two places", next: "The account keeps the version it has; this Mac's goes once the Session changes here." },
  unread: { what: "Mako couldn't read it on this Mac", next: "It reads it again at the Session's next change." },
  failed: { what: "It couldn't be sent", next: "Mako sends it again on its own." },
} satisfies Record<SyncFailureKind, SyncFailureWords>

export function syncFailureWords(kind: SyncFailureKind | undefined): SyncFailureWords {
  return FAILURE_WORDS[kind ?? "failed"]
}

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
    /** The Sessions not synced, the longest failing first: the first few, of `notSynced` in all. */
    failures: z.array(SyncFailureViewSchema),
    /** How many Sessions aren't synced, when more than `failures` lists. */
    notSynced: z.number().int().nonnegative().optional(),
    /** Sessions whose last push failed but not yet for long, tried again soon: never said as not synced. */
    retrying: z.number().int().nonnegative().optional(),
    backfill: SyncBackfillSchema.optional(),
  }),
])
export type SyncStatus = z.infer<typeof SyncStatusSchema>

/**
 * How this Mac's sending stands, in a line for Diagnostics: what the rail and Settings say, from the same status, with
 * what they leave out (Sessions retrying after a failure that hasn't lasted, pushes in flight) and the first Session
 * not synced's correlation ID, which leads to the gateway's log.
 */
export function describeSending(status: SyncStatus): string {
  if (status.state === "off") return status.reason === "signed-out" ? "Nothing leaves this Mac: it isn't signed in." : "Nothing leaves this Mac: the account has no cloud."
  if (status.state === "starting") return `Reading ${plural(status.sessions, "Session")} on this Mac.`
  const parts: string[] = []
  const notSynced = status.notSynced ?? status.failures.length
  const [first] = status.failures
  if (first) parts.push(`${plural(notSynced, "Session")} not synced; the first: ${syncFailureWords(first.kind).what.toLowerCase()}${first.correlationId ? ` (correlation ${first.correlationId})` : ""}.`)
  else parts.push(status.state === "synced" ? "Every Session of the last 7 days is in the cloud." : status.state === "paused" ? "Catching up waits for power." : "Catching up.")
  if (status.retrying) parts.push(`${plural(status.retrying, "Session")} retrying after a failed push, not said elsewhere until it lasts.`)
  if (status.sending) parts.push(`${status.sending} sending now.`)
  return parts.join(" ")
}

function plural(n: number, noun: string): string {
  return `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`
}

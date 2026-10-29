import type { SyncTier } from "@mako/sessions/scoped-uploads"

/**
 * What a device keeps in the account, in one rule that the account's list, the uploads and the status all read: every
 * Thread worked in within the last 7 days, whole (each of its Sessions, older ones included), and any Session at work
 * now. Each goes in its tier's turn, the newest first within it: at work now, then the last day, then the rest of the
 * week. A Session that ages out stays in the account; it goes up again once its Thread is worked in. Seven days is
 * what another device reaches for: what was worked on this week, newest first, whole; a month's worth made the first
 * sync of a busy Mac a backlog of hundreds of Sessions ahead of the one wanted.
 */
export const SYNC_WINDOW_MS = 7 * 24 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000

/** A Session's tier by its Thread's last activity, or undefined when it's outside the window and not at work. */
export function syncTier(threadActivityAt: number, busy: boolean, now: number): SyncTier | undefined {
  if (busy) return "now"
  const age = now - threadActivityAt
  if (!Number.isFinite(age) || age > SYNC_WINDOW_MS) return undefined
  return age <= DAY_MS ? "day" : "week"
}

/** The earliest activity a row needs to be read for the window at all, as an ISO time (the catalog's `updatedAt`). */
export function windowStart(now: number): string {
  return new Date(now - SYNC_WINDOW_MS).toISOString()
}

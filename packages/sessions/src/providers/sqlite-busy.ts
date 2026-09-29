import { z } from "zod"

/**
 * How long a read-only connection waits out a writer's lock. The Cursor SDK
 * closes a store between writes, and the WAL reset that follows locks
 * readers out for a few milliseconds; a read that gave up at once took a
 * live session for no session at all.
 */
export const READ_BUSY_TIMEOUT_MS = 100

const SQLITE_BUSY = 5

/** What `node:sqlite` throws, as far as telling busy from broken goes. */
export const SqliteFailure = z.object({ code: z.literal("ERR_SQLITE_ERROR"), errcode: z.number() })
export type SqliteFailure = z.infer<typeof SqliteFailure>

/** SQLITE_BUSY or one of its extended codes (recovery, snapshot, timeout). */
export function isBusy(failure: SqliteFailure): boolean {
  return (failure.errcode & 0xff) === SQLITE_BUSY
}

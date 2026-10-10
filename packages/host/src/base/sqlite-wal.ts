import type { DatabaseSync } from "node:sqlite"
import { z } from "zod"

const pause = new Int32Array(new SharedArrayBuffer(4))
const SqliteBusy = z.object({ code: z.literal("ERR_SQLITE_ERROR"), errcode: z.literal(5) })

/**
 * Put a database that several Mako hosts open into WAL mode. Switching a new
 * or rollback-journal file needs an exclusive lock, and SQLite refuses a
 * connection at once, without its busy timeout, while another connection is
 * switching the same file. Only that switch is retried, until `timeoutMs`.
 */
export function enableSharedWal(db: DatabaseSync, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs
  for (let attempt = 1; ; attempt++) {
    try {
      db.exec("PRAGMA journal_mode=WAL")
      return
    } catch (error) {
      if (!SqliteBusy.safeParse(error).success || Date.now() >= deadline) throw error
      Atomics.wait(pause, 0, 0, Math.min(50, 5 * attempt))
    }
  }
}

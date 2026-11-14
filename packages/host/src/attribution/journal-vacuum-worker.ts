import { statfsSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { z } from "zod"

/*
 * The record of changes compacted as its owner opens it, when free pages are a large share of it
 * (`vacuumIfSparse`). On a connection of its own, before the owner's opens: VACUUM rewrites the whole file and holds
 * its write lock throughout, which no running owner could wait out.
 */
const { path, minFreeBytes, minFreeShare } = z.object({ path: z.string(), minFreeBytes: z.number(), minFreeShare: z.number() }).parse(workerData)
const Pragma = z.object({ value: z.number() })
// The connection closes before the answer goes: the host ends this worker as the answer lands and opens the journal
// itself, and a connection left open then holds the lock VACUUM took ("database is locked" on the owner's open).
const answer = (() => {
  const db = new DatabaseSync(path)
  try {
    db.exec("PRAGMA busy_timeout=5000")
    const pragma = (name: string) => Pragma.parse(db.prepare(`SELECT ${name} AS value FROM pragma_${name}()`).get()).value
    const pageSize = pragma("page_size")
    const bytes = pragma("page_count") * pageSize
    const freeBytes = pragma("freelist_count") * pageSize
    // VACUUM writes a copy of what's in use beside it.
    const disk = statfsSync(dirname(path))
    if (freeBytes < minFreeBytes || freeBytes < bytes * minFreeShare) return { ok: true as const, vacuumed: false as const, bytes, freeBytes, why: "few free pages" }
    if (disk.bavail * disk.bsize < (bytes - freeBytes) * 1.5) return { ok: true as const, vacuumed: false as const, bytes, freeBytes, why: "too little disk" }
    db.exec("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")
    return { ok: true as const, vacuumed: true as const, bytes, freeBytes, after: pragma("page_count") * pageSize }
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
  } finally {
    db.close()
  }
})()
parentPort?.postMessage(answer)

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
const db = new DatabaseSync(path)
try {
  db.exec("PRAGMA busy_timeout=5000")
  const pragma = (name: string) => Pragma.parse(db.prepare(`SELECT ${name} AS value FROM pragma_${name}()`).get()).value
  const pageSize = pragma("page_size")
  const pages = pragma("page_count")
  const free = pragma("freelist_count")
  const freeBytes = free * pageSize
  const bytes = pages * pageSize
  // VACUUM writes a copy of what's in use beside it.
  const room = statfsSync(dirname(path)).bavail * statfsSync(dirname(path)).bsize
  if (freeBytes < minFreeBytes || freeBytes < bytes * minFreeShare) parentPort?.postMessage({ ok: true, vacuumed: false, bytes, freeBytes, why: "few free pages" })
  else if (room < (bytes - freeBytes) * 1.5) parentPort?.postMessage({ ok: true, vacuumed: false, bytes, freeBytes, why: "too little disk" })
  else {
    db.exec("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")
    parentPort?.postMessage({ ok: true, vacuumed: true, bytes, freeBytes, after: pragma("page_count") * pageSize })
  }
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
} finally {
  db.close()
}

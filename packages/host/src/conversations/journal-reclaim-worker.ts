import { statSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { z } from "zod"

const { path, cancellation } = z.object({
  path: z.string(),
  cancellation: z.instanceof(SharedArrayBuffer).refine(buffer => buffer.byteLength === Int32Array.BYTES_PER_ELEMENT),
}).parse(workerData)
const flag = new Int32Array(cancellation)
const cancelled = () => Atomics.load(flag, 0) !== 0
const before = statSync(path).size
const db = new DatabaseSync(path)
let skipped: boolean
try {
  db.exec("PRAGMA busy_timeout=1000; BEGIN IMMEDIATE")
  // Check after taking the write lock. An opener either cancels us first, or its writes wait until this deletion
  // commits. There is no gap in which it can stage new rows after our check but before our deletion.
  skipped = cancelled()
  if (!skipped && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='base_entries'").get())
    db.exec("DELETE FROM base_entries WHERE NOT EXISTS (SELECT 1 FROM base WHERE id=1 AND json_extract(value, '$.entryRows') IS NOT NULL)")
  db.exec("COMMIT")
  skipped ||= cancelled()
  if (!skipped) db.exec("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")
} finally {
  db.close()
}
parentPort?.postMessage(skipped ? { skipped: true } : { before, after: statSync(path).size })

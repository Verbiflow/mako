import { statSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { z } from "zod"

const { path } = z.object({ path: z.string() }).parse(workerData)
const before = statSync(path).size
const db = new DatabaseSync(path)
try {
  db.exec("PRAGMA busy_timeout=1000")
  // Rows a host wrote ahead of a turn (`LiveJournal.stageBase`) mean nothing while the base row doesn't name them.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='base_entries'").get())
    db.exec("DELETE FROM base_entries WHERE NOT EXISTS (SELECT 1 FROM base WHERE id=1 AND json_extract(value, '$.entryRows') IS NOT NULL)")
  db.exec("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")
} finally {
  db.close()
}
parentPort?.postMessage({ before, after: statSync(path).size })

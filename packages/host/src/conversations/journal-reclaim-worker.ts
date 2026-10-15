import { statSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { z } from "zod"

const { path } = z.object({ path: z.string() }).parse(workerData)
const before = statSync(path).size
const db = new DatabaseSync(path)
try {
  db.exec("PRAGMA busy_timeout=1000; VACUUM; PRAGMA wal_checkpoint(TRUNCATE);")
} finally {
  db.close()
}
parentPort?.postMessage({ before, after: statSync(path).size })

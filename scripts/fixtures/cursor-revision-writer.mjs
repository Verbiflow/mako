import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"

// Independent SQLite writer for the native-format snapshot oracle, not a CLI.
const database = new DatabaseSync(workerData.path)
const control = new Int32Array(workerData.control)
database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA busy_timeout=5000")
const insert = database.prepare("INSERT INTO blobs VALUES (?, ?)")
const meta = database.prepare("UPDATE meta SET value = ? WHERE key = '0'")
let revision = 0
try {
  parentPort.postMessage("ready")
  Atomics.wait(control, 0, 0)
  while (Atomics.load(control, 0) === 1) {
    // Bound disk growth during optional sustained runs; keep the writer open.
    if (revision >= 200000) { Atomics.wait(control, 0, 1); continue }
    database.exec("BEGIN IMMEDIATE")
    revision++
    insert.run(`blob-${revision}`, Buffer.alloc(128))
    meta.run(JSON.stringify({ agentId: workerData.nativeId, latestRootBlobId: `root-${revision}` }))
    database.exec("COMMIT")
  }
} finally {
  database.close()
  parentPort.postMessage({ writes: revision })
}

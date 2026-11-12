import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { z } from "zod"
import { COLLECT_MOST, collectPlan } from "./journal-store.js"

/*
 * What the hourly collection of kept content drops (`collectPlan`), read on a connection of its own. On the person's
 * 1.7 GB journal, read on the host's thread, it held the loop 2.4 to 3.9 s every hour. Read-only: the owner drops
 * what this finds (`JournalStore.dropPlanned`), less what it wrote since this read began.
 */
const { path, retainAfter, budget } = z.object({ path: z.string(), retainAfter: z.number(), budget: z.number() }).parse(workerData)
const db = new DatabaseSync(path, { readOnly: true })
try {
  db.exec("PRAGMA busy_timeout=2000")
  parentPort?.postMessage({ ok: true, ...collectPlan(db, retainAfter, budget, COLLECT_MOST) })
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
} finally {
  db.close()
}

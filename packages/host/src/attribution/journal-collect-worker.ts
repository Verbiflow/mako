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
// The connection closes before the answer goes: the host ends this worker as the answer lands, and a connection left
// open then would keep its read lock on the journal.
const answer = (() => {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec("PRAGMA busy_timeout=2000")
    return { ok: true as const, ...collectPlan(db, retainAfter, budget, COLLECT_MOST) }
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
  } finally {
    db.close()
  }
})()
parentPort?.postMessage(answer)

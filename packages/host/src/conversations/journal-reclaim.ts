import { Worker } from "node:worker_threads"
import { z } from "zod"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"

/** Free space a closed journal holds before it is compacted: at least this, and a quarter of the file. */
export const RECLAIM_MIN_BYTES = 8 * 1024 * 1024
const RECLAIM_TIMEOUT_MS = 60_000

const ReclaimedSchema = z.object({ before: z.number(), after: z.number() })

export type Reclaimed = { before: number; after: number; ms: number } | { error: string }

/**
 * Compacts closed journals in a worker, one at a time. VACUUM takes 0.1 to
 * 0.7 s on journals that dropped a 20 to 60 MB copy of their history, which
 * the host's own thread can't spare. A host that opens the journal meanwhile
 * reads it as before; its first write waits for the compaction.
 */
export class JournalReclaims {
  private queue: Promise<unknown> = Promise.resolve()

  reclaim(path: string): Promise<Reclaimed> {
    const run = this.queue.then(() => reclaimNow(path))
    this.queue = run
    return run
  }

  /** Resolves once every compaction asked for so far has ended. */
  async settled(): Promise<void> {
    await this.queue
  }
}

function reclaimNow(path: string): Promise<Reclaimed> {
  const started = performance.now()
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./journal-reclaim-worker.js", import.meta.url), {
      workerData: { path },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    })
    let settled = false
    const finish = (outcome: { before: number; after: number } | { error: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      if ("error" in outcome) {
        hostWarn("journal", "a journal could not be compacted; it keeps its free space", { path, error: outcome.error })
        resolve(outcome)
        return
      }
      const ms = Math.round(performance.now() - started)
      hostLog("journal", "journal compacted", { path, before: outcome.before, after: outcome.after, ms })
      resolve({ ...outcome, ms })
    }
    const timer = setTimeout(() => finish({ error: "timed out" }), RECLAIM_TIMEOUT_MS)
    timer.unref?.()
    worker.once("message", (value) => {
      const parsed = ReclaimedSchema.safeParse(value)
      finish(parsed.success ? parsed.data : { error: "unreadable reply" })
    })
    worker.once("error", (error) => finish({ error: errorMessage({ error }) }))
    worker.once("exit", (code) => finish({ error: `exited with ${code}` }))
  })
}

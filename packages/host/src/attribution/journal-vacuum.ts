import { Worker } from "node:worker_threads"
import { z } from "zod"

/** Free pages worth a compaction as the owner opens the journal: at least this many bytes, and this share of the file. */
const VACUUM_MIN_FREE_BYTES = 256 * 1024 * 1024
const VACUUM_MIN_FREE_SHARE = 0.25
const VACUUM_TIMEOUT_MS = 30 * 60_000

const VacuumedSchema = z.union([
  z.object({ ok: z.literal(true), vacuumed: z.literal(false), bytes: z.number(), freeBytes: z.number(), why: z.string() }),
  z.object({ ok: z.literal(true), vacuumed: z.literal(true), bytes: z.number(), freeBytes: z.number(), after: z.number() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type Vacuumed = z.infer<typeof VacuumedSchema> & { ms: number }

/**
 * Compact the journal at `path` on a worker when its free pages are many (`journal-vacuum-worker.ts`): only as its
 * owner opens it, before anything else here has it open, since VACUUM holds the write lock until it ends.
 */
export function vacuumIfSparse(path: string, least: { freeBytes: number; freeShare: number } = { freeBytes: VACUUM_MIN_FREE_BYTES, freeShare: VACUUM_MIN_FREE_SHARE }): Promise<Vacuumed> {
  const started = performance.now()
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./journal-vacuum-worker.js", import.meta.url), {
      workerData: { path, minFreeBytes: least.freeBytes, minFreeShare: least.freeShare },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    })
    let done = false
    const finish = (outcome: z.infer<typeof VacuumedSchema>) => {
      if (done) return
      done = true
      clearTimeout(timer)
      void worker.terminate()
      resolve({ ...outcome, ms: Math.round(performance.now() - started) })
    }
    const timer = setTimeout(() => finish({ ok: false, error: "timed out" }), VACUUM_TIMEOUT_MS)
    timer.unref?.()
    worker.once("message", (message) => {
      const reply = VacuumedSchema.safeParse(message)
      finish(reply.success ? reply.data : { ok: false, error: "unreadable reply" })
    })
    worker.once("error", (error) => finish({ ok: false, error: error.message }))
    worker.once("exit", (code) => finish({ ok: false, error: `exited with ${code}` }))
  })
}

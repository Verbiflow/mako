import { Worker } from "node:worker_threads"
import { realpathSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { z } from "zod"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { topic } from "../base/topic.js"

/** Free space a closed journal holds before it is compacted: at least this, and a quarter of the file. */
export const RECLAIM_MIN_BYTES = 8 * 1024 * 1024
const RECLAIM_TIMEOUT_MS = 60_000

const ReclaimedSchema = z.union([z.object({ before: z.number(), after: z.number() }), z.object({ skipped: z.literal(true) })])

export type Reclaimed = { before: number; after: number; ms: number } | { error: string } | { skipped: true }

/** An opener synchronously takes away any older close's right to tidy the same canonical file. */
export const journalOpened = topic<string>("mako:journal-opening")
const fileKey = (path: string) => join(realpathSync(dirname(path)), basename(path))

/**
 * Compacts closed journals in a worker, one at a time. VACUUM takes 0.1 to
 * 0.7 s on journals that dropped a 20 to 60 MB copy of their history, which
 * the host's own thread can't spare. A host that opens the journal meanwhile
 * reads it as before; its first write waits for the compaction.
 */
export class JournalReclaims {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly pending = new Set<Int32Array>()
  private stopped = false
  /** Whether a window's cold view holds file `key` (`ColdJournal`): its read transaction would hold a compaction up. */
  private readonly held: (key: string) => boolean
  /**
   * Compactions a cold view put off, by file: skipped while it held the file, or cancelled by its opening. Asked for
   * again when the last view of the file is let go (`released`), so a journal a window looked at isn't left uncompacted.
   */
  private readonly owed = new Map<string, string>()

  constructor(held: (key: string) => boolean = () => false) {
    this.held = held
  }

  reclaim(path: string): Promise<Reclaimed> {
    if (this.stopped) return Promise.resolve({ skipped: true })
    let key: string
    try { key = fileKey(path) } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return Promise.resolve({ skipped: true })
      throw error
    }
    this.owed.delete(key)
    if (this.held(key)) {
      this.owed.set(key, path)
      return Promise.resolve({ skipped: true })
    }
    const cancellation = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
    const flag = new Int32Array(cancellation)
    const unwatch = journalOpened.subscribe(opened => {
      if (opened === key) Atomics.store(flag, 0, 1)
    })
    this.pending.add(flag)
    const run = this.queue.then(() => Atomics.load(flag, 0) ? { skipped: true as const } : reclaimNow(path, cancellation)).then((result) => {
      // Cancelled by a cold view's opening: owed once the view goes, as one it skipped is.
      if ("skipped" in result && !this.stopped && this.held(key)) this.owed.set(key, path)
      return result
    }).finally(() => {
      unwatch()
      this.pending.delete(flag)
    })
    this.queue = run.catch(() => {})
    return run
  }

  /**
   * The last cold view of file `key` was let go: the compaction it put off, if any, is asked for again now. Only one it
   * put off: a journal's close decides whether it needs one (`LiveJournal.close`), and the compaction itself doesn't.
   */
  released(key: string): Promise<Reclaimed> | undefined {
    const path = this.owed.get(key)
    if (!path || this.held(key)) return undefined
    return this.reclaim(path)
  }

  /** Cancel queued work and join any native operation before the host lets go of its root. */
  async stop(): Promise<void> {
    this.stopped = true
    for (const flag of this.pending) Atomics.store(flag, 0, 1)
    await this.queue
  }

  /** Resolves once every compaction asked for so far has ended. */
  async settled(): Promise<void> {
    await this.queue
  }
}

function reclaimNow(path: string, cancellation: SharedArrayBuffer): Promise<Reclaimed> {
  const started = performance.now()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./journal-reclaim-worker.js", import.meta.url), {
      workerData: { path, cancellation },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    })
    let settled = false
    const finish = (outcome: { before: number; after: number } | { error: string } | { skipped: true }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate().then(() => {
        if ("skipped" in outcome) { resolve(outcome); return }
        if ("error" in outcome) {
          hostWarn("journal", "a journal could not be compacted; it keeps its free space", { path, error: outcome.error })
          resolve(outcome)
          return
        }
        const ms = Math.round(performance.now() - started)
        hostLog("journal", "journal compacted", { path, before: outcome.before, after: outcome.after, ms })
        resolve({ ...outcome, ms })
      }, reject)
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

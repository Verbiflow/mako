import type { UploadBudget } from "./upload-budget.js"

/**
 * What the sync daemon's memory guard holds it to. `heldBytes`: its JavaScript heap in use and the memory outside it
 * that JavaScript holds (`external`, buffers included), which is what its own work allocates and can let go of.
 * `rssBytes`: its resident memory, a backstop for what the heap doesn't see. Resident memory alone misled: it counts
 * about 190 MB of the runtime's own code pages, and malloc keeps freed regions resident long after a GC. On
 * 2026-10-30 a Mac's daemon retired itself twice in six minutes at 512 MB resident with 52 to 106 MB of heap, each
 * time dropping every upload in flight.
 */
export type MemoryLimits = { heldBytes: number; rssBytes: number }

export const MEMORY_LIMITS: MemoryLimits = { heldBytes: 256 * 1024 * 1024, rssBytes: 768 * 1024 * 1024 }

/** Samples over a limit in a row, uploads drained, before the guard retires the process. */
const RETIRE_SAMPLES = 3
/** Under this share of `heldBytes` (and back under `rssBytes`), shedding ends. */
const RESUME_SHARE = 0.75
/** The longest the guard waits for uploads in flight to finish before retiring anyway: past any request's timeout. */
const DRAIN_MOST_MS = 3 * 60_000
/** At most one forced collection this often, before a sample over a limit is believed. */
const COLLECT_EVERY_MS = 30_000

export type MemorySample = { rss: number; heapUsed: number; external: number }
export type MemoryGuardLog = (level: "info" | "warn", message: string, fields: Record<string, number>) => void

/**
 * Keeps a process's memory under its limits by shedding load before it ever retires. Each `sample` (every 5 s) weighs
 * what the process holds; over a limit, after one full collection where the runtime allows it (`--expose-gc`), the
 * uploads' budget sheds (`UploadBudget.shed`): no new pack starts, and those in flight finish, each recorded in the
 * remote's mirror as it goes. Back under three quarters of the limit, uploads go on. The guard says to retire only
 * once the process stayed over a limit for `RETIRE_SAMPLES` samples with no upload in flight, or had waited
 * `DRAIN_MOST_MS` for them: an upload is never cut off by the guard while it can still finish, and one that is (a
 * process killed) goes again from the mirror, its chunks by hash, so nothing is lost or taken twice.
 */
export class MemoryGuard {
  #shedSince: number | undefined
  #overSamples: number[] = []
  #collectedAt = Number.NEGATIVE_INFINITY

  constructor(
    private readonly budget: UploadBudget | undefined,
    private readonly log: MemoryGuardLog,
    private readonly options: { limits?: MemoryLimits; read?: () => MemorySample; collect?: () => void; now?: () => number } = {}
  ) {}

  get shedding(): boolean {
    return this.#shedSince !== undefined
  }

  /** One look at the process's memory; what to retire with when it must, else undefined. */
  sample(): Record<string, string | number> | undefined {
    const limits = this.options.limits ?? MEMORY_LIMITS
    const now = (this.options.now ?? Date.now)()
    const read = this.options.read ?? (() => process.memoryUsage())
    let memory = read()
    let over = this.#over(memory, limits, 1)
    // The runtime's full collection, where the process was started with `--expose-gc`, as the sync daemon is.
    const collect = this.options.collect ?? (global.gc ? () => void global.gc?.() : undefined)
    if (over && collect && now - this.#collectedAt >= COLLECT_EVERY_MS) {
      // Garbage not yet collected isn't load: what a full collection leaves is.
      this.#collectedAt = now
      collect()
      memory = read()
      over = this.#over(memory, limits, 1)
    }
    const fields = { rssMb: mb(memory.rss), heldMb: mb(memory.heapUsed + memory.external), heapUsedMb: mb(memory.heapUsed), externalMb: mb(memory.external), uploadsMb: mb(this.budget?.held ?? 0) }
    if (this.#shedSince === undefined) {
      if (!over) return undefined
      this.#shedSince = now
      this.#overSamples = [mb(memory.rss)]
      this.budget?.shed(true)
      this.log("warn", "memory over its limit; new uploads wait", { ...fields, heldLimitMb: mb(limits.heldBytes), rssLimitMb: mb(limits.rssBytes) })
      return undefined
    }
    if (!this.#over(memory, limits, RESUME_SHARE)) {
      this.log("info", "memory back under its limit; uploads go on", { ...fields, shedMs: now - this.#shedSince })
      this.#shedSince = undefined
      this.#overSamples = []
      this.budget?.shed(false)
      return undefined
    }
    this.#overSamples = over ? [...this.#overSamples, mb(memory.rss)] : []
    const drained = (this.budget?.held ?? 0) === 0 || now - this.#shedSince >= DRAIN_MOST_MS
    if (this.#overSamples.length < RETIRE_SAMPLES || !drained) return undefined
    return { ...fields, rssSamplesMb: this.#overSamples.join(","), heldLimitMb: mb(limits.heldBytes), rssLimitMb: mb(limits.rssBytes), shedMs: now - this.#shedSince }
  }

  #over(memory: MemorySample, limits: MemoryLimits, share: number): boolean {
    return memory.heapUsed + memory.external > limits.heldBytes * share || memory.rss > limits.rssBytes * (share === 1 ? 1 : 0.9)
  }
}

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024)

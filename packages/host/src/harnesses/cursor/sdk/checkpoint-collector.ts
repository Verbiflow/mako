import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { Worker } from "node:worker_threads"
import { z } from "zod"
import { cursorSdkDirectoryName } from "@mako/sessions"
import { CURSOR_QUIET_MS } from "@mako/sessions/cursor-sdk-collect"
import { errorMessage } from "../../../base/error-message.js"
import { publishFile } from "../../../base/published-files.js"
import { hostLog, hostWarn } from "../../../base/host-log.js"
import type { StorageCollection } from "../../../contracts/storage.js"
import type { HarnessStorage } from "../../../usage/index.js"

/** One agent's sweep; the largest store seen, 10.6 GB, took 72 s with its VACUUM. */
const SWEEP_TIMEOUT_MS = 15 * 60_000
/** How long an agent must have been still before a sweep the person asked for takes it. */
const PERSON_QUIET_MS = 5 * 60_000

const StampSchema = z.object({ size: z.number(), mtimeMs: z.number() })
const StampsSchema = z.record(z.string(), StampSchema)
const SweepSchema = z.object({
  directory: z.string(),
  agentId: z.string().optional(),
  outcome: z.enum(["collected", "skipped"]),
  reason: z.string().optional(),
  roots: z.number(),
  placed: z.number(),
  deleted: z.number(),
  deletedBytes: z.number(),
  fileBefore: z.number(),
  fileAfter: z.number(),
  vacuumed: z.boolean(),
  ms: z.number(),
  stamp: StampSchema.optional(),
})

type Sweep = z.infer<typeof SweepSchema>

/**
 * Collects the checkpoints Cursor's SDK leaves in Mako's agent stores
 * (`collectCursorCheckpoints`), one agent at a time, each in a worker: a
 * sweep reads every root in a store, gigabytes for a long agent, and its
 * VACUUM holds the store for seconds. A store a session has open is never
 * swept (`hold`), and a session that opens one mid-sweep stops the sweep
 * first: SQLite rolls back the batch or VACUUM it was in, and every batch
 * already committed deleted only roots nothing reads. A headless run takes
 * the same hold before it starts. What each store was when last collected
 * is kept beside the stores (`stampsPath`), so a pass skips the ones that
 * haven't moved since.
 */
export class CursorCheckpointCollector implements HarnessStorage {
  readonly provider = "cursor"
  readonly part = "cursor-sdk"
  readonly #stateRoot: string
  readonly #stampsPath: string
  /** Each agent folder's holders: sessions and headless starts. */
  readonly #held = new Map<string, number>()
  #sweeping: { directory: string; stop(): Promise<void> } | undefined
  #pass: Promise<StorageCollection> | undefined
  #last: StorageCollection | undefined

  constructor(options: { stateRoot: string; stampsPath: string }) {
    this.#stateRoot = options.stateRoot
    this.#stampsPath = options.stampsPath
  }

  /** Holds these agents' stores until the returned release: a sweep of one stops first, and none starts on one meanwhile. */
  async hold(agentIds: readonly string[]): Promise<() => void> {
    const directories = agentIds.map(cursorSdkDirectoryName)
    for (const directory of directories) this.#held.set(directory, (this.#held.get(directory) ?? 0) + 1)
    const sweeping = this.#sweeping
    if (sweeping && directories.includes(sweeping.directory)) await sweeping.stop()
    let released = false
    return () => {
      if (released) return
      released = true
      for (const directory of directories) {
        const holders = (this.#held.get(directory) ?? 1) - 1
        if (holders > 0) this.#held.set(directory, holders)
        else this.#held.delete(directory)
      }
    }
  }

  collecting(): boolean {
    return this.#pass !== undefined
  }

  last(): StorageCollection | undefined {
    return this.#last
  }

  /** Every quiet agent swept once; a pass asked for while one runs is that pass. */
  collect(trigger: StorageCollection["trigger"]): Promise<StorageCollection> {
    this.#pass ??= this.#collect(trigger).finally(() => {
      this.#pass = undefined
    })
    return this.#pass
  }

  async #collect(trigger: StorageCollection["trigger"]): Promise<StorageCollection> {
    const started = performance.now()
    const pass = randomUUID().slice(0, 8)
    const collection: StorageCollection = { part: this.part, at: new Date().toISOString(), trigger, freedBytes: 0, collected: 0, skipped: 0, ms: 0 }
    const directories = (await readdir(join(this.#stateRoot, "agents")).catch(() => [])).filter((name) => name.startsWith("agent-")).sort()
    const stamps = await this.#readStamps()
    const quietMs = trigger === "person" ? PERSON_QUIET_MS : CURSOR_QUIET_MS
    for (const directory of directories) {
      if (this.#held.has(directory)) {
        collection.skipped += 1
        continue
      }
      const stamp = stamps.get(directory)
      const outcome = await this.#sweep({ stateRoot: this.#stateRoot, directory, quietMs, ...stamp && { stamp } })
      if ("error" in outcome) {
        collection.skipped += 1
        hostWarn("cursor-sdk", "an agent's checkpoints could not be collected", { pass, directory, error: outcome.error })
        continue
      }
      if (outcome.outcome === "collected") collection.collected += 1
      else collection.skipped += 1
      collection.freedBytes += Math.max(0, outcome.fileBefore - outcome.fileAfter)
      if (outcome.stamp) stamps.set(directory, outcome.stamp)
      if (outcome.deleted || outcome.reason === "moved" || outcome.reason === "no room to compact")
        hostLog("cursor-sdk", "checkpoints collected", {
          pass,
          agent: outcome.agentId ?? directory,
          deleted: outcome.deleted,
          kept: outcome.roots - outcome.deleted,
          before: outcome.fileBefore,
          after: outcome.fileAfter,
          vacuumed: outcome.vacuumed,
          reason: outcome.reason ?? "",
          ms: outcome.ms,
        })
    }
    const present = new Set(directories)
    await this.#writeStamps(new Map([...stamps].filter(([directory]) => present.has(directory)))).catch((error) =>
      hostWarn("cursor-sdk", "the checkpoint collector's stamps could not be saved", { pass, error: errorMessage({ error }) }))
    collection.ms = Math.round(performance.now() - started)
    hostLog("cursor-sdk", "checkpoint pass ended", { pass, trigger, collected: collection.collected, skipped: collection.skipped, freed: collection.freedBytes, ms: collection.ms })
    this.#last = collection
    return collection
  }

  #sweep(workerData: { stateRoot: string; directory: string; quietMs: number; stamp?: z.infer<typeof StampSchema> }): Promise<Sweep | { error: string }> {
    return new Promise((resolve) => {
      const worker = new Worker(new URL("./checkpoint-collector-worker.js", import.meta.url), {
        workerData,
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      })
      let settled = false
      let stopped: (() => void) | undefined
      const finish = (outcome: Sweep | { error: string }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.#sweeping = undefined
        void worker.terminate().finally(() => stopped?.())
        resolve(outcome)
      }
      this.#sweeping = {
        directory: workerData.directory,
        stop: () => new Promise((done) => {
          stopped = done
          finish({ error: "stopped for a session that opened the agent" })
        }),
      }
      const timer = setTimeout(() => finish({ error: "timed out" }), SWEEP_TIMEOUT_MS)
      timer.unref?.()
      worker.once("message", (value) => {
        const parsed = SweepSchema.safeParse(value)
        finish(parsed.success ? parsed.data : { error: "unreadable reply" })
      })
      worker.once("error", (error) => finish({ error: errorMessage({ error }) }))
      worker.once("exit", (code) => finish({ error: `exited with ${code}` }))
    })
  }

  async #readStamps(): Promise<Map<string, z.infer<typeof StampSchema>>> {
    const text = await readFile(this.#stampsPath, "utf8").catch(() => "{}")
    try {
      return new Map(Object.entries(StampsSchema.catch({}).parse(JSON.parse(text))))
    } catch {
      return new Map()
    }
  }

  async #writeStamps(stamps: ReadonlyMap<string, z.infer<typeof StampSchema>>): Promise<void> {
    await publishFile(this.#stampsPath, JSON.stringify(Object.fromEntries(stamps)))
  }
}

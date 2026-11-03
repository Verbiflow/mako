import { lstat, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { backfillProgress } from "@mako/sessions/record-backfill"
import { errorMessage } from "../base/error-message.js"
import { hostLog } from "../base/host-log.js"
import type { StorageCollection } from "../contracts/storage.js"
import type { HarnessStorage } from "./storage.js"

/** A writer's next copy of a file, named `<file>.<pid>.tmp` until it's renamed over the file. */
const LEFTOVER = /^.+\.(\d+)\.tmp$/
/** A copy this old, its writer gone, is one a process died before renaming. */
const LEFTOVER_AGE_MS = 60 * 60_000

/**
 * What Mako's writers leave when a process dies between writing a file's
 * next copy and renaming it over the file: `<file>.<pid>.tmp` at the top
 * of Mako's roots. One is removed once no process has its pid and it's an
 * hour old. Each is small, so Settings › Storage counts them under the rest.
 */
export class LeftoverFiles implements HarnessStorage {
  readonly provider = "mako"
  readonly part = "rest"
  readonly #roots: readonly string[]
  readonly #alive: (pid: number) => boolean
  #pass: Promise<StorageCollection> | undefined
  #last: StorageCollection | undefined

  constructor(roots: readonly string[], alive = processAlive) {
    this.#roots = roots
    this.#alive = alive
  }

  collect(trigger: StorageCollection["trigger"]): Promise<StorageCollection> {
    this.#pass ??= this.#collect(trigger).finally(() => {
      this.#pass = undefined
    })
    return this.#pass
  }

  collecting(): boolean {
    return this.#pass !== undefined
  }

  last(): StorageCollection | undefined {
    return this.#last
  }

  async #collect(trigger: StorageCollection["trigger"]): Promise<StorageCollection> {
    const started = performance.now()
    let freedBytes = 0
    let collected = 0
    let skipped = 0
    for (const root of this.#roots) {
      const names = await readdir(root).catch(() => [])
      for (const name of names) {
        const pid = LEFTOVER.exec(name)?.[1]
        if (!pid) continue
        const path = join(root, name)
        const stats = await lstat(path).catch(() => null)
        if (!stats?.isFile()) continue
        if (this.#alive(Number(pid)) || Date.now() - stats.mtimeMs < LEFTOVER_AGE_MS) {
          skipped += 1
          continue
        }
        await rm(path, { force: true })
        freedBytes += stats.size
        collected += 1
      }
    }
    const collection: StorageCollection = { part: this.part, at: new Date().toISOString(), trigger, freedBytes, collected, skipped, ms: Math.round(performance.now() - started) }
    if (collected) hostLog("storage", "leftover copies removed", { trigger, removed: collected, bytes: freedBytes, kept: skipped })
    this.#last = collection
    return collection
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the pid is another user's process, which is alive.
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

/**
 * The session records' repack (`record-repack.ts`), which the sync daemon
 * runs after each backfill pass in its own process, as the last pass wrote
 * it beside the store. Shown here, never run from here: the daemon owns the
 * store. Collecting reads the last pass again.
 */
export class RecordRepacks implements HarnessStorage {
  readonly provider = "mako"
  readonly part = "records"
  readonly #folder: string
  #reading: Promise<StorageCollection | undefined> | undefined
  #last: StorageCollection | undefined

  constructor(folder: string) {
    this.#folder = folder
    void this.#read()
  }

  async collect(trigger: StorageCollection["trigger"]): Promise<StorageCollection> {
    return (await this.#read()) ?? { part: this.part, at: new Date().toISOString(), trigger, freedBytes: 0, collected: 0, skipped: 0, ms: 0 }
  }

  collecting(): boolean {
    return false
  }

  last(): StorageCollection | undefined {
    return this.#last
  }

  #read(): Promise<StorageCollection | undefined> {
    this.#reading ??= backfillProgress(this.#folder).then((progress) => {
      const repack = progress?.repack
      if (progress?.endedAt === undefined || !repack) return this.#last
      this.#last = {
        part: this.part,
        at: new Date(progress.endedAt).toISOString(),
        trigger: "scheduled",
        freedBytes: Math.max(0, repack.packBytesBefore - repack.packBytesAfter),
        collected: 1,
        skipped: 0,
        ms: repack.ms,
      }
      return this.#last
    }, (error) => {
      hostLog("storage", "the records' last repack could not be read", { error: errorMessage({ error }) })
      return this.#last
    }).finally(() => {
      this.#reading = undefined
    })
    return this.#reading
  }
}

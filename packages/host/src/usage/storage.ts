import { hostCommand } from "../base/host-command.js"
import { statfs } from "node:fs/promises"
import { basename } from "node:path"
import { z } from "zod"
import type { HostJobs } from "../base/host-jobs.js"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import { STORAGE_LOW_BYTES, type StorageCollection, type StoragePart, type StorageReport } from "../contracts/storage.js"
const run = hostCommand

/** Collectors run this often, the first a while after the host starts, so a start's own work goes first. */
const COLLECT_EVERY_MS = 6 * 60 * 60_000
const FIRST_COLLECT_MS = 10 * 60_000
const DISK_EVERY_MS = 10 * 60_000
/** Once warned, free space must climb this far over the line before Mako warns again. */
const REARM_BYTES = 2 * 1024 ** 3
/** A part smaller than this is counted under the rest. */
const SHOWN_BYTES = 50 * 1024 ** 2
const MEASURE_TIMEOUT_MS = 5 * 60_000
const PartialOutputSchema = z.object({ stdout: z.string().min(1) })

/** What each of Mako's folders holds, by its name under its root; one not named here is listed by its name. */
const KNOWN = new Map([
  ["cursor-sdk", {
    label: "Cursor agents",
    detail: "Each Cursor agent's conversation as Cursor's SDK keeps it. The SDK saves the whole conversation again after every step and deletes none of those copies; Mako removes the ones nothing reads once an agent has been idle for half an hour.",
  }],
  ["records", {
    label: "Session records",
    detail: "Every version of every session, compressed and shared between versions, so a conversation reads as it was at any turn and syncs. After each sync pass, what a deleted session alone used is removed, and a pack is rewritten once a fifth of it is no longer used.",
  }],
  ["worktrees", { label: "Thread worktrees", detail: "Checkouts of Threads on their own branch. Settings › Worktrees removes them." }],
  ["archive", { label: "Archived Threads", detail: "What an archived Thread kept, to bring it back." }],
  ["transcripts", { label: "Transcripts", detail: "Readable copies of sessions, written for agents to read." }],
  ["views", { label: "Views", detail: "Prepared views of sessions, made again when needed." }],
  ["catalogs", { label: "Catalogs", detail: "Each harness's list of sessions, made again when needed." }],
  ["attribution", { label: "Line attribution", detail: "Who wrote each changed line, for moves and Undo." }],
  ["conversations", { label: "Conversation journals", detail: "Each conversation's journal; a closed one is compacted." }],
  ["workspace-snapshots", { label: "Rewind snapshots", detail: "Files as they were before each turn, for Rewind." }],
  ["updates", { label: "Update checkout", detail: "The source and build Mako updates itself from." }],
  ["logs", { label: "Logs", detail: "The host's and sync's logs." }],
])

/** A harness's collector of what it leaves in a folder of Mako's user root, which `MakoStorage` schedules and shows. */
export interface HarnessStorage {
  readonly provider: string
  /** The folder it frees, by its name under the user root (`StoragePart.id`). */
  readonly part: string
  collect(trigger: StorageCollection["trigger"]): Promise<StorageCollection>
  collecting(): boolean
  last(): StorageCollection | undefined
}

export interface StorageDeps {
  /** `~/.mako` and the app's data folder: every part is a folder at the top of one. */
  roots: readonly string[]
  collectors: () => readonly HarnessStorage[]
  emit: (event: HostEvent) => void
  /** Test hooks. */
  measure?: (root: string) => Promise<Map<string, number>>
  disk?: (path: string) => Promise<{ freeBytes: number; totalBytes: number }>
}

/**
 * What Mako keeps on this Mac (Settings › Storage): each folder at the top
 * of its roots, measured by `du` in its own process, and the harnesses'
 * collectors, run every six hours, when the person asks, and when the disk
 * runs low. Under `STORAGE_LOW_BYTES` free, Mako says so once, and again
 * only after the disk has had room since.
 */
export class MakoStorage {
  readonly #deps: StorageDeps
  #parts: StoragePart[] = []
  #at: string | null = null
  #disk: StorageReport["disk"] = null
  #measuring: Promise<void> | undefined
  #collecting: Promise<StorageCollection[]> | undefined
  #warned = false

  constructor(deps: StorageDeps) {
    this.#deps = deps
  }

  schedule(jobs: Pick<HostJobs, "every">): () => void {
    const stopCollecting = jobs.every("collect what harnesses leave behind", COLLECT_EVERY_MS, async () => {
      await this.collect("scheduled")
    }, { firstAfterMs: FIRST_COLLECT_MS })
    const stopWatching = jobs.every("watch the disk's free space", DISK_EVERY_MS, () => this.watch(), { firstAfterMs: FIRST_COLLECT_MS })
    return () => {
      stopCollecting()
      stopWatching()
    }
  }

  report(): StorageReport {
    const collectors = this.#deps.collectors()
    return {
      at: this.#at,
      disk: this.#disk,
      lowBytes: STORAGE_LOW_BYTES,
      parts: this.#parts,
      collections: collectors.flatMap((collector) => collector.last() ?? []).sort((a, b) => b.at.localeCompare(a.at)),
      measuring: this.#measuring !== undefined,
      collecting: this.#collecting !== undefined || collectors.some((collector) => collector.collecting()),
    }
  }

  /** Every part measured again; one measurement at a time. */
  async measure(): Promise<StorageReport> {
    this.#measuring ??= this.#measure().finally(() => {
      this.#measuring = undefined
    })
    await this.#measuring
    return this.report()
  }

  /** What every collector can free now, then measured again. */
  async free(): Promise<StorageReport> {
    await this.collect("person")
    return this.measure()
  }

  collect(trigger: StorageCollection["trigger"]): Promise<StorageCollection[]> {
    this.#collecting ??= Promise.all(this.#deps.collectors().map((collector) => collector.collect(trigger).catch((error): StorageCollection => {
      hostWarn("storage", "a collector failed", { part: collector.part, trigger, error: errorMessage({ error }) })
      return { part: collector.part, at: new Date().toISOString(), trigger, freedBytes: 0, collected: 0, skipped: 0, ms: 0, error: errorMessage({ error }) }
    }))).finally(() => {
      this.#collecting = undefined
    })
    return this.#collecting
  }

  /** Warns once the disk holds less than `STORAGE_LOW_BYTES` free, and collects without waiting for the schedule. */
  async watch(): Promise<void> {
    const [root] = this.#deps.roots
    if (!root) return
    const disk = await this.#readDisk(root)
    if (!disk) return
    this.#disk = disk
    if (disk.freeBytes >= STORAGE_LOW_BYTES + REARM_BYTES) this.#warned = false
    if (disk.freeBytes >= STORAGE_LOW_BYTES || this.#warned) return
    this.#warned = true
    hostWarn("storage", "the disk is nearly full", { free: disk.freeBytes, total: disk.totalBytes })
    this.#deps.emit({
      type: "notice",
      level: "error",
      message: `This Mac has ${gigabytes(disk.freeBytes)} free. Settings › Storage shows what Mako keeps and frees what it can.`,
    })
    await this.collect("low disk")
  }

  async #measure(): Promise<void> {
    const started = performance.now()
    const collected = new Set(this.#deps.collectors().map((collector) => collector.part))
    const parts: StoragePart[] = []
    let rest = 0
    for (const root of this.#deps.roots) {
      const sizes = await (this.#deps.measure ?? measureFolders)(root).catch((error) => {
        hostWarn("storage", "a folder could not be measured", { root, error: errorMessage({ error }) })
        return new Map<string, number>()
      })
      for (const [path, bytes] of sizes) {
        const id = basename(path)
        if (bytes < SHOWN_BYTES) {
          rest += bytes
          continue
        }
        const known = KNOWN.get(id)
        parts.push({ id, label: known?.label ?? id, detail: known?.detail ?? "", path, bytes, collected: collected.has(id) })
      }
    }
    parts.sort((a, b) => b.bytes - a.bytes)
    if (rest) parts.push({ id: "rest", label: "Everything else", detail: `Folders and files under ${SHOWN_BYTES / 1024 ** 2} MB each. Copies of a file a process stopped before saving are removed.`, path: "", bytes: rest, collected: collected.has("rest") })
    this.#parts = parts
    this.#at = new Date().toISOString()
    const [root] = this.#deps.roots
    const disk = root ? await this.#readDisk(root) : null
    if (disk) this.#disk = disk
    hostLog("storage", "measured", { parts: parts.length, bytes: parts.reduce((sum, part) => sum + part.bytes, 0), free: this.#disk?.freeBytes ?? -1, ms: Math.round(performance.now() - started) })
  }

  async #readDisk(path: string): Promise<StorageReport["disk"]> {
    try {
      if (this.#deps.disk) return await this.#deps.disk(path)
      const stats = await statfs(path)
      return { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize }
    } catch {
      return null
    }
  }
}

/** Each file and folder at the top of `root` with its size in bytes, as `du` counts it. */
async function measureFolders(root: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>()
  let stdout: string
  try {
    ;({ stdout } = await run("/usr/bin/nice", ["-n", "10", "du", "-a", "-k", "-d", "1", root], { timeout: MEASURE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }))
  } catch (error) {
    // `du` exits 1 when a file vanished or can't be read, and still prints the rest.
    const partial = PartialOutputSchema.safeParse(error)
    if (!partial.success) throw error
    stdout = partial.data.stdout
  }
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t")
    if (tab <= 0) continue
    const path = line.slice(tab + 1)
    if (path === root) continue
    const kilobytes = Number(line.slice(0, tab))
    if (Number.isFinite(kilobytes)) sizes.set(path, kilobytes * 1024)
  }
  return sizes
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

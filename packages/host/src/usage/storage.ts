import { hostCommand } from "../base/host-command.js"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, statfs, writeFile } from "node:fs/promises"
import { basename, dirname } from "node:path"
import { z } from "zod"
import type { HostJobs } from "../base/host-jobs.js"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import {
  storageLowBytes,
  STORAGE_LOW_BYTES,
  type ReclaimItem,
  type ReclaimOutcome,
  type ReclaimPlan,
  type ReclaimStore,
  type StorageBudgetSettings,
  type StorageCollection,
  type StoragePart,
  type StorageReport,
} from "../contracts/storage.js"
import { localWords } from "@mako/protocol/computer-words"
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
const BudgetSchema = z.object({ autoFree: z.boolean() }).strict()
/** A folder's measured size stands this long: a preview opened twice in a row measures once. */
const SIZE_FRESH_MS = 30 * 60_000
/** How many removals Settings › Storage lists. */
const KEPT_OUTCOMES = 8

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
  ["worktrees", { label: "Thread worktrees", detail: "Checkouts of Threads on their own branch. A finished Fin's or an archived Thread's goes once it's clean, pushed and quiet for a week, and comes back with the next message." }],
  ["thread-data", { label: "Thread data and scratch", detail: "What agents keep for each Thread: scratch goes three quiet days after its Thread finishes, or once it's archived. Folders from before scratch had a place of its own go once their Thread is archived." }],
  ["archive", { label: "Archived Threads", detail: "What an archived Thread kept, to bring it back." }],
  ["transcripts", { label: "Transcripts", detail: "Readable copies of sessions, written for agents to read." }],
  ["views", { label: "Views", detail: "Prepared views of sessions, made again when needed." }],
  ["catalogs", { label: "Catalogs", detail: "Each harness's list of sessions, made again when needed." }],
  ["attribution", { label: "Line attribution", detail: "Who wrote each changed line, for moves and Undo." }],
  ["conversations", { label: "Conversation journals", detail: "Each conversation's journal; a closed one is compacted." }],
  ["workspace-snapshots", { label: "Rewind snapshots", detail: "Files as they were before each turn, for Rewind. The newest 8 GB are kept; older settled turns' go first." }],
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

/**
 * A store of Mako's whose folders belong to Threads, projects or turns, and which knows when each is expendable
 * (`ReclaimClass`). Its `reclaim` looks at each item again before removing it and keeps what no longer qualifies.
 */
export interface StorageReclaimer {
  readonly store: ReclaimStore
  items(): Promise<ReclaimItem[]>
  reclaim(items: readonly ReclaimItem[], consent: "now" | "approve"): Promise<Map<string, true | string>>
}

export interface StorageDeps {
  /** `~/.mako` and the app's data folder: every part is a folder at the top of one. */
  roots: readonly string[]
  collectors: () => readonly HarnessStorage[]
  /** The stores whose folders Settings › Storage previews and removes, and the low-disk pass frees. */
  reclaimers?: () => readonly StorageReclaimer[]
  /** Where the person's low-disk switch is kept. */
  budgetFile?: string
  emit: (event: HostEvent) => void
  /** Test hooks. */
  measure?: (root: string) => Promise<Map<string, number>>
  measureFolder?: (path: string) => Promise<number | null>
  disk?: (path: string) => Promise<{ freeBytes: number; totalBytes: number }>
}

/**
 * What Mako keeps on this Mac (Settings › Storage): each folder at the top
 * of its roots, measured by `du` in its own process, and the harnesses'
 * collectors, run every six hours, when the person asks, and when the disk
 * runs low; and each store's folders that belong to Threads, projects or
 * turns (`StorageReclaimer`), previewed by how expendable they are and removed
 * when the person chooses, or, the expendable ones, when the disk runs low.
 */
export class MakoStorage {
  readonly #deps: StorageDeps
  #parts: StoragePart[] = []
  #at: string | null = null
  #disk: StorageReport["disk"] = null
  #measuring: Promise<void> | undefined
  #collecting: Promise<StorageCollection[]> | undefined
  #warned = false
  #plan: ReclaimPlan | null = null
  #planning: Promise<ReclaimPlan> | undefined
  #reclaiming: Promise<void> | undefined
  #reclaims: ReclaimOutcome[] = []
  #budget: StorageBudgetSettings = { autoFree: true }
  readonly #sizes = new Map<string, { bytes: number | null; at: number }>()

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
      lowBytes: this.#disk ? storageLowBytes(this.#disk.totalBytes) : STORAGE_LOW_BYTES,
      parts: this.#parts,
      collections: collectors.flatMap((collector) => collector.last() ?? []).sort((a, b) => b.at.localeCompare(a.at)),
      measuring: this.#measuring !== undefined,
      collecting: this.#collecting !== undefined || collectors.some((collector) => collector.collecting()),
      plan: this.#plan,
      planning: this.#planning !== undefined,
      reclaiming: this.#reclaiming !== undefined,
      reclaims: this.#reclaims,
      budget: this.#budget,
    }
  }

  /** The person's low-disk switch, read once; unreadable reads as on, the default. */
  async budget(): Promise<StorageBudgetSettings> {
    const file = this.#deps.budgetFile
    if (!file) return this.#budget
    const text = await readFile(file, "utf8").catch(() => null)
    const parsed = text === null ? null : BudgetSchema.safeParse(JSON.parse(text))
    this.#budget = parsed?.success ? parsed.data : { autoFree: true }
    return this.#budget
  }

  async configureBudget(value: StorageBudgetSettings): Promise<StorageReport> {
    const settings = BudgetSchema.parse(value)
    const file = this.#deps.budgetFile
    if (file) {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(settings), { flag: "wx", mode: 0o600 })
        await rename(temporary, file)
      } finally { await rm(temporary, { force: true }) }
    }
    this.#budget = settings
    return this.report()
  }

  /** What each store could give back, each item measured; one preview at a time, which a second asker joins. */
  plan(): Promise<ReclaimPlan> {
    this.#planning ??= this.#makePlan().finally(() => {
      this.#planning = undefined
    })
    return this.#planning
  }

  async #makePlan(): Promise<ReclaimPlan> {
    const started = performance.now()
    const items: ReclaimItem[] = []
    for (const reclaimer of this.#deps.reclaimers?.() ?? []) {
      try {
        items.push(...await reclaimer.items())
      } catch (error) {
        hostWarn("storage", "a store could not be previewed", { store: reclaimer.store, error: errorMessage({ error }) })
      }
    }
    for (const item of items) if (item.bytes === null) item.bytes = await this.#size(item.parts ?? [item.path])
    items.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
    this.#plan = { at: new Date().toISOString(), items }
    hostLog("storage", "previewed", {
      items: items.length, now: classBytes(items, "now"), approve: classBytes(items, "approve"), keep: classBytes(items, "keep"), ms: Math.round(performance.now() - started),
    })
    return this.#plan
  }

  async #size(paths: readonly string[]): Promise<number | null> {
    let total = 0
    for (const path of paths) {
      const held = this.#sizes.get(path)
      let bytes = held && Date.now() - held.at < SIZE_FRESH_MS ? held.bytes : undefined
      if (bytes === undefined) {
        bytes = await (this.#deps.measureFolder ?? measureFolder)(path).catch(() => null)
        this.#sizes.set(path, { bytes, at: Date.now() })
      }
      if (bytes === null) return null
      total += bytes
    }
    return total
  }

  /**
   * Removes the previewed items the person chose (`ids`), within what they agreed to: `now` takes only what still
   * reads `now`, `approve` also what needed their OK. `keep` never goes. One removal at a time.
   */
  reclaim(consent: "now" | "approve", ids: readonly string[], trigger: ReclaimOutcome["trigger"] = "person"): Promise<ReclaimOutcome> {
    const previous = this.#reclaiming ?? Promise.resolve()
    const work = previous.then(() => this.#reclaim(consent, ids, trigger))
    const tracked: Promise<void> = work.then(() => undefined, () => undefined).finally(() => {
      if (this.#reclaiming === tracked) this.#reclaiming = undefined
    })
    this.#reclaiming = tracked
    return work
  }

  async #reclaim(consent: "now" | "approve", ids: readonly string[], trigger: ReclaimOutcome["trigger"]): Promise<ReclaimOutcome> {
    const plan = this.#plan ?? await this.plan()
    const wanted = new Set(ids)
    const chosen = plan.items.filter((item) => wanted.has(item.id) && (item.class === "now" || (item.class === "approve" && consent === "approve")))
    const [root] = this.#deps.roots
    const before = root ? await this.#readDisk(root) : null
    const outcome: ReclaimOutcome = { at: new Date().toISOString(), trigger, consent, freedBytes: 0, removed: [], kept: [] }
    const reclaimers = new Map((this.#deps.reclaimers?.() ?? []).map((reclaimer) => [reclaimer.store, reclaimer]))
    for (const store of new Set(chosen.map((item) => item.store))) {
      const items = chosen.filter((item) => item.store === store)
      const reclaimer = reclaimers.get(store)
      const results = reclaimer ? await reclaimer.reclaim(items, consent).catch((error) => new Map(items.map((item) => [item.id, errorMessage({ error })]))) : new Map<string, string>()
      for (const item of items) {
        const result = results.get(item.id) ?? "Its store is unavailable on this host."
        if (result === true) outcome.removed.push(item)
        else outcome.kept.push({ ...item, class: "keep", reason: result })
      }
    }
    for (const path of [...outcome.removed.flatMap((item) => item.parts ?? [item.path])]) this.#sizes.delete(path)
    const after = root ? await this.#readDisk(root) : null
    if (after) this.#disk = after
    const counted = outcome.removed.reduce((sum, item) => sum + (item.bytes ?? 0), 0)
    // The disk's own reading, so clones' shared blocks aren't counted as freed; what was removed when it can't be read.
    outcome.freedBytes = before && after ? Math.max(0, after.freeBytes - before.freeBytes) : counted
    if (this.#plan) {
      const removed = new Set(outcome.removed.map((item) => item.id))
      const kept = new Map(outcome.kept.map((item) => [item.id, item]))
      this.#plan = { ...this.#plan, items: this.#plan.items.filter((item) => !removed.has(item.id)).map((item) => kept.get(item.id) ?? item) }
    }
    this.#reclaims = [outcome, ...this.#reclaims].slice(0, KEPT_OUTCOMES)
    hostLog("storage", "reclaimed", { trigger, consent, asked: ids.length, removed: outcome.removed.length, kept: outcome.kept.length, freed: outcome.freedBytes })
    return outcome
  }

  /**
   * The disk budget: under the low line, what is expendable now goes, oldest first, one item at a time, until the disk
   * is back over the line. Only `now` items: never anything in use, holding uncommitted work, or needing the person's
   * OK. Undefined when nothing went.
   */
  async #freeForDisk(lowBytes: number): Promise<ReclaimOutcome | undefined> {
    const plan = await this.plan()
    const candidates = plan.items.filter((item) => item.class === "now").sort((a, b) => (a.usedAt ?? 0) - (b.usedAt ?? 0))
    const [root] = this.#deps.roots
    const total: ReclaimOutcome = { at: new Date().toISOString(), trigger: "low disk", consent: "now", freedBytes: 0, removed: [], kept: [] }
    for (const item of candidates) {
      const disk = root ? await this.#readDisk(root) : null
      if (!disk || disk.freeBytes >= lowBytes + REARM_BYTES) break
      const outcome = await this.reclaim("now", [item.id], "low disk")
      total.freedBytes += outcome.freedBytes
      total.removed.push(...outcome.removed)
      total.kept.push(...outcome.kept)
    }
    if (!total.removed.length) return undefined
    // The pass's removals read as one in Settings › Storage, not one line an item.
    this.#reclaims = [total, ...this.#reclaims.filter((outcome) => outcome.trigger !== "low disk" || outcome.at < total.at)].slice(0, KEPT_OUTCOMES)
    return total
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

  /**
   * Under the low line (`storageLowBytes`) Mako collects, then frees what is expendable now, oldest first, and says what
   * it freed; still under it, it warns. Once an episode: again only after the disk has had room since.
   */
  async watch(): Promise<void> {
    const [root] = this.#deps.roots
    if (!root) return
    let disk = await this.#readDisk(root)
    if (!disk) return
    this.#disk = disk
    const low = storageLowBytes(disk.totalBytes)
    if (disk.freeBytes >= low + REARM_BYTES) this.#warned = false
    // Once an episode: the preview measures every store's folders, and the person is told once.
    if (disk.freeBytes >= low || this.#warned) return
    this.#warned = true
    await this.collect("low disk")
    if ((await this.budget()).autoFree) {
      const freed = await this.#freeForDisk(low).catch((error) => {
        hostWarn("storage", "the low-disk pass failed", { error: errorMessage({ error }) })
        return undefined
      })
      if (freed) {
        this.#deps.emit({
          type: "notice",
          level: "info",
          message: `The disk was nearly full, so Mako freed ${gigabytes(freed.freedBytes)}: ${describeRemoved(freed.removed)}.`,
          action: { label: "See what went", does: "open-storage" },
        })
      }
      disk = await this.#readDisk(root) ?? disk
      this.#disk = disk
    }
    if (disk.freeBytes >= low) return
    hostWarn("storage", "the disk is nearly full", { free: disk.freeBytes, total: disk.totalBytes })
    // The person is asked for the rest, in the one place that shows what's kept and what needs their OK.
    this.#deps.emit({
      type: "notice",
      level: "error",
      message: localWords(`This Mac has ${gigabytes(disk.freeBytes)} free.`),
      action: { label: `Free ${gigabytes(low - disk.freeBytes)}`, does: "open-storage" },
    })
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

/** `du -sk` of one folder, in its own low-priority process. */
async function measureFolder(path: string): Promise<number | null> {
  let stdout: string
  try {
    ;({ stdout } = await run("/usr/bin/nice", ["-n", "10", "du", "-sk", path], { timeout: MEASURE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }))
  } catch (error) {
    const partial = PartialOutputSchema.safeParse(error)
    if (!partial.success) return null
    stdout = partial.data.stdout
  }
  const kilobytes = Number(stdout.slice(0, stdout.indexOf("\t")))
  return Number.isFinite(kilobytes) ? kilobytes * 1024 : null
}

function classBytes(items: readonly ReclaimItem[], kind: ReclaimItem["class"]): number {
  return items.reduce((sum, item) => sum + (item.class === kind ? item.bytes ?? 0 : 0), 0)
}

const STORE_WORDS = {
  scratch: ["Thread's scratch", "Threads' scratch"],
  "thread-data": ["Thread's data", "Threads' data"],
  "app-data": ["Thread's old data folder", "Threads' old data folders"],
  worktrees: ["worktree", "worktrees"],
  snapshots: ["workspace's old rewind checkpoints", "workspaces' old rewind checkpoints"],
} satisfies Record<ReclaimStore, [string, string]>

/** "3 Threads' scratch, 2 worktrees": what a pass removed, by store. */
function describeRemoved(items: readonly ReclaimItem[]): string {
  const counts = new Map<ReclaimStore, number>()
  for (const item of items) counts.set(item.store, (counts.get(item.store) ?? 0) + 1)
  return [...counts].map(([store, count]) => `${count} ${STORE_WORDS[store][count === 1 ? 0 : 1]}`).join(", ")
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

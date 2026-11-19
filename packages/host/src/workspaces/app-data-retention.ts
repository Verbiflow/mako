import { randomUUID } from "node:crypto"
import { lstat, readdir, realpath, rename, rm } from "node:fs/promises"
import { join, sep } from "node:path"
import { AppKeySchema, type AppKey } from "../contracts/thread-environments.js"
import { ThreadIdSchema, type ThreadId } from "../contracts/thread-identity.js"
import type { ReclaimClass, ReclaimItem } from "../contracts/storage.js"

/** How many entries a look for recent writes reads in one folder before it judges by those it read. */
const RECENT_WALK_LIMIT = 20_000
/** A folder written this recently is in use, whoever's it is. */
const RECENT_MS = 2 * 86_400_000
/** A Thread's own folder in `thread-data` holds its registered scratch too, and the retirements under way of either. */
const REGISTERED = new Set(["scratch"])
const RETIRING = /^\.(?:scratch|data|app-data)-retiring-/

interface Deps {
  /** `<shared>/thread-data`: one folder per app key, a Thread's or a folder's. */
  root: string
  title(thread: ThreadId): string | undefined
  /** Known Threads only: an unknown id is a Thread this Mac no longer lists. */
  known(thread: ThreadId): boolean
  owner(thread: ThreadId): { quietAt: number; finishedAt?: number } | undefined
  archived(thread: ThreadId): boolean
  fin(thread: ThreadId): boolean
  /** Fins only: every Apex above it closed or archived. */
  ancestorsClosed(thread: ThreadId): boolean
  /** Who a folder's app key belongs to, in words. */
  whose(app: AppKey): string | undefined
  /** Whether an app of this key runs now; unreadable throws, and the folder is kept. */
  appRunning(app: AppKey): Promise<boolean>
  using(path: string): Promise<string[]>
  /** A complete open-file snapshot; rejection is unknown, not an empty list. */
  openFiles(): Promise<string[]>
  idleDays(): Promise<number>
  now?(): number
}

class Kept extends Error {}

/**
 * What Fins left in `thread-data/<app key>` before Thread scratch had a root of its own (#732, #759): the folder was
 * `MAKO_THREAD_DATA_DIR`, and Mako's own AGENTS.md sent scratch checkouts, benches and packaged builds there. Nothing
 * registered it, so nothing ever removed any: on one Mac it held 175 GB. A Thread's folder goes, all but its registered
 * scratch, once the Thread is archived, or is a Fin that finished under closed Apexes and stayed quiet; a finished
 * personal Thread's, a Thread this Mac no longer lists, and each folder of a project's shared app data go only when the
 * person agrees. Whatever is open, running, written in the last two days or holds a `.keep` stays.
 */
export class AppDataRetention {
  readonly store = "app-data"
  readonly #deps: Deps

  constructor(deps: Deps) { this.#deps = deps }

  #now(): number { return (this.#deps.now ?? Date.now)() }

  async items(): Promise<ReclaimItem[]> {
    const names = await readdir(this.#deps.root).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error })
    const open = await this.#deps.openFiles().catch(() => undefined)
    const items: ReclaimItem[] = []
    for (const name of names.sort()) {
      const app = AppKeySchema.safeParse(name)
      if (!app.success) continue
      const thread = ThreadIdSchema.safeParse(name)
      if (thread.success) {
        const item = await this.#threadItem(app.data, thread.data, open)
        if (item) items.push(item)
      } else for (const part of await this.#parts(join(this.#deps.root, name))) items.push(await this.#folderItem(app.data, part, open))
    }
    return items
  }

  /** Removes each item a fresh look still puts within `consent`; the rest are kept, each with why. */
  async reclaim(items: readonly ReclaimItem[], consent: "now" | "approve"): Promise<Map<string, true | string>> {
    const outcome = new Map<string, true | string>()
    for (const item of items) {
      try {
        const current = await this.#current(item)
        if (!current) throw new Kept("It is no longer there.")
        if (current.class === "keep" || (current.class === "approve" && consent === "now")) throw new Kept(current.reason)
        for (const part of current.parts ?? [current.path]) await this.#remove(part)
        outcome.set(item.id, true)
      } catch (error) { outcome.set(item.id, error instanceof Kept ? error.message : `Kept: ${error instanceof Error ? error.message : String(error)}`) }
    }
    return outcome
  }

  async #current(item: ReclaimItem): Promise<ReclaimItem | undefined> {
    const open = await this.#deps.openFiles()
    const relative = item.path.startsWith(`${this.#deps.root}${sep}`) ? item.path.slice(this.#deps.root.length + 1).split(sep) : []
    const app = AppKeySchema.safeParse(relative[0])
    if (!app.success) return undefined
    const thread = ThreadIdSchema.safeParse(relative[0])
    if (thread.success && relative.length === 1) return this.#threadItem(app.data, thread.data, open)
    if (!thread.success && relative.length === 2) {
      const present = await lstat(item.path).then(() => true, () => false)
      return present ? this.#folderItem(app.data, item.path, open) : undefined
    }
    return undefined
  }

  /** The folder's own entries, never its registered scratch or a retirement under way. */
  async #parts(folder: string): Promise<string[]> {
    const info = await lstat(folder)
    if (!info.isDirectory() || info.isSymbolicLink()) return []
    return (await readdir(folder)).filter((name) => !REGISTERED.has(name) && !RETIRING.test(name) && name !== ".keep" && name !== ".DS_Store").sort().map((name) => join(folder, name))
  }

  async #threadItem(app: AppKey, thread: ThreadId, open: string[] | undefined): Promise<ReclaimItem | undefined> {
    const path = join(this.#deps.root, thread)
    const parts = await this.#parts(path)
    if (!parts.length) return undefined
    const known = this.#deps.known(thread)
    const item: ReclaimItem = {
      id: `app-data:${path}`, store: "app-data", path, label: this.#deps.title(thread) ?? (known ? `Thread ${thread}` : "A Thread no longer listed"),
      thread, bytes: null, class: "keep", reason: "", parts,
    }
    const judged = await this.#judge(path, parts, open, async () => {
      if (!known) return ["approve", "Its Thread is no longer listed on this Mac."]
      if (await this.#deps.appRunning(app)) throw new Kept("The Thread's app is running.")
      const owner = this.#deps.owner(thread)
      if (this.#deps.archived(thread)) return ["now", "The Thread is archived."]
      if (!owner) throw new Kept("The Thread is active, elsewhere, or its state is unknown.")
      item.usedAt = owner.quietAt
      const days = await this.#deps.idleDays()
      const quiet = this.#now() - owner.quietAt >= days * 86_400_000
      if (this.#deps.fin(thread)) {
        if (owner.finishedAt === undefined) throw new Kept("The Fin hasn't finished.")
        if (!this.#deps.ancestorsClosed(thread)) return ["approve", "The Fin finished; an Apex above it is still open."]
        return quiet ? ["now", `The Fin finished and has been quiet for ${days} days.`] : ["approve", `The Fin finished; it hasn't been quiet for ${days} days.`]
      }
      return owner.finishedAt !== undefined && quiet ? ["approve", `Quiet for ${days} days, not archived.`] : ["approve", "Not archived."]
    })
    return { ...item, ...judged, usedAt: Math.max(item.usedAt ?? 0, judged.newest) || undefined }
  }

  async #folderItem(app: AppKey, path: string, open: string[] | undefined): Promise<ReclaimItem> {
    const whose = this.#deps.whose(app)
    const name = path.slice(path.lastIndexOf(sep) + 1)
    const item: ReclaimItem = { id: `app-data:${path}`, store: "app-data", path, label: `${name}, in ${whose ?? "a folder's app data"}`, ...(whose && { project: whose }), bytes: null, class: "keep", reason: "" }
    const judged = await this.#judge(path, [path], open, async () => {
      if (await this.#deps.appRunning(app)) throw new Kept("The folder's app is running.")
      return ["approve", "A folder's app data, shared by every Thread working there."]
    })
    return { ...item, ...judged, usedAt: judged.newest || undefined }
  }

  async #judge(path: string, parts: string[], open: string[] | undefined, classify: () => Promise<[ReclaimClass, string]>): Promise<{ class: ReclaimClass; reason: string; newest: number }> {
    let newest = 0
    try {
      if (await realpath(path) !== path) throw new Kept("The folder is a link.")
      if (await lstat(join(path, ".keep")).then(() => true, () => false)) throw new Kept("Explicitly kept.")
      if (!open) throw new Kept("Open-file inspection is unavailable.")
      if (open.some((file) => file === path || file.startsWith(`${path}${sep}`)) || (await this.#deps.using(path)).length)
        throw new Kept("A provider, terminal or process has it open.")
      for (const part of parts) newest = Math.max(newest, await newestWrite(part))
      if (this.#now() - newest < RECENT_MS) throw new Kept("Written in the last two days.")
      const [verdict, reason] = await classify()
      return { class: verdict, reason, newest }
    } catch (error) {
      return { class: "keep", reason: error instanceof Kept ? error.message : "A guard could not be read; it is kept.", newest }
    }
  }

  async #remove(path: string): Promise<void> {
    const parent = path.slice(0, path.lastIndexOf(sep))
    const info = await lstat(path)
    const aside = join(parent, `.app-data-retiring-${randomUUID()}`)
    await rename(path, aside)
    const moved = await lstat(aside)
    if (moved.ino !== info.ino || moved.dev !== info.dev) throw new Kept("The folder changed as it was removed; it is kept aside for review.")
    // Links inside are removed as links, never followed.
    await rm(aside, { recursive: true, force: false })
  }
}

/** The newest modification time in a tree, reading at most `RECENT_WALK_LIMIT` entries; links are not followed. */
async function newestWrite(path: string): Promise<number> {
  const info = await lstat(path)
  let newest = info.mtimeMs, read = 0
  if (!info.isDirectory()) return newest
  const queue = [path]
  while (queue.length && read < RECENT_WALK_LIMIT) {
    const folder = queue.shift()!
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (++read > RECENT_WALK_LIMIT) break
      const child = join(folder, entry.name)
      const stat = await lstat(child).catch(() => undefined)
      if (!stat) continue
      newest = Math.max(newest, stat.mtimeMs)
      if (entry.isDirectory()) queue.push(child)
    }
  }
  return newest
}

import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises"
import { dirname, join, sep } from "node:path"
import { z } from "zod"
import { edgeStopped } from "../contracts/agents.js"
import { ThreadIdSchema, type ThreadId } from "../contracts/thread-identity.js"
import type { ThreadStore } from "../threads/index.js"
import type { ThreadScratchEntry, ThreadScratchReport, ThreadScratchSettings } from "../contracts/thread-scratch.js"
import type { ReclaimItem } from "../contracts/storage.js"

export const SCRATCH_PASS_MS = 60 * 60_000
export const ThreadScratchSettingsSchema = z.object({
  mode: z.enum(["preview", "remove"]), dataMode: z.enum(["preview", "remove"]).default("preview"), idleDays: z.number().int().min(1).max(3650), kept: z.array(ThreadIdSchema).max(10_000),
}).strict()
const RecordSchema = z.object({
  thread: ThreadIdSchema, generation: z.string().uuid(), usedAt: z.number().finite(),
  retiring: z.boolean().optional(),
  identity: z.object({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) }).strict().optional(),
}).strict()
type Record = z.infer<typeof RecordSchema>
const OwnerReceiptSchema = z.object({ pid: z.number().int().positive().max(2_147_483_647) })
class ScratchRefused extends Error {}
/** A guard the person may waive (Settings › Storage, "Needs your OK"): a waiting period, or an ancestor still open. */
class ScratchWaits extends ScratchRefused {}
/**
 * Scratch goes by default: agents are told it is disposable, and before it did, a Mac filled with 35 GB in one
 * Thread's scratch and nothing ever removed any. Three quiet days, since a personal Thread "finishes" with every turn.
 */
export const DEFAULT_SCRATCH_SETTINGS: ThreadScratchSettings = { mode: "remove", dataMode: "preview", idleDays: 3, kept: [] }
interface Deps {
  /** Only registered roots under this namespace are removable; legacy app folders are never adopted. */
  root: string
  kind?: "data"
  /** Host-owned metadata, outside the disposable folder. */
  registry: string
  settings: string
  owner(thread: ThreadId): { quietAt: number; finishedAt?: number } | undefined
  /** Data may outlive its Fin while any ancestor still relies on its packets. Unknown is a hold. */
  ancestorsClosed?(thread: ThreadId): boolean
  /** Every Session of the Thread archived: it goes without waiting out its quiet days. Unknown is false. */
  archived?(thread: ThreadId): boolean
  /** A Fin's finish is its end; a personal Thread finishes with every turn, so only its quiet days count. */
  fin?(thread: ThreadId): boolean
  title?(thread: ThreadId): string | undefined
  using(path: string, thread: ThreadId): Promise<string[]>
  /** A complete open-file snapshot; rejection is unknown, not an empty list. */
  openFiles(): Promise<string[]>
  /** Exclusive bytes where the platform can measure them; null is never represented as zero. */
  privateBytes(path: string): Promise<number | null>
  now?(): number
}

/** Every ancestor must be explicitly closed or archived, including a top Apex with no parent edge. */
export function threadDataAncestorsClosed(store: Pick<ThreadStore, "thread" | "edges" | "threadConversations">, archived: ((conversation: string) => boolean | undefined) | undefined, thread: ThreadId): boolean {
  const edges = store.edges(), edge = edges.of(thread)
  if (!edge) return false
  const seen = new Set<ThreadId>([thread])
  let ancestor = edge.parent
  for (;;) {
    if (seen.has(ancestor) || !store.thread(ancestor)) return false
    seen.add(ancestor)
    const parent = edges.of(ancestor)
    // Stopped, never only closed for having finished (`closedFinished`): that close is Mako's own, and says nothing of
    // whether its Thread's data is still wanted.
    if (!edgeStopped(parent)) {
      const sessions = store.threadConversations([ancestor]).get(ancestor)
      if (!sessions?.length || !sessions.every(journals => {
        const current = journals.at(-1)
        return current !== undefined && archived?.(current) === true
      })) return false
    }
    if (!parent) return true
    ancestor = parent.parent
  }
}

/** Every Session of the Thread archived on this host; a Thread with none, or any unknown, is not. */
export function threadArchived(store: Pick<ThreadStore, "thread" | "threadConversations">, archived: ((conversation: string) => boolean | undefined) | undefined, thread: ThreadId): boolean {
  if (!archived || !store.thread(thread)) return false
  const sessions = store.threadConversations([thread]).get(thread)
  return Boolean(sessions?.length) && sessions!.every((journals) => {
    const current = journals.at(-1)
    return current !== undefined && archived(current) === true
  })
}

/** One registered data or scratch root per Thread, never a shared app folder or a name-based sweep. */
export class ThreadScratch {
  readonly #deps: Deps
  readonly #acquisitions = new Map<ThreadId, Promise<string>>()
  #pass: Promise<ThreadScratchReport> | undefined
  #timer: NodeJS.Timeout | undefined
  #closed = false
  constructor(deps: Deps) { this.#deps = deps }

  get kind(): "scratch" | "data" { return this.#deps.kind ?? "scratch" }
  get store(): "scratch" | "thread-data" { return this.kind === "data" ? "thread-data" : "scratch" }
  path(thread: ThreadId): string { return join(this.#deps.root, ThreadIdSchema.parse(thread), this.kind) }
  #note(thread: ThreadId): string { return join(this.#deps.registry, `${ThreadIdSchema.parse(thread)}.json`) }
  #now(): number { return (this.#deps.now ?? Date.now)() }

  async settings(): Promise<ThreadScratchSettings> {
    const text = await readFile(this.#deps.settings, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    return text === null ? { ...DEFAULT_SCRATCH_SETTINGS, kept: [] } : ThreadScratchSettingsSchema.parse(JSON.parse(text))
  }

  async configure(value: ThreadScratchSettings): Promise<void> {
    const settings = ThreadScratchSettingsSchema.parse(value)
    await this.#settingsLocked(() => this.#publish(this.#deps.settings, settings))
  }

  async #publish(path: string, value: Record | ThreadScratchSettings): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    try { await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 }); await rename(temporary, path) }
    finally { await rm(temporary, { force: true }) }
  }

  async #record(thread: ThreadId): Promise<Record | undefined> {
    const path = this.#note(thread)
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error })
    if (!info) return undefined
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new ScratchRefused("Scratch ownership metadata is not a private regular file.")
    const record = RecordSchema.parse(JSON.parse(await readFile(path, "utf8")))
    if (record.thread !== thread) throw new ScratchRefused("Scratch ownership does not match its Thread.")
    return record
  }

  async #identity(thread: ThreadId): Promise<NonNullable<Record["identity"]>> {
    const root = await realpath(this.#deps.root), path = this.path(thread)
    const expected = join(root, thread, this.kind)
    const info = await lstat(path, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== expected)
      throw new ScratchRefused("The scratch root or its parent is linked or no longer owned here.")
    return { device: String(info.dev), inode: String(info.ino) }
  }

  async #locked<T>(thread: ThreadId, work: () => Promise<T>): Promise<T> {
    await mkdir(this.#deps.registry, { recursive: true, mode: 0o700 })
    if (await realpath(this.#deps.registry) !== this.#deps.registry) throw new ScratchRefused("Scratch ownership metadata is linked.")
    return this.#guardedLock(join(this.#deps.registry, `${thread}.lock`), work)
  }

  async #settingsLocked<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.#deps.settings), { recursive: true, mode: 0o700 })
    return this.#guardedLock(`${this.#deps.settings}.lock`, work)
  }

  async #guardedLock<T>(lock: string, work: () => Promise<T>): Promise<T> {
    await mkdir(lock, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw new ScratchRefused("Scratch ownership or settings are busy, or an earlier owner needs review.")
      throw error
    })
    const identity = await lstat(lock, { bigint: true })
    const result = await work().then(value => ({ kind: "value", value } as const), error => ({ kind: "error", error } as const))
    try {
      const current = await lstat(lock, { bigint: true })
      if (current.dev !== identity.dev || current.ino !== identity.ino) throw new ScratchRefused("Scratch lock ownership changed; it is kept for review.")
      await rmdir(lock)
    } catch (cleanup) {
      if (result.kind === "error") throw new AggregateError([result.error, cleanup], "Scratch operation and lock cleanup failed.", { cause: cleanup })
      throw cleanup
    }
    if (result.kind === "error") throw result.error
    return result.value
  }

  /** Called before a provider launch; an existing unregistered folder is never adopted. */
  ensure(thread: ThreadId): Promise<string> {
    ThreadIdSchema.parse(thread)
    const held = this.#acquisitions.get(thread)
    if (held) return held
    const pending = this.#ensure(thread).finally(() => { if (this.#acquisitions.get(thread) === pending) this.#acquisitions.delete(thread) })
    this.#acquisitions.set(thread, pending)
    return pending
  }

  async #ensure(thread: ThreadId): Promise<string> {
    return this.#locked(thread, async () => {
      if (this.#closed) throw new ScratchRefused("Scratch ownership is stopping.")
      let record = await this.#record(thread)
      if (record && (record.retiring || !record.identity))
        throw new ScratchRefused("Scratch acquisition is incomplete or its folder was replaced.")
      const path = this.path(thread)
      const present = await lstat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error })
      if (!record || !present) {
        if (present)
          throw new ScratchRefused("An unregistered scratch folder already exists; it is kept for review.")
        record = { thread, generation: randomUUID(), usedAt: this.#now() }
        // Durable intent precedes acquiring the disposable folder. An incomplete acquisition remains held.
        await this.#publish(this.#note(thread), record)
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        if (await realpath(dirname(path)) !== join(await realpath(this.#deps.root), thread)) throw new ScratchRefused("Scratch parent is linked.")
        await mkdir(path, { mode: 0o700 })
        record.identity = await this.#identity(thread)
      }
      if (record.retiring || !record.identity || JSON.stringify(await this.#identity(thread)) !== JSON.stringify(record.identity))
        throw new ScratchRefused("Scratch acquisition is incomplete or its folder was replaced.")
      record.usedAt = this.#now()
      await this.#publish(this.#note(thread), record)
      return this.path(thread)
    })
  }

  /** A receipt holds its tree until its creator is positively absent, even with no open files. */
  async #receiptHeld(path: string): Promise<boolean> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.name.endsWith(".owner.json")) {
        const info = await lstat(child)
        if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) return true
        const parsed = OwnerReceiptSchema.safeParse(JSON.parse(await readFile(child, "utf8")))
        if (!parsed.success) return true
        try { process.kill(parsed.data.pid, 0); return true }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) return true }
      } else if (entry.isDirectory() && await this.#receiptHeld(child)) return true
    }
    return false
  }

  /** `waive`: the person agreed to remove it, so only a waiting period or an open ancestor no longer keeps it. */
  async #inspect(thread: ThreadId, settings: ThreadScratchSettings, open: string[] | undefined, waive = false): Promise<ThreadScratchEntry> {
    const entry: ThreadScratchEntry = { kind: this.kind, thread, title: this.#deps.title?.(thread), path: this.path(thread), privateBytes: null, reason: "Ownership is unavailable.", eligible: false, class: "keep" }
    // A waiting period or an open ancestor is noted and the rest still looked at, so "Needs your OK" lists only roots
    // nothing uses.
    let waits: string | undefined
    const wait = (reason: string) => { waits ??= reason }
    try {
      if (this.#closed) throw new ScratchRefused("The host is stopping.")
      const record = await this.#record(thread)
      if (record?.retiring) {
        entry.retainedPath = join(dirname(entry.path), `.${this.kind}-retiring-${record.generation}`)
        throw new ScratchRefused("A previous retirement is unconfirmed; its generation is kept for review.")
      }
      if (!record?.identity) throw new ScratchRefused("No complete ownership record; legacy and incomplete scratch are kept.")
      entry.generation = record.generation; entry.usedAt = record.usedAt
      if (JSON.stringify(await this.#identity(thread)) !== JSON.stringify(record.identity)) throw new ScratchRefused("The owned scratch folder was replaced.")
      if (settings.kept.includes(thread) || await lstat(join(entry.path, ".keep")).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error }))
        throw new ScratchRefused("Explicitly kept.")
      const owner = this.#deps.owner(thread)
      if (!owner) throw new ScratchRefused("The Thread is active, elsewhere, or its state is unknown.")
      const quietAt = Math.max(owner.quietAt, record.usedAt)
      const finished = owner.finishedAt !== undefined && owner.finishedAt >= record.usedAt
      const archived = this.#deps.archived?.(thread) === true, fin = this.#deps.fin?.(thread) === true
      const quiet = this.#now() - quietAt >= settings.idleDays * 86_400_000
      if (this.kind === "data" && !archived) {
        if (!fin) throw new ScratchRefused("A personal Thread keeps its data until it is archived.")
        if (!finished) throw new ScratchRefused("Thread data requires a finished owner; idle alone is not enough.")
        if (this.#deps.ancestorsClosed?.(thread) !== true) wait("An ancestor Apex is open or its closure is unknown.")
      }
      if (this.kind !== "data" && !archived && !(fin && finished) && !quiet)
        wait(`The Thread has not been quiet for ${settings.idleDays} days.`)
      if (!open) throw new ScratchRefused("Open-file inspection is unavailable.")
      if ((await this.#deps.using(entry.path, thread)).length || open.some(path => path === entry.path || path.startsWith(`${entry.path}${sep}`)))
        throw new ScratchRefused("A provider, terminal or process has this scratch open.")
      if (await this.#receiptHeld(entry.path)) throw new ScratchRefused("A scratch receipt's process is live or its absence is unknown.")
      entry.privateBytes = await this.#deps.privateBytes(entry.path)
      if (JSON.stringify(this.#deps.owner(thread)) !== JSON.stringify(owner) || JSON.stringify(await this.#record(thread)) !== JSON.stringify(record) ||
        JSON.stringify(await this.#identity(thread)) !== JSON.stringify(record.identity)) throw new ScratchRefused("The Thread or scratch changed during inspection.")
      if (this.kind === "data" && !waive && !archived && this.#deps.ancestorsClosed?.(thread) !== true) throw new ScratchRefused("An ancestor reopened during inspection.")
      if ((this.#deps.archived?.(thread) === true) !== archived) throw new ScratchRefused("The Thread or scratch changed during inspection.")
      if (waits && !waive) throw new ScratchWaits(waits)
      entry.eligible = true; entry.class = "now"
      entry.reason = waits ?? (archived ? "The Thread is archived." : fin && finished ? "The Fin finished." : `Quiet for ${settings.idleDays} days.`)
    } catch (error) {
      entry.reason = error instanceof ScratchRefused ? error.message : "A scratch guard could not be read; it is kept for review."
      if (error instanceof ScratchWaits) entry.class = "approve"
    }
    return entry
  }

  async preview(): Promise<ThreadScratchReport> {
    const settings = await this.settings(), entries: ThreadScratchEntry[] = []
    const names = await readdir(this.#deps.registry).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error })
    const open = names.length ? await this.#deps.openFiles().catch(() => undefined) : []
    for (const name of names) {
      const parsed = ThreadIdSchema.safeParse(name.endsWith(".json") ? name.slice(0, -5) : "")
      if (parsed.success) entries.push(await this.#inspect(parsed.data, settings, open))
    }
    return { settings, entries, at: this.#now(), everyMs: SCRATCH_PASS_MS }
  }

  run(): Promise<ThreadScratchReport> {
    this.#pass ??= this.#run().finally(() => { this.#pass = undefined })
    return this.#pass
  }

  async #run(): Promise<ThreadScratchReport> {
    const settings = await this.settings()
    if ((this.kind === "data" ? settings.dataMode : settings.mode) !== "remove" || this.#closed) return { settings, entries: [], at: this.#now(), everyMs: SCRATCH_PASS_MS }
    const report = await this.preview()
    for (const planned of report.entries) {
      if (!planned.eligible) continue
      try {
        await this.#retire(planned, false, (settings) => (this.kind === "data" ? settings.dataMode : settings.mode) === "remove")
        planned.removed = true
      } catch (error) { planned.eligible = false; planned.class = "keep"; planned.reason = error instanceof ScratchRefused ? error.message : "Scratch cleanup is unknown; kept for review." }
    }
    return report
  }

  /** Settings › Storage's rows: each registered root with how expendable it is. Sizes are the caller's to measure. */
  async items(): Promise<ReclaimItem[]> {
    const store = this.kind === "data" ? "thread-data" : "scratch"
    return (await this.preview()).entries.map((entry) => ({
      id: `${store}:${entry.path}`, store, path: entry.path, label: entry.title ?? `Thread ${entry.thread}`, thread: entry.thread,
      bytes: entry.privateBytes, ...(entry.usedAt !== undefined && { usedAt: entry.usedAt }), class: entry.class ?? "keep", reason: entry.reason,
    }))
  }

  /**
   * Removes what the person or the low-disk pass asked for, each looked at again first: `now` only what is still
   * eligible, `approve` also what only a waiting period or an open ancestor kept. Nothing in use, kept or held goes.
   */
  async reclaim(items: readonly ReclaimItem[], consent: "now" | "approve"): Promise<Map<string, true | string>> {
    const outcome = new Map<string, true | string>()
    for (const item of items) {
      const thread = ThreadIdSchema.safeParse(item.thread)
      if (!thread.success || item.path !== this.path(thread.data)) { outcome.set(item.id, "Not a registered root of this store."); continue }
      try {
        await this.#retire({ thread: thread.data, path: item.path }, consent === "approve", () => true)
        outcome.set(item.id, true)
      } catch (error) { outcome.set(item.id, error instanceof ScratchRefused ? error.message : "Scratch cleanup is unknown; kept for review.") }
    }
    return outcome
  }

  async #retire(planned: { thread: ThreadId; path: string; generation?: string }, waive: boolean, enabled: (settings: ThreadScratchSettings) => boolean): Promise<void> {
    await this.#settingsLocked(() => this.#locked(planned.thread, async () => {
      const settings = await this.settings(), open = await this.#deps.openFiles()
      const current = await this.#inspect(planned.thread, settings, open, waive)
      if (!enabled(settings) || !current.eligible || (planned.generation !== undefined && current.generation !== planned.generation)) throw new ScratchRefused(current.eligible ? "Scratch retirement changed or was cancelled." : current.reason)
      const record = await this.#record(planned.thread)
      if (!record?.identity || record.retiring) throw new ScratchRefused("Scratch ownership disappeared.")
      const parent = dirname(planned.path), retired = join(parent, `.${this.kind}-retiring-${record.generation}`)
      if (this.#closed) throw new ScratchRefused("The host is stopping; scratch retirement was cancelled.")
      await this.#publish(this.#note(planned.thread), { ...record, retiring: true })
      if (this.#closed) throw new ScratchRefused("The host stopped after retirement intent; the generation is kept for review.")
      if (this.kind === "data" && !waive && this.#deps.archived?.(planned.thread) !== true && this.#deps.ancestorsClosed?.(planned.thread) !== true) throw new ScratchRefused("An ancestor reopened after retirement intent; the generation is kept for review.")
      await rename(planned.path, retired)
      const info = await lstat(retired, { bigint: true })
      if (String(info.dev) !== record.identity.device || String(info.ino) !== record.identity.inode || !info.isDirectory() || info.isSymbolicLink())
        throw new ScratchRefused("Scratch retirement identity is unknown; it is kept for review.")
      // The registered generation only: never an app or legacy Thread folder. Nested links are not followed.
      await rm(retired, { recursive: true, force: false })
      await rm(this.#note(planned.thread))
    }))
  }

  changed(): void {
    if (this.#closed || this.#timer) return
    this.#timer = setTimeout(() => { this.#timer = undefined; void this.run().catch(() => undefined) }, 60_000)
    this.#timer.unref()
  }
  close(): void { this.#closed = true; clearTimeout(this.#timer); this.#timer = undefined }
}

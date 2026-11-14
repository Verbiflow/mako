import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises"
import { dirname, join, sep } from "node:path"
import { z } from "zod"
import { ThreadIdSchema, type ThreadId } from "../contracts/thread-identity.js"
import type { ThreadScratchEntry, ThreadScratchReport, ThreadScratchSettings } from "../contracts/thread-scratch.js"

export const SCRATCH_PASS_MS = 60 * 60_000
export const ThreadScratchSettingsSchema = z.object({
  mode: z.enum(["preview", "remove"]), idleDays: z.number().int().min(1).max(3650), kept: z.array(ThreadIdSchema).max(10_000),
}).strict()
const RecordSchema = z.object({
  thread: ThreadIdSchema, generation: z.string().uuid(), usedAt: z.number().finite(),
  retiring: z.boolean().optional(),
  identity: z.object({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) }).strict().optional(),
}).strict()
type Record = z.infer<typeof RecordSchema>
class ScratchRefused extends Error {}
interface Deps {
  /** The existing thread-data folder; only <ThreadId>/scratch is disposable. */
  root: string
  /** Host-owned metadata, outside the disposable folder. */
  registry: string
  settings: string
  owner(thread: ThreadId): { quietAt: number; finishedAt?: number } | undefined
  title?(thread: ThreadId): string | undefined
  using(path: string): Promise<string[]>
  /** A complete open-file snapshot; rejection is unknown, not an empty list. */
  openFiles(): Promise<string[]>
  /** Exclusive bytes where the platform can measure them; null is never represented as zero. */
  privateBytes(path: string): Promise<number | null>
  now?(): number
}

/** One disposable root per Thread, never a shared app folder or a name-based sweep. */
export class ThreadScratch {
  readonly #deps: Deps
  readonly #acquisitions = new Map<ThreadId, Promise<string>>()
  #pass: Promise<ThreadScratchReport> | undefined
  #timer: NodeJS.Timeout | undefined
  #closed = false
  constructor(deps: Deps) { this.#deps = deps }

  path(thread: ThreadId): string { return join(this.#deps.root, ThreadIdSchema.parse(thread), "scratch") }
  #note(thread: ThreadId): string { return join(this.#deps.registry, `${ThreadIdSchema.parse(thread)}.json`) }
  #now(): number { return (this.#deps.now ?? Date.now)() }

  async settings(): Promise<ThreadScratchSettings> {
    const text = await readFile(this.#deps.settings, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    return text === null ? { mode: "preview", idleDays: 7, kept: [] } : ThreadScratchSettingsSchema.parse(JSON.parse(text))
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
    const expected = join(root, thread, "scratch")
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
      if (!record) {
        const path = this.path(thread)
        if (await lstat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error }))
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

  async #inspect(thread: ThreadId, settings: ThreadScratchSettings, open: string[] | undefined): Promise<ThreadScratchEntry> {
    const entry: ThreadScratchEntry = { thread, title: this.#deps.title?.(thread), path: this.path(thread), privateBytes: null, reason: "Ownership is unavailable.", eligible: false }
    try {
      if (this.#closed) throw new ScratchRefused("The host is stopping.")
      const record = await this.#record(thread)
      if (record?.retiring) {
        entry.retainedPath = join(dirname(entry.path), `.scratch-retiring-${record.generation}`)
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
      if (!finished && this.#now() - quietAt < settings.idleDays * 86_400_000)
        throw new ScratchRefused(`The Thread has not been quiet for ${settings.idleDays} days.`)
      if (!open) throw new ScratchRefused("Open-file inspection is unavailable.")
      if ((await this.#deps.using(entry.path)).length || open.some(path => path === entry.path || path.startsWith(`${entry.path}${sep}`)))
        throw new ScratchRefused("A provider, terminal or process has this scratch open.")
      entry.privateBytes = await this.#deps.privateBytes(entry.path)
      if (JSON.stringify(this.#deps.owner(thread)) !== JSON.stringify(owner) || JSON.stringify(await this.#record(thread)) !== JSON.stringify(record) ||
        JSON.stringify(await this.#identity(thread)) !== JSON.stringify(record.identity)) throw new ScratchRefused("The Thread or scratch changed during inspection.")
      entry.eligible = true; entry.reason = finished ? "The Thread finished." : "Idle scratch."
    } catch (error) { entry.reason = error instanceof ScratchRefused ? error.message : "A scratch guard could not be read; it is kept for review." }
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
    if (settings.mode === "preview" || this.#closed) return { settings, entries: [], at: this.#now(), everyMs: SCRATCH_PASS_MS }
    const report = await this.preview()
    for (const planned of report.entries) {
      if (!planned.eligible) continue
      try {
        await this.#settingsLocked(() => this.#locked(planned.thread, async () => {
          const settings = await this.settings(), open = await this.#deps.openFiles()
          const current = await this.#inspect(planned.thread, settings, open)
          if (settings.mode !== "remove" || !current.eligible || current.generation !== planned.generation) throw new ScratchRefused("Scratch retirement changed or was cancelled.")
          const record = await this.#record(planned.thread)
          if (!record?.identity || record.retiring) throw new ScratchRefused("Scratch ownership disappeared.")
          const parent = dirname(planned.path), retired = join(parent, `.scratch-retiring-${record.generation}`)
          if (this.#closed) throw new ScratchRefused("The host is stopping; scratch retirement was cancelled.")
          await this.#publish(this.#note(planned.thread), { ...record, retiring: true })
          if (this.#closed) throw new ScratchRefused("The host stopped after retirement intent; the generation is kept for review.")
          await rename(planned.path, retired)
          const info = await lstat(retired, { bigint: true })
          if (String(info.dev) !== record.identity.device || String(info.ino) !== record.identity.inode || !info.isDirectory() || info.isSymbolicLink())
            throw new ScratchRefused("Scratch retirement identity is unknown; it is kept for review.")
          // Never remove the Thread/app's data directory. Nested symlinks are removed as links, not followed.
          await rm(retired, { recursive: true, force: false })
          await rm(this.#note(planned.thread))
          planned.removed = true
        }))
      } catch (error) { planned.eligible = false; planned.reason = error instanceof ScratchRefused ? error.message : "Scratch cleanup is unknown; kept for review." }
    }
    return report
  }

  changed(): void {
    if (this.#closed || this.#timer) return
    this.#timer = setTimeout(() => { this.#timer = undefined; void this.run().catch(() => undefined) }, 60_000)
    this.#timer.unref()
  }
  close(): void { this.#closed = true; clearTimeout(this.#timer); this.#timer = undefined }
}

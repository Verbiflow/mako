import { persistThreadAttachments } from "./attachment-storage.js"
/** Durable normalized history. Metadata and content commit in the same SQLite row. */
import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { DatabaseSync } from "node:sqlite"
import { ThreadEntrySchema, ThreadRefSchema } from "./thread-schema.js"
import { SessionSettingsSchema } from "./settings.js"
import type { Thread, ThreadRef } from "./format.js"

const ArchiveIndexRow = z.object({ ref: z.string(), revision: z.string() })
const ArchiveContentRow = z.object({ ref: z.string(), entries: z.string() })
const ArchivedThreadRefSchema = ThreadRefSchema.extend({
  settings: SessionSettingsSchema.extend({
    model: z.string().transform((model) => model || undefined).optional(),
  }).optional(),
})

/**
 * A capture re-translates and rewrites the whole thread, so it waits for the
 * session to go quiet rather than following every burst: nothing is lost by
 * waiting, since the native store is still the source until then.
 */
const SETTLE_MS = 3_000
/** A session an agent streams into for minutes is still captured this often. */
const MAX_WAIT_MS = 60_000

interface Capture {
  ref: ThreadRef
  read: () => Promise<Thread | null>
}

interface Scheduled {
  timer: NodeJS.Timeout
  /** When the first uncaptured change of this run was noted. */
  since: number
}

export class SessionArchive {
  private root: string
  private database: DatabaseSync | null = null
  private index = new Map<string, ThreadRef>()
  private revisions = new Map<string, string>()
  private loaded: Promise<void> | null = null
  private timers = new Map<string, Scheduled>()
  private pending = new Map<string, Capture>()
  private deleted = new Set<string>()
  private queue: Promise<void> = Promise.resolve()
  private stopping: Promise<void> | null = null

  constructor(root: string) {
    this.root = root
  }

  load(): Promise<void> {
    this.loaded ??= this.initialize()
    return this.loaded
  }

  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const database = new DatabaseSync(join(this.root, "archive.sqlite"))
    database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (
        path TEXT PRIMARY KEY,
        ref TEXT NOT NULL,
        entries TEXT NOT NULL,
        revision TEXT NOT NULL
      );
    `)
    this.database = database
    for (const value of database
      .prepare("SELECT ref, revision FROM sessions")
      .all()) {
      const row = ArchiveIndexRow.parse(value)
      const ref = ArchivedThreadRefSchema.parse(JSON.parse(row.ref))
      this.index.set(ref.path, { ...ref, locked: false, archived: true })
      this.revisions.set(ref.path, row.revision)
    }
    // Existing archives remain readable. Upgrade each lazily on its next capture.
    const dirs = await readdir(this.root, { withFileTypes: true })
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue
      try {
        const ref = ArchivedThreadRefSchema.parse(
          JSON.parse(
            await readFile(join(this.root, dir.name, "ref.json"), "utf8")
          )
        )
        if (ref.path && !this.index.has(ref.path))
          this.index.set(ref.path, { ...ref, locked: false, archived: true })
      } catch {
        // Incomplete legacy directories have no committed history to expose.
      }
    }
  }

  orphans(livePaths: ReadonlySet<string>): ThreadRef[] {
    return [...this.index.values()].filter((ref) => !livePaths.has(ref.path))
  }

  has(path: string): boolean {
    return this.index.has(path)
  }

  note(ref: ThreadRef, read: () => Promise<Thread | null>): void {
    if (
      this.stopping ||
      this.deleted.has(ref.path) ||
      this.revisions.get(ref.path) === revisionOf(ref)
    )
      return
    this.pending.set(ref.path, { ref, read })
    // Each change restarts the settle window, but the deadline set by the
    // first change of the run holds: repeated updates never postpone a
    // capture past it.
    const now = Date.now()
    const held = this.timers.get(ref.path)
    if (held) clearTimeout(held.timer)
    const since = held?.since ?? now
    const delay = Math.max(0, Math.min(SETTLE_MS, since + MAX_WAIT_MS - now))
    const timer = setTimeout(() => {
      this.timers.delete(ref.path)
      const capture = this.pending.get(ref.path)
      this.pending.delete(ref.path)
      if (capture) this.enqueue(capture)
    }, delay)
    timer.unref()
    this.timers.set(ref.path, { timer, since })
  }

  /** Wait until all currently scheduled captures have committed. */
  async flush(): Promise<void> {
    for (const held of this.timers.values()) clearTimeout(held.timer)
    this.timers.clear()
    for (const capture of this.pending.values()) this.enqueue(capture)
    this.pending.clear()
    await this.queue
  }

  async read(path: string): Promise<Thread | null> {
    await this.load()
    const value = this.database
      ?.prepare("SELECT ref, entries FROM sessions WHERE path = ?")
      .get(path)
    if (value) {
      const row = ArchiveContentRow.parse(value)
      const ref = ArchivedThreadRefSchema.parse(JSON.parse(row.ref))
      const entries = z.array(ThreadEntrySchema).parse(JSON.parse(row.entries))
      return { ref: { ...ref, locked: false, archived: true }, entries }
    }
    const ref = this.index.get(path)
    if (!ref) return null
    try {
      const raw = await readFile(
        join(this.legacyDir(path), "entries.jsonl"),
        "utf8"
      )
      const entries = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => ThreadEntrySchema.parse(JSON.parse(line)))
      return { ref, entries }
    } catch {
      return null
    }
  }

  async forget(path: string): Promise<void> {
    this.deleted.add(path)
    const held = this.timers.get(path)
    if (held) clearTimeout(held.timer)
    this.timers.delete(path)
    this.pending.delete(path)
    await this.load()
    await this.queue.catch(() => {})
    this.database?.prepare("DELETE FROM sessions WHERE path = ?").run(path)
    this.index.delete(path)
    this.revisions.delete(path)
    await rm(this.legacyDir(path), { recursive: true, force: true })
  }

  stop(): Promise<void> {
    this.stopping ??= this.flush().finally(() => {
      this.database?.close()
      this.database = null
    })
    return this.stopping
  }

  private enqueue(capture: Capture): void {
    this.queue = this.queue
      .catch(() => {})
      .then(() => this.write(capture.ref, capture.read))
    void this.queue.catch((error: Error) =>
      console.error("Session archive capture failed", error.message)
    )
  }

  private async write(
    ref: ThreadRef,
    read: () => Promise<Thread | null>
  ): Promise<void> {
    await this.load()
    const native = await read()
    if (!native || this.deleted.has(ref.path)) return
    const thread = await persistThreadAttachments(
      { ...native, ref: ThreadRefSchema.parse(native.ref) },
      join(this.root, "assets"),
      await this.read(ref.path)
    )
    if (this.deleted.has(ref.path)) return
    const revision = revisionOf(thread.ref)
    // A single statement atomically commits metadata, source revision and all content.
    // The entry count is never used as a content revision.
    if (!this.database) throw new Error("Session archive is closed")
    this.database
      .prepare(
        `
      INSERT INTO sessions (path, ref, entries, revision) VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET ref=excluded.ref, entries=excluded.entries, revision=excluded.revision
    `
      )
      .run(
        ref.path,
        JSON.stringify(thread.ref),
        JSON.stringify(thread.entries),
        revision
      )
    this.index.set(ref.path, { ...thread.ref, locked: false, archived: true })
    this.revisions.set(ref.path, revision)
  }

  private legacyDir(path: string): string {
    return join(
      this.root,
      createHash("sha1").update(path).digest("hex").slice(0, 24)
    )
  }
}

function revisionOf(ref: ThreadRef): string {
  return JSON.stringify([
    ref.revision,
    ref.bytes,
    ref.updatedAt,
    ref.title,
    ref.model,
  ])
}

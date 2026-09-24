import { persistThreadAttachments } from "./attachment-storage.js"
/** Durable normalized history. Metadata and content commit in the same SQLite row. */
import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { DatabaseSync } from "node:sqlite"
import { ThreadEntrySchema, ThreadRefSchema } from "./thread-schema.js"
import { SessionSettingsSchema } from "./settings.js"
import type { Thread, ThreadRef } from "./format.js"

const ArchiveIndexRow = z.object({ ref: z.string() })
const CaptureStateRow = z.object({
  token: z.string(),
  deleted: z.union([z.literal(0), z.literal(1)]),
  revision: z.string().nullable(),
})
const ArchiveContentRow = z.object({ ref: z.string(), entries: z.string() })
const ArchivedThreadRefSchema = ThreadRefSchema.extend({
  settings: SessionSettingsSchema.extend({
    model: z
      .string()
      .transform((model) => model || undefined)
      .optional(),
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
  /** Read current native state on every call, including conflict retries.
   * Do not close over an already translated snapshot. */
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
  private dataVersion = -1
  private latest = new Map<string, Capture>()
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
    this.loaded ??= this.initialize().catch((error: Error) => {
      this.dataVersion = -1
      this.loaded = null
      throw error
    })
    return this.loaded
  }

  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const database = new DatabaseSync(join(this.root, "archive.sqlite"))
    try {
      // Persisted triggers reject writes from older hosts while leaving their reads intact.
      database.function("mako_archive_writer", () => 1)
      database.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL")
      await enableWal(database)
      // Migration and writer fencing become visible together. No asynchronous work
      // or source/attachment reads occur while SQLite's write lock is held.
      database.exec("BEGIN IMMEDIATE")
      try {
        const version = z
          .object({ user_version: z.number() })
          .parse(database.prepare("PRAGMA user_version").get()).user_version
        if (version > 1)
          throw new Error("Update Mako to open this session archive format")
        if (version === 0) {
          database.exec(`
          CREATE TABLE IF NOT EXISTS sessions (
            path TEXT PRIMARY KEY,
            ref TEXT NOT NULL,
            entries TEXT NOT NULL,
            revision TEXT NOT NULL
          );
          CREATE TABLE archive_captures (
            path TEXT PRIMARY KEY,
            token TEXT NOT NULL,
            deleted INTEGER NOT NULL CHECK (deleted IN (0, 1))
          );
          INSERT INTO archive_captures
            SELECT path, lower(hex(randomblob(16))), 0 FROM sessions;
        `)
          for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
            database.exec(`
            CREATE TRIGGER archive_writer_${operation.toLowerCase()}
            BEFORE ${operation} ON sessions BEGIN
              SELECT CASE WHEN mako_archive_writer() != 1
                THEN RAISE(ABORT, 'Update Mako to write this session archive') END;
            END;
            CREATE TRIGGER archive_revision_${operation.toLowerCase()}
            AFTER ${operation} ON sessions BEGIN
              INSERT INTO archive_captures (path, token, deleted)
              VALUES (${operation === "DELETE" ? "OLD" : "NEW"}.path, lower(hex(randomblob(16))), ${operation === "DELETE" ? 1 : 0})
              ON CONFLICT(path) DO UPDATE SET token=excluded.token, deleted=excluded.deleted;
            END;
          `)
          }
          database.exec("PRAGMA user_version=1")
        }
        // Capture admission needs the revision, never the transcript payload.
        // The primary path index still fetches a potentially huge sessions row.
        database.exec("CREATE INDEX IF NOT EXISTS sessions_capture_revision ON sessions(path, revision)")
        database.exec("COMMIT")
      } catch (error) {
        database.exec("ROLLBACK")
        throw error
      }
      this.database = database
      this.refreshIndex()
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
          if (
            ref.path &&
            !this.index.has(ref.path) &&
            !this.captureState(ref.path)?.deleted
          )
            this.index.set(ref.path, { ...ref, locked: false, archived: true })
        } catch {
          // Incomplete legacy directories have no committed history to expose.
        }
      }
    } catch (error) {
      if (this.database === database) this.database = null
      database.close()
      throw error
    }
  }

  orphans(livePaths: ReadonlySet<string>): ThreadRef[] {
    this.refreshIndex()
    return [...this.index.values()].filter((ref) => !livePaths.has(ref.path))
  }

  has(path: string): boolean {
    this.refreshIndex()
    return this.index.has(path)
  }

  note(ref: ThreadRef, read: () => Promise<Thread | null>): void {
    if (this.stopping || this.deleted.has(ref.path)) return
    const state = this.captureState(ref.path)
    if (state?.deleted || state?.revision === revisionOf(ref)) {
      this.cancel(ref.path)
      return
    }
    const heldCapture = this.latest.get(ref.path)
    if (heldCapture && revisionOf(heldCapture.ref) === revisionOf(ref)) return
    const capture = { ref, read }
    this.latest.set(ref.path, capture)
    this.pending.set(ref.path, capture)
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
    if (this.captureState(path)?.deleted) return null
    this.refreshIndex()
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
    this.cancel(path)
    await this.load()
    const database = this.database
    if (!database) throw new Error("Session archive is closed")
    database.exec("BEGIN IMMEDIATE")
    try {
      database.prepare("DELETE FROM sessions WHERE path = ?").run(path)
      database
        .prepare(
          `
        INSERT INTO archive_captures (path, token, deleted) VALUES (?, lower(hex(randomblob(16))), 1)
        ON CONFLICT(path) DO UPDATE SET token=excluded.token, deleted=1 WHERE archive_captures.deleted=0
      `
        )
        .run(path)
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
    this.index.delete(path)
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
      .then(() => this.write(capture))
      .finally(() => {
        if (this.latest.get(capture.ref.path) === capture)
          this.latest.delete(capture.ref.path)
      })
    void this.queue.catch((error: Error) =>
      console.error("Session archive capture failed", error.message)
    )
  }

  private async write(capture: Capture): Promise<void> {
    await this.load()
    const { ref, read } = capture
    // Conflicts reread the source rather than reusing a previously translated snapshot.
    // Bound contention: the caller sees failure and a later observation may retry.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.latest.get(ref.path) !== capture) return
      const before = this.captureState(ref.path)
      if (before?.deleted || before?.revision === revisionOf(ref)) return
      const native = await read()
      if (
        !native ||
        native.ref.archived ||
        this.latest.get(ref.path) !== capture
      )
        return
      const parsed = ThreadRefSchema.parse(native.ref)
      if (parsed.path !== ref.path)
        throw new Error("Archive capture returned a different native path")
      if (this.captureState(ref.path)?.token !== before?.token) continue
      const thread = await persistThreadAttachments(
        { ...native, ref: parsed },
        join(this.root, "assets"),
        await this.read(ref.path)
      )
      if (this.latest.get(ref.path) !== capture) return
      const revision = revisionOf(thread.ref)
      const metadata = JSON.stringify(thread.ref)
      z.array(ThreadEntrySchema).parse(thread.entries)
      const entries = JSON.stringify(thread.entries)
      const database = this.database
      if (!database) throw new Error("Session archive is closed")
      database.exec("BEGIN IMMEDIATE")
      try {
        const current = this.captureState(ref.path)
        if (current?.deleted) {
          database.exec("ROLLBACK")
          return
        }
        if (current?.token !== before?.token) {
          database.exec("ROLLBACK")
          continue
        }
        // Skip identical rows, even when discovery offered a noisy revision hint.
        // Equal entry counts, timestamps or byte lengths are not content identity.
        database
          .prepare(
            `
          INSERT INTO sessions (path, ref, entries, revision) VALUES (?, ?, ?, ?)
          ON CONFLICT(path) DO UPDATE SET ref=excluded.ref, entries=excluded.entries, revision=excluded.revision
          WHERE sessions.ref != excluded.ref OR sessions.entries != excluded.entries OR sessions.revision != excluded.revision
        `
          )
          .run(ref.path, metadata, entries, revision)
        database.exec("COMMIT")
      } catch (error) {
        database.exec("ROLLBACK")
        throw error
      }
      this.index.set(ref.path, { ...thread.ref, locked: false, archived: true })
      return
    }
    throw new Error(
      "Session archive changed during three capture attempts; retry on the next observation"
    )
  }

  private cancel(path: string): void {
    const held = this.timers.get(path)
    if (held) clearTimeout(held.timer)
    this.timers.delete(path)
    this.pending.delete(path)
    this.latest.delete(path)
  }

  private captureState(path: string) {
    const row = this.database
      ?.prepare(
        `
      SELECT token, deleted, revision FROM archive_captures
      LEFT JOIN sessions INDEXED BY sessions_capture_revision USING (path) WHERE path = ?
    `
      )
      .get(path)
    return row ? CaptureStateRow.parse(row) : null
  }

  /** PRAGMA data_version changes only for commits from another connection. */
  private refreshIndex(): void {
    const database = this.database
    if (!database) return
    const version = z
      .object({ data_version: z.number() })
      .parse(database.prepare("PRAGMA data_version").get()).data_version
    if (version === this.dataVersion) return
    const next = new Map<string, ThreadRef>()
    for (const value of database.prepare("SELECT ref FROM sessions").all()) {
      const row = ArchiveIndexRow.parse(value)
      const ref = ArchivedThreadRefSchema.parse(JSON.parse(row.ref))
      next.set(ref.path, { ...ref, locked: false, archived: true })
    }
    // Legacy directory captures have not yet acquired a database row.
    for (const [path, ref] of this.index)
      if (!next.has(path) && !this.captureState(path)) next.set(path, ref)
    this.index = next
    this.dataVersion = version
  }

  private legacyDir(path: string): string {
    return join(
      this.root,
      createHash("sha1").update(path).digest("hex").slice(0, 24)
    )
  }
}

function revisionOf(ref: ThreadRef): string {
  // Include all retained metadata, including native settings and lineage. Runtime
  // activity is presentation state, not a new source revision. Sort top-level keys
  // so a parsed ref and a provider's differently ordered object compare equally.
  const {
    active: _active,
    locked: _locked,
    archived: _archived,
    ...source
  } = ref
  if (source.settings) {
    source.settings = {
      model: source.settings.model,
      options: source.settings.options
        ? Object.fromEntries(
            Object.entries(source.settings.options).sort(([a], [b]) =>
              a.localeCompare(b)
            )
          )
        : undefined,
    }
  }
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(source).sort(([a], [b]) => a.localeCompare(b))
    )
  )
}

/** A concurrent journal-mode change can return SQLITE_BUSY before busy_timeout.
 * Recheck the desired state and retry only that safe operation, never a capture.
 */
async function enableWal(database: DatabaseSync): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const mode = z
        .object({ journal_mode: z.string() })
        .parse(database.prepare("PRAGMA journal_mode").get()).journal_mode
      if (mode !== "wal") database.exec("PRAGMA journal_mode=WAL")
      return
    } catch (error) {
      const busy = z
        .object({ code: z.literal("ERR_SQLITE_ERROR"), errcode: z.literal(5) })
        .safeParse(error)
      if (!busy.success || attempt === 2) throw error
      await delay(10 * (attempt + 1))
    }
  }
}

/**
 * Mako's copies of sessions, as earlier builds read them: `~/.mako/archive`.
 *
 * Until the record store kept every session's own records, the archive kept
 * each session Mako noticed as Mako's translation, one row per session,
 * with no stamp of the decoder that made it. It writes no new copies now.
 * The catalog worker's migration (`archive-migration.ts`) drops each row
 * once the session is safe without it, and what stays is a session no
 * harness and no record store holds any more: Mako's copy is all that's
 * left of it (`ThreadRef.copyOnly`), read as it was kept.
 *
 * Why the copies stay here rather than in the view store: views are a cache
 * that a newer build rebuilds and that drops the least read first
 * (`VIEW_CACHE_BYTES`). A copy can't be rebuilt from anything, so it lives
 * where nothing evicts it.
 *
 * The database keeps the schema older builds read and write (`user_version`
 * 1, the writer triggers), so an older Mako sharing the folder still reads
 * it. A dropped row is marked deleted in `archive_captures`, which every
 * older build checks before it captures, so none brings it back.
 */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readdir, readFile, rm, stat, statfs } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { Worker } from "node:worker_threads"
import { z } from "zod"
import { DatabaseSync } from "node:sqlite"
import { StoredEntriesSchema, ThreadRefSchema } from "./thread-schema.js"
import { SessionSettingsSchema } from "./settings.js"
import { ReadOnlyConnection, ReadOnlyStoreError, openReadOnly } from "./read-only-sqlite.js"
import type { Thread, ThreadRef } from "./format.js"
import type { StoreStanding } from "./store-format.js"
import { EntrySchema, type Entry } from "./entries.js"

const ArchiveIndexRow = z.object({ ref: z.string() })
const CaptureStateRow = z.object({ deleted: z.union([z.literal(0), z.literal(1)]) })
const ArchiveContentRow = z.object({ ref: z.string(), entries: z.string() })
const CountRow = z.object({ count: z.number() })
const ArchivedThreadRefSchema = ThreadRefSchema.extend({
  settings: SessionSettingsSchema.extend({
    model: z
      .string()
      .transform((model) => model || undefined)
      .optional(),
  }).optional(),
})

const ARCHIVE_FILE = "archive.sqlite"
/** Free space under which reclaiming isn't worth a rewrite. */
const RECLAIM_MIN_BYTES = 32 * 1024 * 1024
/** What a rewrite leaves free on the disk, beside the two copies of the kept rows it needs while it runs. */
const RECLAIM_KEEPS_FREE = 2 * 1024 ** 3

/** How a dropped row's session is kept now: by its harness and the record store, or by the record store alone. */
export type ArchiveDropVia = "harness" | "records"

/** Where the archive's migration stands, from its own tables. */
export interface ArchiveMigrationCounts {
  /** Rows left: kept copies and those still to look at. */
  rows: number
  /** Rows dropped by the migration, ever. */
  migrated: number
  /** Rows the migration found nothing else holds: Mako's copy is all that's left. */
  copies: number
  /** Rows not yet dropped or found to be copies. */
  pending: number
}

/** What reclaiming the dropped rows' space did. */
export interface ArchiveReclaim {
  ran: boolean
  /** Why it didn't run. */
  why?: string
  bytesBefore: number
  bytesAfter: number
  freeBytes: number
  ms: number
}

export interface SessionArchiveOptions {
  /**
   * Read the copies other hosts keep without writing: nothing is created or
   * migrated, and every change throws `ReadOnlyStoreError`.
   */
  readOnly?: boolean
}

export class SessionArchive {
  private readonly root: string
  /** Set for a reader of another host's copies, and for an archive in a newer Mako's format, which this build reads and never writes. */
  private readOnly: boolean
  private reader: ReadOnlyConnection | null = null
  private database: DatabaseSync | null = null
  private index = new Map<string, ThreadRef>()
  private dataVersion = -1
  private loaded: Promise<void> | null = null

  constructor(root: string, options: SessionArchiveOptions = {}) {
    this.root = root
    this.readOnly = options.readOnly ?? false
  }

  get folder(): string {
    return this.root
  }

  /** Whether this build may change the archive: false for another host's reader, and for a newer Mako's format, which it reads only. */
  get writable(): boolean {
    return !this.readOnly
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
    if (this.readOnly) {
      this.database = this.openReader()
      try {
        this.refreshIndex()
        if (existsSync(this.root)) await this.indexLegacyCopies()
      } catch (error) {
        this.closeDatabase()
        throw error
      }
      return
    }
    // Nothing is created for a person who never had copies: the archive only shrinks now.
    if (!existsSync(join(this.root, ARCHIVE_FILE)) && !(await legacyDirectories(this.root)).length) return
    const database = new DatabaseSync(join(this.root, ARCHIVE_FILE))
    try {
      // Persisted triggers reject writes from builds that predate them while leaving their reads intact.
      database.function("mako_archive_writer", () => 1)
      database.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL")
      await enableWal(database)
      database.exec("BEGIN IMMEDIATE")
      try {
        const version = pragma(database, "user_version")
        if (version > 1) {
          // A newer Mako's format: read what this build knows of it and write nothing, so nothing it added is lost.
          database.exec("ROLLBACK")
          database.close()
          this.readOnly = true
          this.database = this.openReader()
          this.refreshIndex()
          return
        }
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
        // Older builds read these two to decide what to capture; they stay for them.
        database.exec("CREATE INDEX IF NOT EXISTS sessions_capture_revision ON sessions(path, revision)")
        database.exec(`CREATE TABLE IF NOT EXISTS archive_observations (
          path TEXT PRIMARY KEY,
          observed_revision TEXT NOT NULL,
          capture_token TEXT NOT NULL
        )`)
        // The migration's own ledger: each row it dropped and why, and each it found to be all that's left.
        database.exec(`CREATE TABLE IF NOT EXISTS archive_migration (
          path TEXT PRIMARY KEY,
          state TEXT NOT NULL CHECK (state IN ('migrated', 'copy')),
          via TEXT,
          at INTEGER NOT NULL
        ) WITHOUT ROWID`)
        database.exec("COMMIT")
      } catch (error) {
        database.exec("ROLLBACK")
        throw error
      }
      this.database = database
      this.refreshIndex()
      await this.indexLegacyCopies()
    } catch (error) {
      if (this.database === database) this.database = null
      database.close()
      throw error
    }
  }

  /** The database another host keeps, or null while none this build can read exists. */
  private openReader(): DatabaseSync | null {
    const path = join(this.root, ARCHIVE_FILE)
    if (!existsSync(path)) return null
    const reader = new ReadOnlyConnection(path, { timeout: 5000 })
    try {
      if (!readableArchive(reader.database)) {
        reader.close()
        console.warn("Session archive skipped: no host of this build has opened it yet")
        return null
      }
    } catch (error) {
      reader.close()
      throw error
    }
    this.reader = reader
    return reader.database
  }

  /** Copies the oldest builds kept as folders (`ref.json`, `entries.jsonl`), read until the migration folds them into the database. */
  private async indexLegacyCopies(): Promise<void> {
    for (const name of await legacyDirectories(this.root)) {
      const ref = await legacyRef(join(this.root, name))
      if (ref && !this.index.has(ref.path) && !this.captureState(ref.path)?.deleted)
        this.index.set(ref.path, keptRef(ref))
    }
  }

  private closeDatabase(): void {
    if (this.reader) this.reader.close()
    else this.database?.close()
    this.reader = null
    this.database = null
  }

  /** Saved sessions their stores forgot. A child agent's copy is never one: it is listed under its parent (`childrenOf`). */
  orphans(livePaths: ReadonlySet<string>): ThreadRef[] {
    this.refreshIndex()
    return [...this.index.values()].filter((ref) => !livePaths.has(ref.path) && !ref.childOf)
  }

  /** The saved copies of the child agents of the session at `parentPath`. */
  childrenOf(parentPath: string): ThreadRef[] {
    this.refreshIndex()
    return [...this.index.values()].filter((ref) => ref.childOf?.path === parentPath)
  }

  has(path: string): boolean {
    this.refreshIndex()
    return this.index.has(path)
  }

  /** The saved copy of a native path, as `orphans` lists it. */
  kept(path: string): ThreadRef | undefined {
    this.refreshIndex()
    return this.index.get(path)
  }

  /** Every copy, newest first: what the migration looks at. */
  copies(): ThreadRef[] {
    this.refreshIndex()
    return [...this.index.values()].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
  }

  async read(path: string): Promise<Thread | null> {
    await this.load()
    const value = this.database
      ?.prepare("SELECT ref, entries FROM sessions WHERE path = ?")
      .get(path)
    if (value) {
      const row = ArchiveContentRow.parse(value)
      const ref = ArchivedThreadRefSchema.parse(JSON.parse(row.ref))
      return { ref: keptRef(ref), entries: storedEntries(JSON.parse(row.entries)) }
    }
    if (this.captureState(path)?.deleted) return null
    this.refreshIndex()
    const ref = this.index.get(path)
    if (!ref) return null
    return readLegacyEntries(this.legacyDir(path)).then((entries) => entries && { ref, entries })
  }

  /** How many entries the copy at `path` holds, counted by SQLite without parsing them here; 0 for none. */
  entryCount(path: string): number {
    const row = this.database?.prepare("SELECT coalesce(json_array_length(entries), 0) AS count FROM sessions WHERE path = ?").get(path)
    return row ? CountRow.parse(row).count : 0
  }

  /** The person deleted the session: its copy goes and is never captured again, by this build or an older one. */
  async forget(path: string): Promise<void> {
    await this.remove(path, null)
  }

  /**
   * Drops the copy at `path` once the session is held elsewhere (`via`), in
   * one transaction with the migration's note of it. Older builds see the
   * row deleted and never capture it again.
   */
  async drop(path: string, via: ArchiveDropVia): Promise<void> {
    await this.remove(path, via)
  }

  private async remove(path: string, via: ArchiveDropVia | null): Promise<void> {
    if (this.readOnly) throw new ReadOnlyStoreError("The session archive")
    await this.load()
    const database = this.database
    if (!database) return
    database.exec("BEGIN IMMEDIATE")
    try {
      database.prepare("DELETE FROM sessions WHERE path = ?").run(path)
      database.prepare("DELETE FROM archive_observations WHERE path = ?").run(path)
      database
        .prepare(
          `
        INSERT INTO archive_captures (path, token, deleted) VALUES (?, lower(hex(randomblob(16))), 1)
        ON CONFLICT(path) DO UPDATE SET token=excluded.token, deleted=1 WHERE archive_captures.deleted=0
      `
        )
        .run(path)
      if (via) database.prepare("INSERT OR REPLACE INTO archive_migration (path, state, via, at) VALUES (?, 'migrated', ?, ?)").run(path, via, Date.now())
      else database.prepare("DELETE FROM archive_migration WHERE path = ?").run(path)
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
    this.index.delete(path)
    await rm(this.legacyDir(path), { recursive: true, force: true })
  }

  /** Notes that nothing but this copy holds the session at `path`; true when it wasn't noted yet. */
  markCopy(path: string): boolean {
    if (this.readOnly) throw new ReadOnlyStoreError("The session archive")
    const database = this.database
    if (!database) return false
    return Number(database.prepare("INSERT INTO archive_migration (path, state, at) SELECT path, 'copy', ? FROM sessions WHERE path = ? ON CONFLICT(path) DO NOTHING").run(Date.now(), path).changes) > 0
  }

  /** Takes back a `markCopy`: the session is held elsewhere again. */
  unmarkCopy(path: string): void {
    if (this.readOnly || !this.database) return
    this.database.prepare("DELETE FROM archive_migration WHERE path = ? AND state = 'copy'").run(path)
  }

  /** Where the migration stands; zeros for an archive with no database. */
  counts(): ArchiveMigrationCounts {
    return this.database ? migrationCounts(this.database) : { rows: 0, migrated: 0, copies: 0, pending: 0 }
  }

  /**
   * Moves the copies the oldest builds kept as folders into the database,
   * so every copy is one row the migration can drop or keep. A folder whose
   * session already has a row, or was deleted, is removed. The row commits
   * before the folder goes, so a crash between leaves a folder the next
   * pass removes.
   */
  async foldLegacy(): Promise<{ folded: number; removed: number }> {
    const database = this.database
    if (this.readOnly || !database) return { folded: 0, removed: 0 }
    let folded = 0
    let removed = 0
    for (const name of await legacyDirectories(this.root)) {
      const folder = join(this.root, name)
      const ref = await legacyRef(folder)
      if (!ref) continue
      const held = Boolean(database.prepare("SELECT 1 FROM sessions WHERE path = ?").get(ref.path)) || this.captureState(ref.path)?.deleted
      if (!held) {
        const entries = await readLegacyEntries(folder)
        // An unreadable folder was never readable here either; it stays for a person to look at.
        if (!entries) continue
        database.prepare("INSERT INTO sessions (path, ref, entries, revision) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO NOTHING")
          .run(ref.path, JSON.stringify(ref), JSON.stringify(entries), JSON.stringify(ref))
        folded += 1
      } else removed += 1
      await rm(folder, { recursive: true, force: true })
    }
    if (folded || removed) {
      this.dataVersion = -1
      this.index.clear()
      this.refreshIndex()
    }
    return { folded, removed }
  }

  /**
   * Gives the space of dropped rows back to the disk. SQLite's `VACUUM`
   * rewrites the file in a thread of its own, so this thread (the catalog
   * worker, which answers the rail) is never held by it, and it's one
   * transaction: a crash leaves the database as it was before or after.
   * The rewrite passes through the write-ahead log, so it waits until the
   * disk has room for the rows kept twice over and `RECLAIM_KEEPS_FREE`.
   *
   * Incremental vacuuming was tried on a clone of a real archive and
   * dropped: each 8 MiB step held this thread up to 566 ms, and keeping its
   * page map made each drop 225 ms instead of 10.
   */
  async reclaim(options: { minBytes?: number } = {}): Promise<ArchiveReclaim> {
    const database = this.database
    if (this.readOnly || !database) return { ran: false, bytesBefore: 0, bytesAfter: 0, freeBytes: 0, ms: 0 }
    const file = join(this.root, ARCHIVE_FILE)
    const pageSize = pragma(database, "page_size")
    const freeBytes = pragma(database, "freelist_count") * pageSize
    const keptBytes = pragma(database, "page_count") * pageSize - freeBytes
    const bytesBefore = await fileBytes(file)
    const skipped = (why: string): ArchiveReclaim => ({ ran: false, why, bytesBefore, bytesAfter: bytesBefore, freeBytes, ms: 0 })
    if (freeBytes < (options.minBytes ?? RECLAIM_MIN_BYTES) || freeBytes === 0) return skipped("too little is free to be worth a rewrite")
    const disk = await statfs(this.root)
    if (disk.bavail * disk.bsize < keptBytes * 2 + RECLAIM_KEEPS_FREE) return skipped("the disk lacks room for the rewrite")
    const started = performance.now()
    await vacuumAside(file)
    return { ran: true, bytesBefore, bytesAfter: await fileBytes(file), freeBytes, ms: performance.now() - started }
  }

  stop(): Promise<void> {
    this.closeDatabase()
    return Promise.resolve()
  }

  private captureState(path: string) {
    const row = this.database?.prepare("SELECT deleted FROM archive_captures WHERE path = ?").get(path)
    return row ? CaptureStateRow.parse(row) : null
  }

  /** PRAGMA data_version changes only for commits from another connection. */
  private refreshIndex(): void {
    if (this.reader?.refresh()) {
      this.database = this.reader.database
      this.dataVersion = -1
    }
    const database = this.database
    if (!database) return
    const version = pragma(database, "data_version")
    if (version === this.dataVersion) return
    const next = new Map<string, ThreadRef>()
    for (const value of database.prepare("SELECT ref FROM sessions").all()) {
      const row = ArchiveIndexRow.parse(value)
      const ref = ArchivedThreadRefSchema.parse(JSON.parse(row.ref))
      next.set(ref.path, keptRef(ref))
    }
    // Legacy folders that have no database row yet.
    for (const [path, ref] of this.index)
      if (!next.has(path) && !this.captureState(path)) next.set(path, ref)
    this.index = next
    this.dataVersion = version
  }

  private legacyDir(path: string): string {
    return join(this.root, legacyName(path))
  }
}

/** A kept copy as the catalog serves it: not the harness's, and Mako's copy only. */
function keptRef(ref: ThreadRef): ThreadRef {
  return { ...ref, locked: false, archived: true, copyOnly: true }
}

function legacyName(path: string): string {
  return createHash("sha1").update(path).digest("hex").slice(0, 24)
}

/** The folders the oldest builds kept a copy in, by the hash of its path. */
async function legacyDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isDirectory() && /^[0-9a-f]{24}$/.test(entry.name)).map((entry) => entry.name)
}

async function legacyRef(folder: string): Promise<ThreadRef | null> {
  try {
    const ref = ArchivedThreadRefSchema.parse(JSON.parse(await readFile(join(folder, "ref.json"), "utf8")))
    // A folder belongs to the path it hashes; any other was never this archive's.
    return ref.path && legacyName(ref.path) === folder.slice(-24) ? ref : null
  } catch {
    return null
  }
}

async function readLegacyEntries(folder: string): Promise<Thread["entries"] | null> {
  try {
    const raw = await readFile(join(folder, "entries.jsonl"), "utf8")
    return StoredEntriesSchema.parse(raw.split("\n").filter(Boolean).map((line) => JSON.parse(line)))
  } catch {
    return null
  }
}

async function fileBytes(file: string): Promise<number> {
  const sizes = await Promise.all(["", "-wal"].map((suffix) => stat(`${file}${suffix}`).then((info) => info.size, () => 0)))
  return sizes[0]! + sizes[1]!
}

/** A numeric `PRAGMA`'s value. */
function pragma(database: DatabaseSync, name: string): number {
  const value = z.record(z.string(), z.number()).parse(database.prepare(`PRAGMA ${name}`).get())[name]
  if (value === undefined) throw new Error(`PRAGMA ${name} gave no value`)
  return value
}

function migrationCounts(database: DatabaseSync): ArchiveMigrationCounts {
  const ledger = Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'archive_migration'").get())
  const rows = CountRow.parse(database.prepare("SELECT count(*) AS count FROM sessions").get()).count
  if (!ledger) return { rows, migrated: 0, copies: 0, pending: rows }
  const migrated = CountRow.parse(database.prepare("SELECT count(*) AS count FROM archive_migration WHERE state = 'migrated'").get()).count
  const copies = CountRow.parse(database.prepare("SELECT count(*) AS count FROM archive_migration m JOIN sessions s ON s.path = m.path WHERE m.state = 'copy'").get()).count
  return { rows, migrated, copies, pending: rows - copies }
}

/** Where the migration of the archive at `root` stands, read without writing; null without a database. */
export function archiveMigrationStatus(root: string): (ArchiveMigrationCounts & { bytes: number; freeBytes: number }) | null {
  const file = join(root, ARCHIVE_FILE)
  if (!existsSync(file)) return null
  const { database } = openReadOnly(file, { timeout: 5_000 })
  try {
    const pageSize = pragma(database, "page_size")
    const pages = pragma(database, "page_count")
    const free = pragma(database, "freelist_count")
    return { ...migrationCounts(database), bytes: pages * pageSize, freeBytes: free * pageSize }
  } finally {
    database.close()
  }
}

/**
 * `VACUUM` of the archive at `file` in a thread of its own, so the caller's
 * thread (the catalog worker, which answers the rail) is never held by it.
 */
function vacuumAside(file: string): Promise<void> {
  const code = `
    const { workerData, parentPort } = require("node:worker_threads")
    const { DatabaseSync } = require("node:sqlite")
    const database = new DatabaseSync(workerData.file)
    try {
      database.exec("PRAGMA busy_timeout=30000")
      database.exec("VACUUM")
      // The rewrite went through the write-ahead log: copied back and the log emptied here, not on the caller's thread.
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      parentPort.postMessage({ ok: true })
    } catch (error) {
      parentPort.postMessage({ ok: false, message: String(error && error.message || error) })
    } finally {
      database.close()
    }
  `
  return new Promise((resolve, reject) => {
    const worker = new Worker(code, { eval: true, workerData: { file } })
    let answered = false
    worker.once("message", (message: { ok: boolean; message?: string }) => {
      answered = true
      if (message.ok) resolve()
      else reject(new Error(`The archive could not be vacuumed: ${message.message}`))
    })
    worker.once("error", reject)
    worker.once("exit", (code) => {
      if (!answered) reject(new Error(`The archive's vacuum stopped with code ${code}`))
    })
  })
}

/**
 * Where the archive under `root` stands for this build, read without
 * writing: for Settings › Diagnostics. Its format is `user_version`, and a
 * newer one is read while it keeps what this build reads.
 */
export function archiveStanding(root: string): StoreStanding {
  const file = join(root, ARCHIVE_FILE)
  if (!existsSync(file)) return { access: "write", build: 1 }
  const { database } = openReadOnly(file, { timeout: 1_000 })
  try {
    const version = pragma(database, "user_version")
    if (version <= 1) return { access: "write", build: 1, format: { writableBy: version, readableBy: version } }
    const readable = readableArchive(database)
    return { access: readable ? "read" : "refused", build: 1, format: { writableBy: version, readableBy: readable ? 1 : version } }
  } finally {
    database.close()
  }
}

/**
 * Whether a read-only connection finds the schema this build's queries
 * need; a writer of this build creates it. A newer Mako's format is read
 * when it keeps the tables and columns this build reads, as every later
 * format must for the builds that share the folder; what else it holds is
 * left as it is.
 */
function readableArchive(database: DatabaseSync): boolean {
  const version = pragma(database, "user_version")
  if (version > 1) {
    const columns = new Set(z.object({ name: z.string() }).array().parse(database.prepare("PRAGMA table_info(sessions)").all()).map((column) => column.name))
    const captures = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'archive_captures'").get()
    const readable = ["path", "ref", "entries"].every((column) => columns.has(column)) && Boolean(captures)
    if (!readable) console.warn(`Session archive skipped: its format ${version} no longer keeps what this build reads`)
    return readable
  }
  const found = database
    .prepare("SELECT count(*) AS count FROM sqlite_master WHERE name IN ('archive_captures', 'archive_observations', 'sessions_capture_revision')")
    .get()
  return version === 1 && CountRow.parse(found).count === 3
}

/** A concurrent journal-mode change can return SQLITE_BUSY before busy_timeout.
 * Recheck the desired state and retry only that safe operation.
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

/**
 * A copy's entries as this build reads them. One a newer Mako wrote in a
 * shape this build doesn't know is shown raw, as an unread entry where it
 * stood, never dropped and never a reason the copy doesn't open.
 */
function storedEntries(stored: z.infer<ReturnType<typeof z.json>>): Entry[] {
  const known = StoredEntriesSchema.safeParse(stored)
  if (known.success) return known.data
  const items = z.array(z.json()).safeParse(stored)
  if (!items.success) return [{ type: "unread", kind: "copy", reason: "unreadable", raw: stored }]
  return items.data.map((item, index): Entry => {
    const entry = EntrySchema.safeParse(item)
    return entry.success ? entry.data : { type: "unread", kind: "entry of a newer Mako", reason: "unreadable", raw: item, id: `copy#${index}` }
  })
}

import { createHash } from "node:crypto"
import { createReadStream, existsSync, mkdirSync } from "node:fs"
import { mkdir, open, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { DatabaseSync, StatementSync } from "node:sqlite"
import { z } from "zod"
import { Chunker, chunkHash, HASH_BYTES, Packs } from "./record-chunks.js"
import { plainRecordPath, recordChunks, statRecord } from "./record-files.js"
import type { RecordDatabase, RecordLines, RecordRoot, RecordRow, RecordTable, RecordValue, SessionRecords } from "./harness-records.js"
import { checkRoots, placeIn, qualify, RootPlaces, rootFolders } from "./record-roots.js"
import {
  decodeRow, encodeRow, KEY_DIGESTS, type KeyDigests, KeyDigestsSchema, keyColumns, keyLiteralSql, lookupSql, lookupStatement, positionColumns, type RowKey, quoted, registerKeyDigests, rowKeyOf, rowUnitKey,
  SqlValueSchema, tagged,
} from "./record-rows.js"
import { openReadOnly, type NativeStores } from "./read-only-sqlite.js"

export { decodeRow, encodeRow, taggedRow } from "./record-rows.js"

/**
 * Mako's copy of every session's records, as the harness wrote them.
 *
 * A **unit** is the smallest thing a harness writes on its own: one file,
 * one row, a database's schema, or a session's lines in a shared index. Its
 * key is logical: named by the root it lies under (`record-roots.ts`),
 * without the encoding, and for Codex without the date folder or
 * `archived_sessions`, so a rollout Codex compressed or archived, or the same
 * session on another machine, is the same unit. A unit's history is a list of
 * **versions**, each appending to the one before, replacing it, or deleting
 * it. A version's bytes are content-defined chunks (`record-chunks.ts`), each
 * stored once by hash.
 *
 * Capture reads only what changed: a file whose placement (path, inode,
 * size, mtime) is unchanged isn't opened; an append-only file is read from
 * where the last version ended, once the bytes before that point check out;
 * a database unchanged since the last capture isn't opened, and rows are
 * compared by content hash. A harness's database is read in short
 * transactions, so a large first capture never holds back the harness's
 * checkpoint, and the store commits as it goes, so a capture cut short keeps
 * what it took and other work runs between its slices.
 *
 * Restore writes a session as its newest versions have it: whole where
 * nothing is there, appending where the destination holds an earlier
 * version, and nothing at all when the destination went on without Mako.
 */

const SCHEMA_VERSION = 2
/** How long a restore waits for a running harness to release its database's write lock. */
const WRITE_BUSY_TIMEOUT_MS = 30_000
/** How far back from an append cursor a capture checks that nothing before it was rewritten. */
const TAIL_BYTES = 64 * 1024
/** A capture that found nothing new is logged only when it took this long. */
const SLOW_CAPTURE_MS = 50
/** A long capture lets waiting work go first at its next slice; with none waiting, it commits what it took about this often. */
const SLICE_MS = 2_000
/** A read of a harness's database ends once it has held a snapshot this long, or read this many bytes of rows; those are stored with the read ended. */
const READ_MS = 100
const READ_BYTES = 8 * 1024 * 1024
/** Rows a capture asks for in one statement, by position. */
const FETCH_ROWS = 128

const UnitRoleSchema = z.enum(["file", "row", "schema", "lines"])
const VersionKindSchema = z.enum(["append", "replace", "delete"])
export type UnitRole = z.infer<typeof UnitRoleSchema>
export type VersionKind = z.infer<typeof VersionKindSchema>

export interface CaptureInput {
  harness: string
  nativeId: string
  /** The machine's home: a restore elsewhere puts each root that was under it at the same place under the destination's home. */
  home: string
  records: SessionRecords
}

export interface CaptureReport {
  versions: { unit: string; kind: VersionKind; bytes: number }[]
  /** Units whose placement or content hash showed nothing new. */
  unchanged: number
  newChunks: number
  /** Bytes of the new chunks, before and after compression. */
  newBytes: number
  storedBytes: number
  /** The capture's own time, from when it got the store until it was done. */
  ms: number
  /** Time it handed the store to work that was waiting, between its slices. */
  waitedMs: number
  /** Read transactions on harness databases: more than one for a database read in pieces so its harness could checkpoint meanwhile. */
  reads: number
  /** Rows read whole; a row never rewritten under its key, already held, isn't. */
  rowsRead: number
  /** Rows of such tables known held by one digest of the session's keys, without listing them. */
  rowsMatched: number
  /** The longest any one of them was open, during which its harness couldn't checkpoint past it. */
  longestReadMs: number
}

export interface RestoreInput {
  harness: string
  nativeId: string
  /** The destination's home. */
  home: string
  /** Where the destination keeps each root, by name. A root it doesn't name goes where it was under the source's home; one the source kept outside its home can't go anywhere unnamed. */
  roots?: RecordRoot[]
  /** The destination's own records for the session, when it has them: a file or row Mako never saw there means the session went on without it. Its roots count when `roots` isn't given. */
  destination?: SessionRecords
  /** True while something on the machine holds the session open; a restore then writes nothing. */
  held?: () => boolean | Promise<boolean>
  dryRun?: boolean
}

export type RestoreActionKind = "skip" | "write" | "append" | "write-plain" | "delete"

/** What a restore does to a file, or to a session's lines in a shared file. */
export interface RestoreAction {
  unit: string
  action: RestoreActionKind
  /** As the store names it (`codex:sessions/…`). */
  path: string
  bytes: number
}

/** What a restore does to one table's rows of the session, counted: a session can own millions. */
export interface RestoreRows {
  /** The database, as the store names it (`cursor-sdk:index.db`). */
  path: string
  table: string
  insert: number
  replace: number
  delete: number
  /** Rows the destination already holds as Mako's newest version has them. */
  skip: number
  /** The bytes of the rows written. */
  bytes: number
}

export interface RestoreReport {
  actions: RestoreAction[]
  rows: RestoreRows[]
  /** Units the destination holds a version of that Mako never captured, or that have nowhere to go. Nothing is written when there are any. */
  diverged: { unit: string; reason: string }[]
  /** Values in rows that named a path in one of the session's roots, moved to where the root is in the destination. */
  movedPaths: number
  written: boolean
}

// Mako's index, as its rows read back.

const Blob = z.instanceof(Uint8Array)

const SessionSummarySchema = z.object({ harness: z.string(), nativeId: z.string(), units: z.number(), bytes: z.number() })
export type SessionSummary = z.infer<typeof SessionSummarySchema>

const UnitSummarySchema = z.object({
  id: z.number(), key: z.string(), role: UnitRoleSchema, path: z.string().nullable(), versions: z.number(), size: z.number(), kind: VersionKindSchema,
})
export type UnitSummary = z.infer<typeof UnitSummarySchema>

const CaptureSummarySchema = z.object({
  harness: z.string(), nativeId: z.string(), at: z.number(), versions: z.number(), newBytes: z.number(), storedBytes: z.number(), ms: z.number(),
  waitedMs: z.number(), reads: z.number(), longestReadMs: z.number(), rowsRead: z.number(), rowsMatched: z.number(),
})
export type CaptureSummary = z.infer<typeof CaptureSummarySchema>

const SchemaSnapshotSchema = z.object({ statements: z.array(z.string()), userVersion: z.number() })
/** A database's schema as one unit holds it. */
export type SchemaSnapshot = z.infer<typeof SchemaSnapshotSchema>

/** Where a session's records were when it was last captured: the machine's home, each root's folder, and the columns of each database that name a path in a root. */
const SessionLayoutSchema = z.object({
  home: z.string(),
  roots: z.record(z.string(), z.string()),
  paths: z.record(z.string(), z.record(z.string(), z.array(z.string()))),
})
type SessionLayout = z.infer<typeof SessionLayoutSchema>
const SessionRowSchema = z.object({ id: z.number(), layout: z.string().nullable() })

const UnitRowSchema = z.object({
  id: z.number(), key: z.string(), role: UnitRoleSchema, head: z.number(),
  seen_path: z.string().nullable(), seen_identity: z.string().nullable(), seen_mtime: z.number().nullable(), seen_bytes: z.number().nullable(),
  /** JSON: every plain path the harness may file it at (`RecordPlace.places`). */
  places: z.string().nullable(),
})
type UnitRow = z.infer<typeof UnitRowSchema>

/** A unit's newest version, as far as capture and restore compare it. */
const UnitHeadSchema = z.object({ id: z.number(), key: z.string(), role: UnitRoleSchema, head: z.number(), kind: VersionKindSchema, size: z.number(), digest: Blob.nullable() })
const HeadRowSchema = z.object({ kind: VersionKindSchema, size: z.number(), digest: Blob.nullable(), tail: Blob.nullable() })
const VersionRowSchema = z.object({
  seq: z.number(), kind: VersionKindSchema, at: z.number(), size: z.number(), chunkBytes: z.number(), captured_at: z.number(), digest: Blob.nullable(),
})
const ContentVersionSchema = z.object({ seq: z.number(), kind: VersionKindSchema, chunks: Blob })
const SizedVersionSchema = z.object({ kind: VersionKindSchema, size: z.number() })
const ChunkPlaceSchema = z.object({ pack: z.number(), offset: z.number(), stored: z.number(), size: z.number(), codec: z.union([z.literal(0), z.literal(1)]) })
const ChunkEntrySchema = ChunkPlaceSchema.extend({ hash: Blob })
const CountSchema = z.object({ n: z.number() })
const IdSchema = z.object({ id: z.number() })
const NewestSeqSchema = z.object({ seq: z.number().nullable() })
const MetaValueSchema = z.object({ value: z.string() })
const FingerprintSchema = z.object({ fingerprint: z.string() })
/** A table's mark: the session's highest rowid and the digest of its keys, when the capture that set it took every row it listed. */
const KeysMarkSchema = z.object({ through: z.string().regex(/^-?\d+$/).transform((value) => BigInt(value)), keys: z.string() })
type KeysMark = z.infer<typeof KeysMarkSchema>
const KeyDigestRowSchema = z.object({ digests: z.string().nullable(), through: z.bigint().nullable() })
const PlacesSchema = z.array(z.string())
const LinesKeySchema = z.record(z.string(), z.string())
const SchemaStatementSchema = z.object({ sql: z.string() })
const UserVersionSchema = z.object({ user_version: z.union([z.number(), z.bigint()]) })
const TableNameSchema = z.object({ name: z.string() })
const KeySchema = z.object({ key: z.string() })
const SeqSchema = z.object({ seq: z.number() })

export interface StoreStats {
  sessions: number
  units: number
  versions: number
  chunks: number
  /** Distinct chunk bytes, before and after compression. */
  bytes: number
  stored: number
}

export interface VersionSummary {
  seq: number
  kind: VersionKind
  at: number
  size: number
  chunks: number
  capturedAt: string
  digest: string | null
}

interface Head {
  unit: number
  seq: number
  kind: VersionKind
  size: number
  digest: Buffer | null
  tail: Buffer | null
}

/** A unit as capture and restore keep it in memory: enough to compare and to add a version, a few dozen bytes each. */
interface KnownUnit {
  id: number
  head: number
  kind: VersionKind
  digest: Buffer | null
  /** This capture listed it. */
  seen: boolean
}

/** One operation at a time, in the order they asked. */
class Turns {
  private busy = false
  private readonly queue: (() => void)[] = []

  take(): Promise<void> {
    if (!this.busy) {
      this.busy = true
      return Promise.resolve()
    }
    return new Promise((resolve) => this.queue.push(resolve))
  }

  give(): void {
    const next = this.queue.shift()
    if (next) next()
    else this.busy = false
  }

  get waiting(): boolean {
    return this.queue.length > 0
  }
}

/**
 * A harness's database, read in short transactions, each on a connection
 * of its own: a long read would keep the harness from checkpointing its
 * write-ahead log, and a writer that appeared since the last read is then
 * read as live rather than as an unchanging file.
 */
class SourceRead {
  private open: { db: DatabaseSync; statements: Map<string, StatementSync>; since: number } | null = null
  /** Reads begun so far. */
  reads = 0
  longestMs = 0

  constructor(private readonly path: string) {}

  get db(): DatabaseSync {
    return this.connection().db
  }

  /** A statement on the current read, prepared once per read; rows come back with SQLite's integers as integers, as arrays when asked. */
  statement(sql: string, arrays = false): StatementSync {
    const { db, statements } = this.connection()
    const cached = `${arrays ? "arrays" : "objects"}\t${sql}`
    let statement = statements.get(cached)
    if (!statement) {
      statement = db.prepare(sql)
      statement.setReadBigInts(true)
      statement.setReturnArrays(arrays)
      statements.set(cached, statement)
    }
    return statement
  }

  /** The current read has held its snapshot long enough. */
  get due(): boolean {
    return this.open !== null && Date.now() - this.open.since >= READ_MS
  }

  /** Ends the current read, if one is open; the next statement begins another. */
  end(): void {
    if (!this.open) return
    const { db, since } = this.open
    this.open = null
    this.longestMs = Math.max(this.longestMs, Date.now() - since)
    try {
      if (db.isTransaction) db.exec("COMMIT")
    } finally {
      db.close()
    }
  }

  private connection(): { db: DatabaseSync; statements: Map<string, StatementSync>; since: number } {
    if (this.open) return this.open
    const { database } = openReadOnly(this.path, { timeout: 5_000 })
    registerKeyDigests(database)
    database.exec("BEGIN")
    this.reads += 1
    return (this.open = { db: database, statements: new Map(), since: Date.now() })
  }
}

/** A row read from the harness, encoded and ready to store once the read has ended. */
interface ReadRow {
  key: string
  bytes: Buffer
  digest: Buffer
}

export class RecordStore {
  readonly folder: string
  private readonly db: DatabaseSync
  private readonly packs: Packs
  private readonly statements = new Map<string, StatementSync>()
  private readonly turns = new Turns()
  /** Each session's capture in progress, so its next capture or a restore of it waits for it. */
  private readonly capturing = new Map<string, Promise<unknown>>()
  /** When the store's current write transaction began. */
  private sliceAt = 0
  private closed = false

  constructor(folder: string, private readonly stores: NativeStores) {
    this.folder = folder
    mkdirSync(folder, { recursive: true })
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite")
    this.db = new DatabaseSync(join(folder, "records.sqlite"), { timeout: 60_000 })
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL")
    this.migrate()
    this.packs = new Packs(join(folder, "packs"))
  }

  /** Takes what's new in a session's records. A session's captures run one after another; other work runs between the slices of a long one. */
  capture(input: CaptureInput): Promise<CaptureReport> {
    const session = `${input.harness}\n${input.nativeId}`
    const before = this.capturing.get(session)
    const run = (before ? before.catch(() => undefined) : Promise.resolve()).then(() => this.serially(() => this.captureNow(input)))
    this.capturing.set(session, run)
    const settled = () => {
      if (this.capturing.get(session) === run) this.capturing.delete(session)
    }
    run.then(settled, settled)
    return run
  }

  /** Writes a session into a home; waits for a capture of it in progress, so it never restores half of one. */
  async restore(input: RestoreInput): Promise<RestoreReport> {
    await this.capturing.get(`${input.harness}\n${input.nativeId}`)?.catch(() => undefined)
    return this.serially(() => this.restoreNow(input))
  }

  /** Closes once the work in progress ends; work asked for after that fails. */
  async close(): Promise<void> {
    if (this.closed) return
    await this.turns.take()
    try {
      if (this.closed) return
      this.closed = true
      await this.packs.close()
      this.db.close()
    } finally {
      this.turns.give()
    }
  }

  sessions(harness?: string): SessionSummary[] {
    return SessionSummarySchema.array().parse(this.prepared(`
      SELECT s.harness, s.native_id AS nativeId, count(u.id) AS units, coalesce(sum(v.size), 0) AS bytes
      FROM sessions s JOIN session_units su ON su.session = s.id JOIN units u ON u.id = su.unit
      LEFT JOIN versions v ON v.unit = u.id AND v.seq = u.head
      WHERE ?1 IS NULL OR s.harness = ?1 GROUP BY s.id ORDER BY s.harness, s.native_id`)
      .all(harness ?? null))
  }

  /** Captures that took versions or were slow, newest first. */
  captures(options: { harness?: string; nativeId?: string; limit?: number } = {}): CaptureSummary[] {
    return CaptureSummarySchema.array().parse(this.prepared(`
      SELECT s.harness, s.native_id AS nativeId, c.at, c.versions, c.new_bytes AS newBytes, c.stored_bytes AS storedBytes, c.ms, c.waited_ms AS waitedMs, c.reads, c.longest_read_ms AS longestReadMs, c.rows_read AS rowsRead, c.rows_matched AS rowsMatched
      FROM captures c JOIN sessions s ON s.id = c.session
      WHERE (?1 IS NULL OR s.harness = ?1) AND (?2 IS NULL OR s.native_id = ?2)
      ORDER BY c.id DESC LIMIT ?3`)
      .all(options.harness ?? null, options.nativeId ?? null, options.limit ?? 50))
  }

  units(harness: string, nativeId: string): UnitSummary[] {
    return UnitSummarySchema.array().parse(this.prepared(`
      SELECT u.id, u.key, u.role, u.seen_path AS path, u.head + 1 AS versions, v.size, v.kind
      FROM sessions s JOIN session_units su ON su.session = s.id JOIN units u ON u.id = su.unit
      JOIN versions v ON v.unit = u.id AND v.seq = u.head
      WHERE s.harness = ? AND s.native_id = ? ORDER BY u.role, u.key`)
      .all(harness, nativeId))
  }

  versions(harness: string, key: string): VersionSummary[] {
    const unit = this.unitByKey(harness, key)
    if (!unit) return []
    return VersionRowSchema.array().parse(this.prepared("SELECT seq, kind, at, size, length(chunks) AS chunkBytes, captured_at, digest FROM versions WHERE unit = ? ORDER BY seq").all(unit.id)).map((row) => ({
      seq: row.seq, kind: row.kind, at: row.at, size: row.size, chunks: row.chunkBytes / HASH_BYTES,
      capturedAt: new Date(row.captured_at).toISOString(), digest: row.digest ? Buffer.from(row.digest).toString("hex") : null,
    }))
  }

  /** A unit's bytes as of version `seq` (the newest by default): a file's content, a row or schema in its encoding, a session's lines. */
  async *content(harness: string, key: string, seq?: number): AsyncGenerator<Buffer> {
    const unit = this.unitByKey(harness, key)
    if (!unit) throw new Error(`No unit ${key} of ${harness}`)
    yield* this.unitContent(unit.id, seq ?? unit.head)
  }

  /** A row or schema version decoded. */
  async decoded(harness: string, key: string, seq?: number): Promise<RecordRow | SchemaSnapshot> {
    const unit = this.unitByKey(harness, key)
    if (!unit || (unit.role !== "row" && unit.role !== "schema")) throw new Error(`${key} isn't a row or schema of ${harness}`)
    const bytes = await collect(this.unitContent(unit.id, seq ?? unit.head))
    return unit.role === "schema" ? SchemaSnapshotSchema.parse(JSON.parse(bytes.toString("utf8"))) : decodeRow(bytes)
  }

  stats(): StoreStats {
    const count = (sql: string) => CountSchema.parse(this.prepared(sql).get()).n
    return {
      sessions: count("SELECT count(*) AS n FROM sessions"),
      units: count("SELECT count(*) AS n FROM units"),
      versions: count("SELECT count(*) AS n FROM versions"),
      chunks: count("SELECT count(*) AS n FROM chunks"),
      bytes: count("SELECT coalesce(sum(size), 0) AS n FROM chunks"),
      stored: count("SELECT coalesce(sum(stored), 0) AS n FROM chunks"),
    }
  }

  /** Reads every chunk back and checks its hash; the chunks that fail. */
  async verify(): Promise<string[]> {
    return this.serially(async () => {
      const failures: string[] = []
      for (const row of this.prepared("SELECT hash, pack, offset, stored, size, codec FROM chunks").iterate()) {
        const entry = ChunkEntrySchema.parse(row)
        const hash = Buffer.from(entry.hash)
        try {
          const bytes = await this.packs.read(entry)
          if (!chunkHash(bytes).equals(hash)) failures.push(`${hash.toString("hex")}: its bytes hash differently`)
        } catch (error) {
          failures.push(`${hash.toString("hex")}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return failures
    })
  }

  private async serially<T>(work: () => Promise<T>): Promise<T> {
    await this.turns.take()
    try {
      if (this.closed) throw new Error(`The record store at ${this.folder} is closed`)
      return await work()
    } finally {
      this.turns.give()
    }
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID")
    const version = MetaValueSchema.optional().parse(this.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get())?.value
    if (version !== undefined && Number(version) !== SCHEMA_VERSION)
      throw new Error(`The record store at ${this.folder} has schema ${version}; this build reads only ${SCHEMA_VERSION}. Move the folder aside to start a new store.`)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        hash BLOB PRIMARY KEY, pack INTEGER NOT NULL, offset INTEGER NOT NULL,
        stored INTEGER NOT NULL, size INTEGER NOT NULL, codec INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS units (
        id INTEGER PRIMARY KEY, harness TEXT NOT NULL, key TEXT NOT NULL, role TEXT NOT NULL,
        head INTEGER NOT NULL DEFAULT -1,
        seen_path TEXT, seen_identity TEXT, seen_mtime REAL, seen_bytes INTEGER, places TEXT,
        UNIQUE (harness, key)
      );
      CREATE TABLE IF NOT EXISTS versions (
        unit INTEGER NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
        at INTEGER NOT NULL, size INTEGER NOT NULL, digest BLOB, tail BLOB, chunks BLOB NOT NULL,
        captured_at INTEGER NOT NULL, detail TEXT,
        PRIMARY KEY (unit, seq)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY, harness TEXT NOT NULL, native_id TEXT NOT NULL, layout TEXT, UNIQUE (harness, native_id)
      );
      CREATE TABLE IF NOT EXISTS session_units (session INTEGER NOT NULL, unit INTEGER NOT NULL, PRIMARY KEY (session, unit)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS session_units_by_unit ON session_units (unit);
      CREATE TABLE IF NOT EXISTS marks (session INTEGER NOT NULL, name TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY (session, name)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS captures (
        id INTEGER PRIMARY KEY, session INTEGER NOT NULL, at INTEGER NOT NULL,
        versions INTEGER NOT NULL, new_bytes INTEGER NOT NULL, stored_bytes INTEGER NOT NULL, ms INTEGER NOT NULL,
        waited_ms INTEGER NOT NULL, reads INTEGER NOT NULL, longest_read_ms INTEGER NOT NULL, rows_read INTEGER NOT NULL, rows_matched INTEGER NOT NULL
      );
    `)
    if (version === undefined) this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION))
  }

  private prepared(sql: string): StatementSync {
    let statement = this.statements.get(sql)
    if (!statement) this.statements.set(sql, statement = this.db.prepare(sql))
    return statement
  }

  private unitByKey(harness: string, key: string): UnitRow | undefined {
    const row = this.prepared("SELECT * FROM units WHERE harness = ? AND key = ?").get(harness, key)
    return row && UnitRowSchema.parse(row)
  }

  private head(unit: { id: number; head: number }): Head | null {
    if (unit.head < 0) return null
    const found = this.prepared("SELECT kind, size, digest, tail FROM versions WHERE unit = ? AND seq = ?").get(unit.id, unit.head)
    if (!found) return null
    const row = HeadRowSchema.parse(found)
    return {
      unit: unit.id, seq: unit.head, kind: row.kind, size: row.size,
      digest: row.digest ? Buffer.from(row.digest) : null,
      tail: row.tail ? Buffer.from(row.tail) : null,
    }
  }

  private sessionId(harness: string, nativeId: string, create: boolean): number | null {
    if (create) this.prepared("INSERT INTO sessions (harness, native_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(harness, nativeId)
    return IdSchema.optional().parse(this.prepared("SELECT id FROM sessions WHERE harness = ? AND native_id = ?").get(harness, nativeId))?.id ?? null
  }

  private unit(harness: string, key: string, role: UnitRole, session: number): UnitRow {
    this.prepared("INSERT INTO units (harness, key, role) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(harness, key, role)
    // SAFETY: the row was inserted just above, or already existed under the same unique key.
    const unit = this.unitByKey(harness, key)!
    this.prepared("INSERT INTO session_units (session, unit) VALUES (?, ?) ON CONFLICT DO NOTHING").run(session, unit.id)
    return unit
  }

  private mark(session: number, name: string): string | undefined {
    return FingerprintSchema.optional().parse(this.prepared("SELECT fingerprint FROM marks WHERE session = ? AND name = ?").get(session, name))?.fingerprint
  }

  private setMark(session: number, name: string, fingerprint: string): void {
    this.prepared("INSERT INTO marks (session, name, fingerprint) VALUES (?, ?, ?) ON CONFLICT (session, name) DO UPDATE SET fingerprint = excluded.fingerprint")
      .run(session, name, fingerprint)
  }

  private clearMark(session: number, name: string): void {
    this.prepared("DELETE FROM marks WHERE session = ? AND name = ?").run(session, name)
  }

  private keysMark(session: number, name: string): KeysMark | null {
    const mark = this.mark(session, name)
    return mark === undefined ? null : KeysMarkSchema.parse(JSON.parse(mark))
  }

  /** The digests of the session's keys in `table`, and its highest rowid, in the current read. Null when a row's key holds a NULL. */
  private keyDigests(source: SourceRead, table: RecordTable, rowid: string, keys: readonly string[], through: bigint | null): { keys: KeyDigests; through: bigint | null } | null {
    const where = table.where ? ` WHERE ${table.where}` : ""
    const sql = `SELECT ${KEY_DIGESTS}(${keyLiteralSql(keys)}, ${quoted(rowid)} <= ?) AS digests, max(${quoted(rowid)}) AS through FROM ${quoted(table.table)}${where}`
    const row = KeyDigestRowSchema.parse(source.statement(sql).get(through, ...(table.params ?? [])))
    return row.digests === null ? null : { keys: KeyDigestsSchema.parse(JSON.parse(row.digests)), through: row.through }
  }

  // The store's write transaction

  private async begin(): Promise<void> {
    this.db.exec("BEGIN IMMEDIATE")
    this.sliceAt = Date.now()
    await this.packs.begin()
  }

  private async commit(): Promise<void> {
    await this.packs.sync()
    this.db.exec("COMMIT")
  }

  /**
   * Between two slices of a long capture: what it took so far is committed
   * once it has run a while, and anything waiting runs before it goes on. Never
   * called while a harness's database is being read, so a capture that hands
   * over never holds the harness back.
   */
  private async slice(report: CaptureReport): Promise<void> {
    const waiting = this.turns.waiting
    if (!waiting && Date.now() - this.sliceAt < SLICE_MS) return
    await this.commit()
    if (waiting) {
      const handed = Date.now()
      this.turns.give()
      await this.turns.take()
      report.waitedMs += Date.now() - handed
      if (this.closed) throw new Error(`The record store at ${this.folder} closed during a capture`)
    }
    await this.begin()
  }

  // Capture

  private async captureNow({ harness, nativeId, home, records }: CaptureInput): Promise<CaptureReport> {
    checkRoots(records.roots)
    const folders = rootFolders(records.roots)
    const started = Date.now()
    const report: CaptureReport = { versions: [], unchanged: 0, newChunks: 0, newBytes: 0, storedBytes: 0, ms: 0, waitedMs: 0, reads: 0, longestReadMs: 0, rowsRead: 0, rowsMatched: 0 }
    await this.begin()
    try {
      // SAFETY: created just above when it didn't exist.
      const session = this.sessionId(harness, nativeId, true)!
      this.prepared("UPDATE sessions SET layout = ? WHERE id = ?").run(JSON.stringify(layoutOf(home, records)), session)
      const seen = new Set<number>()
      for (const path of records.files) {
        const unit = await this.captureFile(harness, session, records, path, report)
        if (unit !== null) seen.add(unit)
        await this.slice(report)
      }
      await this.captureGoneFiles(session, folders, seen, report)
      for (const lines of records.lines ?? []) await this.captureLines(harness, session, records.roots, lines, report)
      for (const database of records.databases) await this.captureDatabase(harness, session, records.roots, database, report)
      report.ms = Date.now() - started - report.waitedMs
      if (report.versions.length || report.ms >= SLOW_CAPTURE_MS)
        this.prepared("INSERT INTO captures (session, at, versions, new_bytes, stored_bytes, ms, waited_ms, reads, longest_read_ms, rows_read, rows_matched) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(session, started, report.versions.length, report.newBytes, report.storedBytes, report.ms, report.waitedMs, report.reads, report.longestReadMs, report.rowsRead, report.rowsMatched)
      await this.commit()
      return report
    } catch (error) {
      // Slices already committed stay: each is true of the records as they were read.
      if (!this.closed && this.db.isTransaction) this.db.exec("ROLLBACK")
      throw error
    }
  }

  private async captureFile(harness: string, session: number, records: SessionRecords, path: string, report: CaptureReport): Promise<number | null> {
    const seenPath = qualify(records.roots, path)
    const placed = records.place?.(plainRecordPath(seenPath)) ?? null
    const unit = this.unit(harness, placed?.key ?? plainRecordPath(seenPath), "file", session)
    const info = await statRecord(path)
    if (!info) return null
    if (unit.seen_path === seenPath && unit.seen_identity === info.identity && unit.seen_mtime === info.mtimeMs && unit.seen_bytes === info.bytes && unit.head >= 0) {
      report.unchanged += 1
      return unit.id
    }
    const head = this.head(unit)
    const tail = head && head.kind !== "delete" && info.bytes >= head.size && appendsOnly(seenPath) ? head.tail : null
    if (head && tail && (await tailHash(path, head.size)).equals(tail)) {
      if (info.bytes > head.size) {
        const { chunks } = await this.storeStream(recordChunks(path, head.size, info.bytes), report, true)
        this.addVersion(unit, "append", head.size, info.bytes, null, await tailHash(path, info.bytes), chunks, { path: seenPath })
        report.versions.push({ unit: unit.key, kind: "append", bytes: info.bytes - head.size })
      } else report.unchanged += 1
    } else {
      const { chunks, digest, tail } = await this.storeStream(recordChunks(path, 0, info.bytes), report, true)
      if (head && head.kind !== "delete" && head.digest?.equals(digest) && head.size === info.bytes) report.unchanged += 1
      else {
        this.addVersion(unit, "replace", 0, info.bytes, digest, tail, chunks, { path: seenPath })
        report.versions.push({ unit: unit.key, kind: "replace", bytes: info.bytes })
      }
    }
    this.prepared("UPDATE units SET seen_path = ?, seen_identity = ?, seen_mtime = ?, seen_bytes = ?, places = ? WHERE id = ?")
      .run(seenPath, info.identity, info.mtimeMs, info.bytes, placed ? JSON.stringify(placed.places) : null, unit.id)
    return unit.id
  }

  /**
   * A file of the session the harness no longer lists is deleted only once
   * it's gone from every place the harness keeps it. A capture runs only
   * while the session exists, so this is the harness moving or dropping one
   * of its files (Grok's folder for another directory), never the session
   * expiring.
   */
  private async captureGoneFiles(session: number, folders: ReadonlyMap<string, string>, seen: Set<number>, report: CaptureReport): Promise<void> {
    const units = UnitRowSchema.array().parse(this.prepared(`SELECT u.* FROM session_units su JOIN units u ON u.id = su.unit WHERE su.session = ? AND u.role = 'file'`).all(session))
    for (const unit of units) {
      if (seen.has(unit.id) || unit.head < 0 || !unit.seen_path) continue
      const head = this.head(unit)
      if (!head || head.kind === "delete") continue
      const present = await Promise.all(placements(unit.seen_path, unit.places).map((place) => {
        try {
          return statRecord(placeIn(folders, place))
        } catch {
          // A root the harness no longer declares holds nothing of it.
          return null
        }
      }))
      if (present.some(Boolean)) continue
      this.addVersion(unit, "delete", 0, 0, null, null, Buffer.alloc(0), { path: unit.seen_path })
      report.versions.push({ unit: unit.key, kind: "delete", bytes: 0 })
    }
  }

  /** The session's lines in a shared JSON Lines file, as one unit; the file is read only when it changed. */
  private async captureLines(harness: string, session: number, roots: readonly RecordRoot[], lines: RecordLines, report: CaptureReport): Promise<void> {
    const key = linesUnitKey(qualify(roots, lines.path), lines)
    const info = await stat(lines.path).catch(() => null)
    const fingerprint = info ? `${info.ino}:${info.size}:${info.mtimeMs}` : "missing"
    if (this.mark(session, key) === fingerprint) {
      report.unchanged += 1
      return
    }
    const found = info ? await linesOf(lines.path, lines) : Buffer.alloc(0)
    if (found.length) await this.captureValue(harness, session, key, "lines", found, sha256(found), report)
    else {
      const unit = this.unitByKey(harness, key)
      const head = unit && this.head(unit)
      if (unit && head && head.kind !== "delete") {
        this.addVersion(unit, "delete", 0, 0, null, null, Buffer.alloc(0), null)
        report.versions.push({ unit: key, kind: "delete", bytes: 0 })
      }
    }
    this.setMark(session, key, fingerprint)
  }

  private async captureDatabase(harness: string, session: number, roots: readonly RecordRoot[], database: RecordDatabase, report: CaptureReport): Promise<void> {
    if (!existsSync(database.path)) return
    const name = qualify(roots, database.path)
    // A database neither written nor checkpointed since the last whole capture, asked for the same rows, holds nothing new.
    const fingerprint = await databaseFingerprint(database)
    if (this.mark(session, name) === fingerprint) {
      report.unchanged += 1
      return
    }
    const source = new SourceRead(database.path)
    try {
      const statements = SchemaStatementSchema.array().parse(source.statement("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all()).map((row) => row.sql)
      const userVersion = Number(UserVersionSchema.parse(source.statement("PRAGMA user_version").get()).user_version)
      const schema = Buffer.from(JSON.stringify({ statements, userVersion }))
      const schemaDigest = sha256(schema)
      await this.captureValue(harness, session, `${name}\tschema`, "schema", schema, schemaDigest, report)
      // A migration that adds a column changes every row, rewritten or not, so rows are skipped by key only under the schema this session last read whole.
      const settled = this.mark(session, `${name}\tschema`) === schemaDigest.toString("hex")
      const tables = new Set(TableNameSchema.array().parse(source.statement("SELECT name FROM sqlite_master WHERE type = 'table'").all()).map((row) => row.name))
      for (const table of database.tables) {
        if (tables.has(table.table)) await this.captureTable(harness, session, name, source, table, settled, report)
      }
      // Only a capture that read every table marks the database, so a restore can tell one cut short, and the next capture rereads what this one didn't reach.
      this.setMark(session, `${name}\tschema`, schemaDigest.toString("hex"))
    } finally {
      source.end()
      report.reads += source.reads
      report.longestReadMs = Math.max(report.longestReadMs, source.longestMs)
    }
    this.setMark(session, name, fingerprint)
  }

  /**
   * One table's rows of the session. The rows are listed by where they are
   * in one read, then read whole in reads of their own, each ended before
   * what it read is stored. A row of an immutable table whose key Mako holds
   * is never read whole again while the database's schema is `settled`.
   *
   * Nor, where its position is its rowid, listed again. A capture that took
   * every row it listed, and found none of the session's it didn't list,
   * marks the table with the session's highest rowid and a digest of its
   * keys, both taken in the listing's own read. The next capture, with the
   * schema settled, digests the keys again: the same digest, nothing changed;
   * the same below that rowid, only rows above it, where SQLite puts each new
   * row, are listed. Anything else lists the table as if unmarked.
   */
  private async captureTable(harness: string, session: number, name: string, source: SourceRead, table: RecordTable, settled: boolean, report: CaptureReport): Promise<void> {
    const keys = keyColumns(source.db, table.table)
    const located = positionColumns(source.db, table.table, keys)
    const positions = located?.columns
    const immutable = Boolean(table.immutable && keys.length && settled)
    const params = table.params ?? []
    const rowid = table.immutable && keys.length && located?.rowid ? located.columns[0] : undefined
    const marked = `${name}\tkeys\t${table.table}`
    const mark = this.keysMark(session, marked)
    let digests = immutable && rowid && mark ? this.keyDigests(source, table, rowid, keys, mark.through) : null
    if (mark && digests?.keys.all === mark.keys) {
      report.rowsMatched += digests.keys.rows
      return
    }
    const above = mark && digests?.keys.below === mark.keys ? mark.through : null
    let known = new Map<string, KnownUnit>()
    if (above === null) {
      // A capture cut short leaves no mark for rows it may not have reached.
      if (mark) this.clearMark(session, marked)
      // What the session holds loads with no read open, which would keep the harness from checkpointing meanwhile.
      source.end()
      known = this.known(session, harness, `${name}\trow\t${table.table}\t`, `${name}\trow\t${table.table}\n`)
      // In the read that lists the rows, so the mark names the rows this capture takes; under a schema not yet settled too, when it reads every row whole.
      digests = rowid ? this.keyDigests(source, table, rowid, keys, null) : null
    } else if (digests) report.rowsMatched += digests.keys.rowsBelow
    const conditions: string[] = []
    if (table.where) conditions.push(`(${table.where})`)
    if (above !== null && rowid) conditions.push(`${quoted(rowid)} > ?`)
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""
    const listParams = above === null ? params : [...params, above]
    let whole = true
    const page: ReadRow[] = []
    let pageBytes = 0
    const read = (row: RecordRow) => {
      report.rowsRead += 1
      const bytes = encodeRow(row)
      page.push({ key: rowUnitKey(name, table.table, keys, row), bytes, digest: sha256(bytes) })
      pageBytes += bytes.length
    }
    const store = async () => {
      source.end()
      pageBytes = 0
      // A page read in 100 ms can take seconds to store: waiting work goes between its rows.
      for (const row of page.splice(0)) {
        await this.captureRow(harness, session, row, known.get(row.key), report)
        await this.slice(report)
      }
    }
    if (!located || !positions) {
      // Its rows can't be found again by position: read as SQLite lists them, in one read, each stored as it comes.
      for (const row of source.statement(`SELECT * FROM ${quoted(table.table)}${where}`).iterate(...listParams)) {
        read({ ...row })
        for (const each of page.splice(0)) await this.captureRow(harness, session, each, known.get(each.key), report)
      }
      pageBytes = 0
    } else {
      // SQLite names a selected rowid after the column aliasing it, so each position is read under a name of its own.
      const named = positions.map((_, index) => `mako_position_${index}`)
      const listed = [...positions.map((column, index) => `${quoted(column)} AS ${named[index]}`), ...(immutable ? keys.map(quoted) : [])]
      const pending: RecordValue[][] = []
      // A long session lists hundreds of thousands of positions in this one read: rows as arrays, column N at N, skip an object each.
      const listing = source.statement(`SELECT ${listed.join(", ")} FROM ${quoted(table.table)}${where}`, true).all(...listParams)
      // Telling held rows by their keys takes longer than listing them: the read ends first.
      if (source.due || immutable) source.end()
      for (const row of listing) {
        const at = positions.map((_, index) => row[index] ?? null)
        if (immutable && keys.every((_, index) => row[positions.length + index] !== null)) {
          const key = rowUnitKey(name, table.table, keys, Object.fromEntries(keys.map((column, index) => [column, row[positions.length + index] ?? null])))
          const have = known.get(key)
          if (have) {
            have.seen = true
            if (have.kind !== "delete") {
              report.unchanged += 1
              continue
            }
          } else {
            const unit = this.unitByKey(harness, key)
            const head = unit && this.head(unit)
            if (head && head.kind !== "delete") {
              // Another session holds the same row, or this one took it in a capture that didn't finish: it's this session's, with nothing to read.
              this.unit(harness, key, "row", session)
              report.unchanged += 1
              continue
            }
          }
        }
        if (at.includes(null)) throw new Error(`A row of ${name} ${table.table} has no position to read it again by (${positions.join(", ")})`)
        pending.push(at)
      }
      // Rows are read FETCH_ROWS positions at a time, so the session's condition (a subquery, for some) is evaluated once per batch, not per row.
      const tuple = positions.length === 1 ? quoted(positions[0] ?? "") : `(${positions.map(quoted).join(", ")})`
      const slot = positions.length === 1 ? "?" : `(${positions.map(() => "?").join(", ")})`
      const fetch = (count: number) => `SELECT *, ${positions.map((column, index) => `${quoted(column)} AS ${named[index]}`).join(", ")} FROM ${quoted(table.table)} ${located.access}
        WHERE ${tuple} IN (${positions.length === 1 ? "" : "VALUES "}${Array.from({ length: count }, () => slot).join(", ")})${table.where ? ` AND (${table.where})` : ""}`
      const spot = (at: readonly RecordValue[]) => JSON.stringify(at.map((value) => tagged(SqlValueSchema.parse(value))))
      let next = 0
      let carried: RecordValue[][] = []
      while (carried.length || next < pending.length) {
        const batch = [...carried, ...pending.slice(next, next + FETCH_ROWS - carried.length)]
        next += batch.length - carried.length
        carried = []
        const done = new Set<string>()
        let cut = false
        for (const row of source.statement(fetch(batch.length)).iterate(...batch.flat(), ...params)) {
          done.add(spot(named.map((column) => row[column] ?? null)))
          read(Object.fromEntries(Object.entries(row).filter(([column]) => !named.includes(column))))
          if (pageBytes >= READ_BYTES || source.due) {
            cut = true
            break
          }
        }
        // What the batch didn't reach goes first in the next read. A position it reached without a row is gone, or no longer the session's: the write that did it brings another capture.
        if (cut) carried = batch.filter((at) => !done.has(spot(at)))
        else if (done.size < batch.length) whole = false
        if (cut || pageBytes >= READ_BYTES || source.due) await store()
      }
    }
    if (page.length) await store()
    if (above === null && await this.captureMissing(harness, session, name, source, table, known, report)) whole = false
    if (digests && digests.through !== null && whole) this.setMark(session, marked, JSON.stringify({ through: String(digests.through), keys: digests.keys.all }))
  }

  /**
   * The table's units this capture didn't list: still the session's (written
   * again under the key after the listing), taken now; still there but
   * another's, no longer this session's; gone, deleted. True when it took one.
   */
  private async captureMissing(harness: string, session: number, name: string, source: SourceRead, table: RecordTable, known: Map<string, KnownUnit>, report: CaptureReport): Promise<boolean> {
    const prefix = `${name}\trow\t${table.table}\t`
    const params = table.params ?? []
    let took = false
    for (const [key, have] of known) {
      if (have.seen || have.kind === "delete" || !key.startsWith(prefix)) continue
      const lookup = rowKeyOf(key)
      const own = source.statement(lookupSql(table.table, lookup.columns, table.where)).get(...lookup.values, ...params)
      if (own) {
        took = true
        report.rowsRead += 1
        const bytes = encodeRow({ ...own })
        await this.captureRow(harness, session, { key, bytes, digest: sha256(bytes) }, have, report)
      } else if (source.statement(lookupSql(table.table, lookup.columns)).get(...lookup.values)) {
        this.prepared("DELETE FROM session_units WHERE session = ? AND unit = ?").run(session, have.id)
      } else {
        this.addVersion(have, "delete", 0, 0, null, null, Buffer.alloc(0), null)
        report.versions.push({ unit: key, kind: "delete", bytes: 0 })
      }
      if (source.due) {
        source.end()
        await this.slice(report)
      }
    }
    return took
  }

  private async captureRow(harness: string, session: number, row: ReadRow, have: KnownUnit | undefined, report: CaptureReport): Promise<void> {
    if (have) {
      have.seen = true
      if (have.kind !== "delete" && have.digest?.equals(row.digest)) {
        report.unchanged += 1
        return
      }
      const { chunks } = await this.storeStream([{ bytes: row.bytes }], report, false)
      this.addVersion(have, "replace", 0, row.bytes.length, row.digest, null, chunks, null)
      have.kind = "replace"
      have.digest = row.digest
      report.versions.push({ unit: row.key, kind: "replace", bytes: row.bytes.length })
      return
    }
    await this.captureValue(harness, session, row.key, "row", row.bytes, row.digest, report)
  }

  /** The newest version of each of a session's units with keys in [from, to), in one read. */
  private known(session: number, harness: string, from: string, to: string): Map<string, KnownUnit> {
    const known = new Map<string, KnownUnit>()
    for (const row of this.prepared(`
      SELECT u.id, u.key, u.role, u.head, v.kind, v.size, v.digest FROM session_units su JOIN units u ON u.id = su.unit JOIN versions v ON v.unit = u.id AND v.seq = u.head
      WHERE su.session = ? AND u.harness = ? AND u.key >= ? AND u.key < ?`).iterate(session, harness, from, to)) {
      const head = UnitHeadSchema.parse(row)
      known.set(head.key, { id: head.id, head: head.head, kind: head.kind, digest: head.digest ? Buffer.from(head.digest) : null, seen: false })
    }
    return known
  }

  private async captureValue(harness: string, session: number, key: string, role: UnitRole, bytes: Buffer, digest: Buffer, report: CaptureReport): Promise<void> {
    const unit = this.unit(harness, key, role, session)
    const head = this.head(unit)
    if (head && head.kind !== "delete" && head.digest?.equals(digest)) {
      report.unchanged += 1
      return
    }
    const { chunks } = await this.storeStream([{ bytes }], report, false)
    this.addVersion(unit, "replace", 0, bytes.length, digest, null, chunks, null)
    report.versions.push({ unit: key, kind: "replace", bytes: bytes.length })
  }

  private addVersion(unit: { id: number; head: number }, kind: VersionKind, at: number, size: number, digest: Buffer | null, tail: Buffer | null, chunks: Buffer, detail: { path: string } | null): void {
    const seq = unit.head + 1
    this.prepared("INSERT INTO versions (unit, seq, kind, at, size, digest, tail, chunks, captured_at, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(unit.id, seq, kind, at, size, digest, tail, chunks, Date.now(), detail ? JSON.stringify(detail) : null)
    this.prepared("UPDATE units SET head = ? WHERE id = ?").run(seq, unit.id)
    unit.head = seq
  }

  /**
   * Chunks a stream of bytes, storing each chunk not yet stored; the chunk
   * list, the whole digest and the tail hash. A long stream is `sliced`: what
   * it stored so far commits, and waiting work runs, between its chunks.
   */
  private async storeStream(source: AsyncIterable<{ bytes: Buffer }> | Iterable<{ bytes: Buffer }>, report: CaptureReport, sliced: boolean): Promise<{ chunks: Buffer; digest: Buffer; tail: Buffer }> {
    const chunker = new Chunker()
    const digest = createHash("sha256")
    const hashes: Buffer[] = []
    let size = 0
    let window: Buffer = Buffer.alloc(0)
    const store = async (chunk: Buffer) => {
      const hash = chunkHash(chunk)
      hashes.push(hash)
      if (this.prepared("SELECT 1 FROM chunks WHERE hash = ?").get(hash)) return
      const place = await this.packs.write(hash, chunk)
      this.prepared("INSERT INTO chunks (hash, pack, offset, stored, size, codec) VALUES (?, ?, ?, ?, ?, ?)")
        .run(hash, place.pack, place.offset, place.stored, place.size, place.codec)
      report.newChunks += 1
      report.newBytes += place.size
      report.storedBytes += place.stored
      // A chunk committed before the version naming it is harmless: chunks are stored by hash, and the next capture finds it there.
      if (sliced) await this.slice(report)
    }
    for await (const { bytes } of source) {
      digest.update(bytes)
      size += bytes.length
      window = keepTail(window, bytes)
      for (const chunk of chunker.push(bytes)) await store(chunk)
    }
    for (const chunk of chunker.end()) await store(chunk)
    return { chunks: Buffer.concat(hashes), digest: digest.digest(), tail: windowHash(window, size) }
  }

  private async *unitContent(unit: number, upTo: number): AsyncGenerator<Buffer> {
    const versions = ContentVersionSchema.array().parse(this.prepared("SELECT seq, kind, chunks FROM versions WHERE unit = ? AND seq <= ? ORDER BY seq").all(unit, upTo))
    let from = 0
    versions.forEach((version, index) => {
      if (version.kind === "replace") from = index
    })
    for (const version of versions.slice(from)) {
      if (version.kind === "delete") continue
      yield* this.chunksOf(Buffer.from(version.chunks))
    }
  }

  /** One version's own bytes: a row, schema or lines version is whole in itself. */
  private versionBytes(unit: number, seq: number): Promise<Buffer> {
    const version = ContentVersionSchema.parse(this.prepared("SELECT seq, kind, chunks FROM versions WHERE unit = ? AND seq = ?").get(unit, seq))
    return collect(this.chunksOf(Buffer.from(version.chunks)))
  }

  private async *chunksOf(list: Buffer): AsyncGenerator<Buffer> {
    for (let at = 0; at < list.length; at += HASH_BYTES) {
      const hash = list.subarray(at, at + HASH_BYTES)
      const place = this.prepared("SELECT pack, offset, stored, size, codec FROM chunks WHERE hash = ?").get(hash)
      if (!place) throw new Error(`The chunk ${hash.toString("hex")} is missing from the record store`)
      yield await this.packs.read(ChunkPlaceSchema.parse(place))
    }
  }

  private lastContentSeq(unit: number): number {
    return NewestSeqSchema.parse(this.prepared("SELECT max(seq) AS seq FROM versions WHERE unit = ? AND kind != 'delete'").get(unit)).seq ?? -1
  }

  /** The size a file unit has as of its last version holding content. */
  private contentSize(unit: number): number {
    const versions = SizedVersionSchema.array().parse(this.prepared("SELECT kind, size FROM versions WHERE unit = ? ORDER BY seq").all(unit))
    let size = 0
    for (const version of versions) if (version.kind !== "delete") size = version.size
    return size
  }

  // Restore

  private async restoreNow(input: RestoreInput): Promise<RestoreReport> {
    const { harness, nativeId } = input
    const found = SessionRowSchema.optional().parse(this.prepared("SELECT id, layout FROM sessions WHERE harness = ? AND native_id = ?").get(harness, nativeId))
    if (!found?.layout) throw new Error(`Mako holds no records of ${harness} session ${nativeId}`)
    const session = found.id
    const layout = SessionLayoutSchema.parse(JSON.parse(found.layout))
    const places = new RootPlaces({ home: layout.home, roots: new Map(Object.entries(layout.roots)) }, { home: input.home, roots: input.roots ?? input.destination?.roots })
    const report: RestoreReport = { actions: [], rows: [], diverged: places.missing.map(({ root, reason }) => ({ unit: `${root}:`, reason })), movedPaths: 0, written: false }
    if (report.diverged.length) return report

    const files = UnitRowSchema.array().parse(this.prepared("SELECT u.* FROM session_units su JOIN units u ON u.id = su.unit WHERE su.session = ? AND u.role = 'file' ORDER BY u.key").all(session))
    const filePlans = new Map<number, FilePlan>()
    for (const unit of files) {
      if (!unit.seen_path || this.lastContentSeq(unit.id) < 0) continue
      const plan = await this.planFile(places, unit, report)
      if (plan) filePlans.set(unit.id, plan)
    }
    const lines = UnitHeadSchema.array().parse(this.prepared(`
      SELECT u.id, u.key, u.role, u.head, v.kind, v.size, v.digest FROM session_units su JOIN units u ON u.id = su.unit JOIN versions v ON v.unit = u.id AND v.seq = u.head
      WHERE su.session = ? AND u.role = 'lines' ORDER BY u.key`).all(session))
    const linePlans: LinesPlan[] = []
    for (const unit of lines) {
      const plan = await this.planLines(places, unit, report)
      if (plan) linePlans.push(plan)
    }
    const databases = TableNameSchema.array().parse(this.prepared(`
      SELECT DISTINCT substr(u.key, 1, instr(u.key, char(9)) - 1) AS name FROM session_units su JOIN units u ON u.id = su.unit
      WHERE su.session = ? AND u.role IN ('row', 'schema') ORDER BY name`).all(session)).map((row) => row.name)
    const rowPlans = new Map<string, DatabasePlan>()
    for (const name of databases) {
      if (!this.mark(session, name)) {
        report.diverged.push({ unit: name, reason: "Mako's first capture of this database never finished, so it holds only part of the session's rows" })
        continue
      }
      rowPlans.set(name, await this.planDatabase(harness, session, places, name, layout.paths[name] ?? {}, report))
    }
    if (input.destination) this.checkDestination(input.destination, new Set([...files.map((unit) => unit.key), ...this.sessionKeys(session)]), report)
    if (report.diverged.length || input.dryRun) return report
    if (await input.held?.()) {
      report.diverged.push({ unit: nativeId, reason: "Something on this machine holds the session open" })
      return report
    }
    for (const unit of files) {
      const plan = filePlans.get(unit.id)
      if (plan) await this.applyFile(unit, plan)
    }
    for (const plan of linePlans) await this.applyLines(plan)
    for (const [name, plan] of rowPlans) await this.applyDatabase(places, name, plan)
    report.written = report.actions.some((action) => action.action !== "skip") || report.rows.some((rows) => rows.insert + rows.replace + rows.delete > 0)
    return report
  }

  /** Every row, schema and lines key of a session, for comparing with what a destination holds. */
  private sessionKeys(session: number): string[] {
    return KeySchema.array().parse(this.prepared("SELECT u.key FROM session_units su JOIN units u ON u.id = su.unit WHERE su.session = ? AND u.role != 'file'").all(session)).map((row) => row.key)
  }

  /**
   * A file as its newest version has it. One the harness has since dropped
   * from the session is left out, and taken out of a destination that still
   * holds a version of it Mako knows.
   */
  private async planFile(places: RootPlaces, unit: UnitRow, report: RestoreReport): Promise<FilePlan | null> {
    // SAFETY: the caller passes only units with a seen path.
    const path = unit.seen_path!
    const size = this.contentSize(unit.id)
    const target = places.place(plainRecordPath(path))
    let existing: string | undefined
    let info: Awaited<ReturnType<typeof statRecord>> = null
    for (const place of placements(path, unit.places)) {
      info = await statRecord(places.place(place))
      if (info) {
        existing = places.place(place)
        break
      }
    }
    const record = (action: RestoreActionKind, bytes: number) => report.actions.push({ unit: unit.key, action, path: plainRecordPath(path), bytes })
    const dropped = this.head(unit)?.kind === "delete"
    if (!existing || !info) {
      if (dropped) {
        record("skip", 0)
        return null
      }
      record("write", size)
      return { action: "write", target, from: 0 }
    }
    if (info.bytes > size) {
      report.diverged.push({ unit: unit.key, reason: `The destination holds ${info.bytes} bytes; Mako's newest version has ${size}` })
      return null
    }
    if (!(await this.prefixMatches(unit.id, existing, info.bytes))) {
      report.diverged.push({ unit: unit.key, reason: `The destination's ${info.bytes} bytes differ from Mako's version` })
      return null
    }
    if (dropped) {
      record("delete", 0)
      return { action: "delete", target: existing, from: 0 }
    }
    if (info.bytes === size) {
      record("skip", 0)
      return null
    }
    if (info.encoding === "plain") {
      record("append", size - info.bytes)
      return { action: "append", target: existing, from: info.bytes }
    }
    record("write-plain", size)
    return { action: "write-plain", target, from: 0, existing }
  }

  /** Whether the destination's first `length` bytes are the store's. */
  private async prefixMatches(unit: number, path: string, length: number): Promise<boolean> {
    if (length === 0) return true
    const ours = this.unitContent(unit, this.lastContentSeq(unit))
    let pending: Buffer = Buffer.alloc(0)
    for await (const { bytes } of recordChunks(path, 0, length)) {
      let offset = 0
      while (offset < bytes.length) {
        if (!pending.length) {
          const next = await ours.next()
          if (next.done) return false
          pending = next.value
        }
        const take = Math.min(pending.length, bytes.length - offset)
        if (!pending.subarray(0, take).equals(bytes.subarray(offset, offset + take))) return false
        pending = pending.subarray(take)
        offset += take
      }
    }
    await ours.return(undefined)
    return true
  }

  private async applyFile(unit: UnitRow, plan: FilePlan): Promise<void> {
    if (plan.action === "delete") {
      await rm(plan.target, { force: true })
      return
    }
    const seq = this.lastContentSeq(unit.id)
    if (plan.action === "append") {
      const handle = await open(plan.target, "a")
      try {
        const { size } = await handle.stat()
        if (size !== plan.from) throw new Error(`${plan.target} changed while restoring: ${size} bytes, expected ${plan.from}`)
        let at = 0
        for await (const chunk of this.unitContent(unit.id, seq)) {
          const end = at + chunk.length
          if (end > plan.from) await handle.write(chunk.subarray(Math.max(0, plan.from - at)))
          at = end
        }
        await handle.sync()
      } finally {
        await handle.close()
      }
      return
    }
    await mkdir(dirname(plan.target), { recursive: true })
    const temporary = `${plan.target}.mako-restore-${process.pid}`
    const handle = await open(temporary, "w")
    try {
      for await (const chunk of this.unitContent(unit.id, seq)) await handle.write(chunk)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, plan.target)
    if (plan.existing && plan.existing !== plan.target) await rm(plan.existing, { force: true })
  }

  /** A session's lines go at the end of the destination's file, after whatever of them it already holds; lines it holds that Mako never saw mean it went on there. */
  private async planLines(places: RootPlaces, unit: z.infer<typeof UnitHeadSchema>, report: RestoreReport): Promise<LinesPlan | null> {
    const [name = "", , encoded = "{}"] = unit.key.split("\t")
    const [[field = "", value = ""] = []] = Object.entries(LinesKeySchema.parse(JSON.parse(encoded)))
    const target = places.place(name)
    const record = (action: RestoreActionKind, bytes: number) => report.actions.push({ unit: unit.key, action, path: name, bytes })
    if (unit.kind === "delete") {
      record("skip", 0)
      return null
    }
    const ours = await this.versionBytes(unit.id, unit.head)
    const theirs = existsSync(target) ? await linesOf(target, { field, value }) : Buffer.alloc(0)
    if (theirs.equals(ours)) {
      record("skip", 0)
      return null
    }
    if (theirs.length > ours.length || !ours.subarray(0, theirs.length).equals(theirs)) {
      report.diverged.push({ unit: unit.key, reason: "The destination holds lines of the session Mako never captured" })
      return null
    }
    record("append", ours.length - theirs.length)
    return { target, bytes: ours.subarray(theirs.length) }
  }

  private async applyLines(plan: LinesPlan): Promise<void> {
    await mkdir(dirname(plan.target), { recursive: true })
    const handle = await open(plan.target, "a+")
    try {
      const { size } = await handle.stat()
      const last = Buffer.alloc(1)
      if (size > 0) await handle.read(last, 0, 1, size - 1)
      await handle.write(size > 0 && last[0] !== 0x0a ? Buffer.concat([Buffer.from("\n"), plan.bytes]) : plan.bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  /**
   * Each row and the schema of one database, as the destination should hold
   * them. Values naming a path in one of the session's roots are compared,
   * and written, as they are where the root goes.
   */
  private async planDatabase(harness: string, session: number, places: RootPlaces, name: string, paths: Record<string, string[]>, report: RestoreReport): Promise<DatabasePlan> {
    const path = places.place(name)
    const db = existsSync(path) ? openReadOnly(path, { timeout: 5_000 }).database : null
    const moving = places.moving && Object.keys(paths).length > 0
    const plan: DatabasePlan = { schema: null, rows: [], moves: moving ? paths : {} }
    const lookups = new Map<string, StatementSync>()
    const tallies = new Map<string, RestoreRows>()
    try {
      const tables = new Set(db ? TableNameSchema.array().parse(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).map((row) => row.name) : [])
      for (const row of this.prepared(`
        SELECT u.id, u.key, u.role, u.head, v.kind, v.size, v.digest FROM session_units su JOIN units u ON u.id = su.unit JOIN versions v ON v.unit = u.id AND v.seq = u.head
        WHERE su.session = ? AND u.harness = ? AND u.key >= ? AND u.key < ? ORDER BY u.key`).iterate(session, harness, `${name}\t`, `${name}\n`)) {
        const unit = UnitHeadSchema.parse(row)
        if (unit.role === "schema") {
          plan.schema = { id: unit.id, head: unit.head }
          continue
        }
        const key = rowKeyOf(unit.key)
        const moves = movesOf(plan, key.table)
        let present: RecordRow | undefined
        if (db && tables.has(key.table)) {
          const sql = `${key.table}\n${key.columns.join("\n")}`
          let lookup = lookups.get(sql)
          if (!lookup) lookups.set(sql, lookup = lookupStatement(db, key.table, key.columns))
          const found = lookup.get(...movedKey(places, key, moves))
          present = found && { ...found }
        }
        // The newest version as the destination would hold it, read only when a value in it may move.
        const newest = moves && unit.kind !== "delete" ? decodeRow(await this.versionBytes(unit.id, unit.head)) : null
        const moved = newest && moves ? moveRow(places, newest, moves) : null
        const action = await (async (): Promise<"skip" | "insert" | "replace" | "delete" | null> => {
          if (!present) return unit.kind === "delete" ? "skip" : "insert"
          const digest = sha256(encodeRow(present))
          const expected = unit.kind === "delete" ? null : moved ? sha256(encodeRow(moved)) : unit.digest && Buffer.from(unit.digest)
          if (expected?.equals(digest)) return "skip"
          if (!(await this.knownVersion(unit.id, digest, moves ? (bytes) => sha256(encodeRow(moveRow(places, decodeRow(bytes), moves))) : null))) return null
          return unit.kind === "delete" ? "delete" : "replace"
        })()
        if (action === null) report.diverged.push({ unit: unit.key, reason: "The destination's row differs from every version Mako captured" })
        else {
          let rows = tallies.get(key.table)
          if (!rows) tallies.set(key.table, rows = { path: name, table: key.table, insert: 0, replace: 0, delete: 0, skip: 0, bytes: 0 })
          rows[action] += 1
          if (action === "insert" || action === "replace") rows.bytes += unit.size
          if (action !== "skip") {
            plan.rows.push({ id: unit.id, head: unit.head, delete: action === "delete" })
            if (newest && moved) report.movedPaths += Object.keys(newest).filter((column) => newest[column] !== moved[column]).length
          }
        }
      }
    } finally {
      db?.close()
    }
    report.rows.push(...tallies.values())
    return plan
  }

  /** Whether `digest` is the digest of a version Mako captured, as the destination would hold it. */
  private async knownVersion(unit: number, digest: Buffer, as: ((bytes: Buffer) => Buffer) | null): Promise<boolean> {
    if (!as) return Boolean(this.prepared("SELECT 1 FROM versions WHERE unit = ? AND digest = ?").get(unit, digest))
    for (const { seq } of SeqSchema.array().parse(this.prepared("SELECT seq FROM versions WHERE unit = ? AND kind = 'replace' ORDER BY seq DESC").all(unit)))
      if (as(await this.versionBytes(unit, seq)).equals(digest)) return true
    return false
  }

  private async applyDatabase(places: RootPlaces, name: string, plan: DatabasePlan): Promise<void> {
    if (!plan.rows.length) return
    const target = places.place(name)
    await mkdir(dirname(target), { recursive: true })
    const db = this.stores.openForWriting(target)
    // The harness may be running and writing the same database; its write lock is waited for, then held for the whole restore.
    db.exec(`PRAGMA busy_timeout = ${WRITE_BUSY_TIMEOUT_MS}`)
    // Rows arrive table by table, children before parents, and replacing a parent row must not cascade into rows already restored.
    db.exec("PRAGMA foreign_keys = OFF")
    db.exec("BEGIN IMMEDIATE")
    try {
      if (plan.schema) {
        const { statements, userVersion } = SchemaSnapshotSchema.parse(JSON.parse((await this.versionBytes(plan.schema.id, plan.schema.head)).toString("utf8")))
        const has = db.prepare("SELECT 1 FROM sqlite_master WHERE sql = ?")
        // A virtual table creates its shadow tables itself, and a home that already holds the store keeps its schema.
        for (const statement of statements) if (!has.get(statement)) db.exec(statement)
        const current = Number(UserVersionSchema.parse(db.prepare("PRAGMA user_version").get()).user_version)
        if (current === 0 && userVersion !== 0) db.exec(`PRAGMA user_version = ${Math.trunc(userVersion)}`)
      }
      // One statement per table and set of columns, however many rows use it.
      const statements = new Map<string, StatementSync>()
      const statement = (sql: string) => {
        let prepared = statements.get(sql)
        if (!prepared) statements.set(sql, prepared = db.prepare(sql))
        return prepared
      }
      for (const row of plan.rows) {
        const key = rowKeyOf(KeySchema.parse(this.prepared("SELECT key FROM units WHERE id = ?").get(row.id)).key)
        const moves = movesOf(plan, key.table)
        if (row.delete) {
          statement(`DELETE FROM ${quoted(key.table)} WHERE ${key.columns.map((column) => `${quoted(column)} IS ?`).join(" AND ")}`).run(...movedKey(places, key, moves))
          continue
        }
        const decoded = decodeRow(await this.versionBytes(row.id, row.head))
        const values = moves ? moveRow(places, decoded, moves) : decoded
        const names = Object.keys(values)
        statement(`INSERT OR REPLACE INTO ${quoted(key.table)} (${names.map(quoted).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
          .run(...names.map((column) => values[column] ?? null))
      }
      db.exec("COMMIT")
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK")
      throw error
    } finally {
      db.close()
    }
  }

  /** A file or owned row at the destination that Mako never captured means the session went on there. */
  private checkDestination(destination: SessionRecords, known: Set<string>, report: RestoreReport): void {
    for (const path of destination.files) {
      const key = fileUnitKey(destination, path)
      if (!known.has(key)) report.diverged.push({ unit: key, reason: "The destination holds a file of the session Mako never captured" })
    }
    for (const database of destination.databases) {
      if (!existsSync(database.path)) continue
      const name = qualify(destination.roots, database.path)
      const { database: db } = openReadOnly(database.path, { timeout: 5_000 })
      try {
        const tables = new Set(TableNameSchema.array().parse(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).map((row) => row.name))
        for (const table of database.tables) {
          if (!tables.has(table.table)) continue
          const keys = keyColumns(db, table.table)
          const statement = db.prepare(`SELECT * FROM ${quoted(table.table)}${table.where ? ` WHERE ${table.where}` : ""}`)
          statement.setReadBigInts(true)
          for (const row of statement.iterate(...(table.params ?? []))) {
            const key = rowUnitKey(name, table.table, keys, { ...row })
            if (!known.has(key)) report.diverged.push({ unit: key, reason: "The destination holds a row of the session Mako never captured" })
          }
        }
      } finally {
        db.close()
      }
    }
  }
}

interface FilePlan {
  action: "write" | "append" | "write-plain" | "delete"
  /** Where it's written; for an append or a delete, the file there now. */
  target: string
  from: number
  /** A compressed copy the plain one replaces. */
  existing?: string
}

interface LinesPlan {
  target: string
  bytes: Buffer
}

interface DatabasePlan {
  schema: { id: number; head: number } | null
  /** Each row to write or delete by its unit and newest version, its key read again when it's written: a session can own millions. */
  rows: { id: number; head: number; delete: boolean }[]
  /** Path columns by table, moved as the plan compared them. */
  moves: Record<string, string[]>
}

// Keys

/** A file's unit key: the one its harness gives it wherever it files it, else its plain path as the store names it. */
export function fileUnitKey(records: Pick<SessionRecords, "place" | "roots">, path: string): string {
  const plain = plainRecordPath(qualify(records.roots, path))
  return records.place?.(plain)?.key ?? plain
}

/** Where a file unit may be now, in every encoding: where it was last seen, then every place its harness files it. */
function placements(seenPath: string, places: string | null): string[] {
  const filed = places ? PlacesSchema.parse(JSON.parse(places)) : []
  return [...new Set([plainRecordPath(seenPath), ...filed])].flatMap((place) => [place, `${place}.zst`])
}

function linesUnitKey(name: string, lines: Pick<RecordLines, "field" | "value">): string {
  return `${name}\tlines\t${JSON.stringify({ [lines.field]: lines.value })}`
}

function layoutOf(home: string, records: SessionRecords): SessionLayout {
  const paths: SessionLayout["paths"] = {}
  for (const database of records.databases) {
    const declared = database.tables.filter((table) => table.paths?.length)
    if (declared.length) paths[qualify(records.roots, database.path)] = Object.fromEntries(declared.map((table) => [table.table, table.paths ?? []]))
  }
  return { home, roots: Object.fromEntries(records.roots.map((root) => [root.name, root.path])), paths }
}

// Moving paths

function movedValue(places: RootPlaces, value: RecordValue): RecordValue {
  const text = z.string().safeParse(value)
  return text.success ? places.moved(text.data) : value
}

function movesOf(plan: DatabasePlan, table: string): string[] | null {
  const columns = plan.moves[table]
  return columns?.length ? columns : null
}

/** A row key's values as the destination holds them. */
function movedKey(places: RootPlaces, key: RowKey, moves: readonly string[] | null): RecordValue[] {
  return moves ? key.values.map((value, index) => (moves.includes(key.columns[index] ?? "") ? movedValue(places, value) : value)) : key.values
}

function moveRow(places: RootPlaces, row: RecordRow, columns: readonly string[]): RecordRow {
  const moved = { ...row }
  for (const column of columns) if (column in moved) moved[column] = movedValue(places, moved[column] ?? null)
  return moved
}

// Files and lines

async function databaseFingerprint(database: RecordDatabase): Promise<string> {
  const files = await Promise.all(["", "-wal"].map(async (suffix) => {
    const info = await stat(`${database.path}${suffix}`).catch(() => null)
    return info ? [info.ino, info.size, info.mtimeMs] : null
  }))
  const tables = database.tables.map((table) => [table.table, table.where ?? null, (table.params ?? []).map((param) => tagged(SqlValueSchema.parse(param))), table.immutable ?? false])
  return sha256(Buffer.from(JSON.stringify([files, tables]))).toString("hex")
}

/** The lines of a JSON Lines file whose `field` is `value`, each as its own bytes and a newline, in the file's order. */
async function linesOf(path: string, { field, value }: Pick<RecordLines, "field" | "value">): Promise<Buffer> {
  const matching = z.object({ [field]: z.literal(value) })
  const needle = Buffer.from(JSON.stringify(value))
  const found: Buffer[] = []
  let rest: Buffer = Buffer.alloc(0)
  const take = (line: Buffer) => {
    if (!line.includes(needle)) return
    try {
      if (matching.safeParse(JSON.parse(line.toString("utf8"))).success) found.push(line, NEWLINE)
    } catch {
      // A line the harness is still writing, or one that isn't JSON, is no session's.
    }
  }
  for await (const piece of createReadStream(path)) {
    const bytes: Buffer = rest.length ? Buffer.concat([rest, piece]) : piece
    let start = 0
    for (let end = bytes.indexOf(0x0a, start); end !== -1; end = bytes.indexOf(0x0a, start)) {
      take(bytes.subarray(start, end))
      start = end + 1
    }
    rest = Buffer.from(bytes.subarray(start))
  }
  return Buffer.concat(found)
}

const NEWLINE = Buffer.from("\n")

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest()

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const part of source) parts.push(part)
  return Buffer.concat(parts)
}

/** A transcript the harness only ever appends to, so a capture can take just the new bytes. */
const appendsOnly = (path: string) => /\.(?:jsonl|ndjson)$/.test(plainRecordPath(path))

function keepTail(window: Buffer, bytes: Buffer): Buffer {
  if (bytes.length >= TAIL_BYTES) return Buffer.from(bytes.subarray(bytes.length - TAIL_BYTES))
  const joined = Buffer.concat([window, bytes])
  return joined.length > TAIL_BYTES ? joined.subarray(joined.length - TAIL_BYTES) : joined
}

function windowHash(window: Buffer, size: number): Buffer {
  return createHash("sha256").update(`${size}\n`).update(window).digest()
}

/** The hash of the bytes just before `size`, which a rewrite of the transcript changes. */
async function tailHash(path: string, size: number): Promise<Buffer> {
  let window: Buffer = Buffer.alloc(0)
  for await (const { bytes } of recordChunks(path, Math.max(0, size - TAIL_BYTES), size)) window = keepTail(window, bytes)
  return windowHash(window, size)
}

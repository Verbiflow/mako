import { createHash } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { open, rename, rm, mkdir, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite"
import { Chunker, chunkHash, HASH_BYTES, Packs, type ChunkPlace, type ChunkCodec } from "./record-chunks.js"
import { plainRecordPath, recordChunks, statRecord } from "./record-files.js"
import type { RecordDatabase, RecordRow, RecordTable, RecordValue, SessionRecords } from "./harness-records.js"
import { openReadOnly, type NativeStores } from "./read-only-sqlite.js"

/**
 * Mako's copy of every session's records, as the harness wrote them.
 *
 * A **unit** is the smallest thing a harness writes on its own: one file or
 * one row, plus each database's schema. Its key is logical: home-relative,
 * without the encoding, and for Codex without the date folder or
 * `archived_sessions`, so a rollout Codex compressed or archived is the same
 * unit. A unit's history is a list of **versions**, each appending to the one
 * before, replacing it, or deleting it. A version's bytes are content-defined
 * chunks (`record-chunks.ts`), each stored once by hash.
 *
 * Capture reads only what changed: a file whose placement (path, inode, size,
 * mtime) is unchanged isn't opened; an append-only file is read from where
 * the last version ended, once the bytes before that point check out; rows
 * are compared by content hash. Restore writes a session into a home: whole
 * where nothing is there, appending where the destination holds an earlier
 * version, and nothing at all when the destination went on without Mako.
 */

const SCHEMA_VERSION = 1
/** How long a restore waits for a running harness to release its database's write lock. */
const WRITE_BUSY_TIMEOUT_MS = 30_000
/** How far back from an append cursor a capture checks that nothing before it was rewritten. */
const TAIL_BYTES = 64 * 1024

export type UnitRole = "file" | "row" | "schema"
export type VersionKind = "append" | "replace" | "delete"

export interface CaptureInput {
  harness: string
  nativeId: string
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
  ms: number
}

export interface RestoreInput {
  harness: string
  nativeId: string
  home: string
  /** The destination's own records for the session, when it has them: a file or row Mako never saw there means the session went on without it. */
  destination?: SessionRecords
  /** True while something on the machine holds the session open; a restore then writes nothing. */
  held?: () => boolean | Promise<boolean>
  dryRun?: boolean
}

export type RestoreActionKind = "skip" | "write" | "append" | "write-plain" | "insert" | "replace" | "delete"

export interface RestoreAction {
  unit: string
  action: RestoreActionKind
  /** Home-relative. */
  path: string
  bytes: number
}

export interface RestoreReport {
  actions: RestoreAction[]
  /** Units the destination holds a version of that Mako never captured. Nothing is written when there are any. */
  diverged: { unit: string; reason: string }[]
  written: boolean
}

export interface UnitSummary {
  id: number
  key: string
  role: UnitRole
  path: string | null
  versions: number
  size: number
  kind: VersionKind
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

interface UnitRow {
  id: number
  key: string
  role: UnitRole
  head: number
  seen_path: string | null
  seen_identity: string | null
  seen_mtime: number | null
  seen_bytes: number | null
}

export class RecordStore {
  readonly folder: string
  private readonly db: DatabaseSync
  private readonly packs: Packs
  private readonly statements = new Map<string, StatementSync>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(folder: string, private readonly stores: NativeStores) {
    this.folder = folder
    mkdirSync(folder, { recursive: true })
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite")
    this.db = new DatabaseSync(join(folder, "records.sqlite"), { timeout: 60_000 })
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL")
    this.migrate()
    this.packs = new Packs(join(folder, "packs"))
  }

  /** Takes what's new in a session's records. Captures run one at a time. */
  capture(input: CaptureInput): Promise<CaptureReport> {
    return this.serially(() => this.captureNow(input))
  }

  restore(input: RestoreInput): Promise<RestoreReport> {
    return this.serially(() => this.restoreNow(input))
  }

  async close(): Promise<void> {
    await this.queue.catch(() => undefined)
    await this.packs.close()
    this.db.close()
  }

  sessions(harness?: string): { harness: string; nativeId: string; units: number; bytes: number }[] {
    return this.prepared(`
      SELECT s.harness, s.native_id AS nativeId, count(u.id) AS units, coalesce(sum(v.size), 0) AS bytes
      FROM sessions s JOIN session_units su ON su.session = s.id JOIN units u ON u.id = su.unit
      LEFT JOIN versions v ON v.unit = u.id AND v.seq = u.head
      WHERE ?1 IS NULL OR s.harness = ?1 GROUP BY s.id ORDER BY s.harness, s.native_id`)
      .all(harness ?? null) as { harness: string; nativeId: string; units: number; bytes: number }[]
  }

  units(harness: string, nativeId: string): UnitSummary[] {
    return this.prepared(`
      SELECT u.id, u.key, u.role, u.seen_path AS path, u.head + 1 AS versions, v.size, v.kind
      FROM sessions s JOIN session_units su ON su.session = s.id JOIN units u ON u.id = su.unit
      JOIN versions v ON v.unit = u.id AND v.seq = u.head
      WHERE s.harness = ? AND s.native_id = ? ORDER BY u.role, u.key`)
      .all(harness, nativeId) as unknown as UnitSummary[]
  }

  versions(harness: string, key: string): VersionSummary[] {
    const unit = this.unitByKey(harness, key)
    if (!unit) return []
    return (this.prepared("SELECT seq, kind, at, size, length(chunks) AS chunkBytes, captured_at, digest FROM versions WHERE unit = ? ORDER BY seq").all(unit.id) as {
      seq: number; kind: VersionKind; at: number; size: number; chunkBytes: number; captured_at: number; digest: Uint8Array | null
    }[]).map((row) => ({
      seq: row.seq, kind: row.kind, at: row.at, size: row.size, chunks: row.chunkBytes / HASH_BYTES,
      capturedAt: new Date(row.captured_at).toISOString(), digest: row.digest ? Buffer.from(row.digest).toString("hex") : null,
    }))
  }

  /** A unit's bytes as of version `seq` (the newest by default): a file's content, a row or schema in its encoding. */
  async *content(harness: string, key: string, seq?: number): AsyncGenerator<Buffer> {
    const unit = this.unitByKey(harness, key)
    if (!unit) throw new Error(`No unit ${key} of ${harness}`)
    yield* this.unitContent(unit.id, seq ?? unit.head)
  }

  /** A row or schema version decoded. */
  async decoded(harness: string, key: string, seq?: number): Promise<RecordRow | { statements: string[]; userVersion: number }> {
    const unit = this.unitByKey(harness, key)
    if (!unit || unit.role === "file") throw new Error(`${key} isn't a row or schema of ${harness}`)
    const bytes = await collect(this.unitContent(unit.id, seq ?? unit.head))
    return unit.role === "schema" ? JSON.parse(bytes.toString("utf8")) : decodeRow(bytes)
  }

  stats(): { sessions: number; units: number; versions: number; chunks: number; bytes: number; stored: number } {
    const count = (sql: string) => Number(Object.values(this.prepared(sql).get() ?? {})[0] ?? 0)
    return {
      sessions: count("SELECT count(*) FROM sessions"),
      units: count("SELECT count(*) FROM units"),
      versions: count("SELECT count(*) FROM versions"),
      chunks: count("SELECT count(*) FROM chunks"),
      bytes: count("SELECT coalesce(sum(size), 0) FROM chunks"),
      stored: count("SELECT coalesce(sum(stored), 0) FROM chunks"),
    }
  }

  /** Reads every chunk back and checks its hash; the chunks that fail. */
  async verify(): Promise<string[]> {
    return this.serially(async () => {
      const failures: string[] = []
      for (const row of this.prepared("SELECT hash, pack, offset, stored, size, codec FROM chunks").iterate()) {
        const hash = Buffer.from(row["hash"] as Uint8Array)
        try {
          const bytes = await this.packs.read(placeOf(row))
          if (!chunkHash(bytes).equals(hash)) failures.push(`${hash.toString("hex")}: its bytes hash differently`)
        } catch (error) {
          failures.push(`${hash.toString("hex")}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return failures
    })
  }

  private serially<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => undefined)
    return run
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS chunks (
        hash BLOB PRIMARY KEY, pack INTEGER NOT NULL, offset INTEGER NOT NULL,
        stored INTEGER NOT NULL, size INTEGER NOT NULL, codec INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS units (
        id INTEGER PRIMARY KEY, harness TEXT NOT NULL, key TEXT NOT NULL, role TEXT NOT NULL,
        head INTEGER NOT NULL DEFAULT -1,
        seen_path TEXT, seen_identity TEXT, seen_mtime REAL, seen_bytes INTEGER,
        UNIQUE (harness, key)
      );
      CREATE TABLE IF NOT EXISTS versions (
        unit INTEGER NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
        at INTEGER NOT NULL, size INTEGER NOT NULL, digest BLOB, tail BLOB, chunks BLOB NOT NULL,
        captured_at INTEGER NOT NULL, detail TEXT,
        PRIMARY KEY (unit, seq)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY, harness TEXT NOT NULL, native_id TEXT NOT NULL, UNIQUE (harness, native_id)
      );
      CREATE TABLE IF NOT EXISTS session_units (session INTEGER NOT NULL, unit INTEGER NOT NULL, PRIMARY KEY (session, unit)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS session_units_by_unit ON session_units (unit);
      CREATE TABLE IF NOT EXISTS database_marks (session INTEGER NOT NULL, name TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY (session, name)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS captures (
        id INTEGER PRIMARY KEY, session INTEGER NOT NULL, at INTEGER NOT NULL,
        versions INTEGER NOT NULL, new_bytes INTEGER NOT NULL, stored_bytes INTEGER NOT NULL, ms INTEGER NOT NULL
      );
    `)
    const version = this.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get()?.["value"]
    if (version === undefined) this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION))
    else if (Number(version) > SCHEMA_VERSION) throw new Error(`The record store at ${this.folder} has schema ${version}; this build knows ${SCHEMA_VERSION}`)
  }

  private prepared(sql: string): StatementSync {
    let statement = this.statements.get(sql)
    if (!statement) this.statements.set(sql, statement = this.db.prepare(sql))
    return statement
  }

  private unitByKey(harness: string, key: string): UnitRow | undefined {
    return this.prepared("SELECT * FROM units WHERE harness = ? AND key = ?").get(harness, key) as UnitRow | undefined
  }

  private head(unit: UnitRow): Head | null {
    if (unit.head < 0) return null
    const row = this.prepared("SELECT kind, size, digest, tail FROM versions WHERE unit = ? AND seq = ?").get(unit.id, unit.head)
    if (!row) return null
    return {
      unit: unit.id, seq: unit.head, kind: row["kind"] as VersionKind, size: Number(row["size"]),
      digest: row["digest"] ? Buffer.from(row["digest"] as Uint8Array) : null,
      tail: row["tail"] ? Buffer.from(row["tail"] as Uint8Array) : null,
    }
  }

  private sessionId(harness: string, nativeId: string, create: boolean): number | null {
    if (create) this.prepared("INSERT INTO sessions (harness, native_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(harness, nativeId)
    const row = this.prepared("SELECT id FROM sessions WHERE harness = ? AND native_id = ?").get(harness, nativeId)
    return row ? Number(row["id"]) : null
  }

  private unit(harness: string, key: string, role: UnitRole, session: number): UnitRow {
    this.prepared("INSERT INTO units (harness, key, role) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(harness, key, role)
    const unit = this.unitByKey(harness, key)!
    this.prepared("INSERT INTO session_units (session, unit) VALUES (?, ?) ON CONFLICT DO NOTHING").run(session, unit.id)
    return unit
  }

  // Capture

  private async captureNow({ harness, nativeId, home, records }: CaptureInput): Promise<CaptureReport> {
    const started = Date.now()
    const report: CaptureReport = { versions: [], unchanged: 0, newChunks: 0, newBytes: 0, storedBytes: 0, ms: 0 }
    this.db.exec("BEGIN IMMEDIATE")
    try {
      await this.packs.begin()
      const session = this.sessionId(harness, nativeId, true)!
      const seen = new Set<number>()
      for (const path of records.files) {
        const unit = await this.captureFile(harness, session, home, path, report)
        if (unit !== null) seen.add(unit)
      }
      await this.captureGoneFiles(harness, session, home, seen, report)
      for (const database of records.databases) await this.captureDatabase(harness, session, home, database, report)
      await this.packs.sync()
      report.ms = Date.now() - started
      this.prepared("INSERT INTO captures (session, at, versions, new_bytes, stored_bytes, ms) VALUES (?, ?, ?, ?, ?, ?)")
        .run(session, started, report.versions.length, report.newBytes, report.storedBytes, report.ms)
      this.db.exec("COMMIT")
      return report
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  private async captureFile(harness: string, session: number, home: string, path: string, report: CaptureReport): Promise<number | null> {
    const seenPath = homeRelative(home, path)
    const unit = this.unit(harness, fileUnitKey(harness, seenPath), "file", session)
    const info = await statRecord(path)
    if (!info) return null
    if (unit.seen_path === seenPath && unit.seen_identity === info.identity && unit.seen_mtime === info.mtimeMs && unit.seen_bytes === info.bytes && unit.head >= 0) {
      report.unchanged += 1
      return unit.id
    }
    const head = this.head(unit)
    const appendable = appendShaped(seenPath) && head && head.kind !== "delete" && head.tail && info.bytes >= head.size
    if (appendable && (await tailHash(path, head.size)).equals(head.tail!)) {
      if (info.bytes > head.size) {
        const { chunks } = await this.storeStream(recordChunks(path, head.size, info.bytes), report)
        this.addVersion(unit, "append", head.size, info.bytes, null, await tailHash(path, info.bytes), chunks, { path: seenPath })
        report.versions.push({ unit: unit.key, kind: "append", bytes: info.bytes - head.size })
      } else report.unchanged += 1
    } else {
      const { chunks, digest, tail } = await this.storeStream(recordChunks(path, 0, info.bytes), report)
      if (head && head.kind !== "delete" && head.digest?.equals(digest) && head.size === info.bytes) report.unchanged += 1
      else {
        this.addVersion(unit, "replace", 0, info.bytes, digest, tail, chunks, { path: seenPath })
        report.versions.push({ unit: unit.key, kind: "replace", bytes: info.bytes })
      }
    }
    this.prepared("UPDATE units SET seen_path = ?, seen_identity = ?, seen_mtime = ?, seen_bytes = ? WHERE id = ?")
      .run(seenPath, info.identity, info.mtimeMs, info.bytes, unit.id)
    return unit.id
  }

  /** A file of the session the harness no longer lists is deleted only once it's gone from every place the harness keeps it. */
  private async captureGoneFiles(harness: string, session: number, home: string, seen: Set<number>, report: CaptureReport): Promise<void> {
    const units = this.prepared(`SELECT u.* FROM session_units su JOIN units u ON u.id = su.unit WHERE su.session = ? AND u.role = 'file'`).all(session) as unknown as UnitRow[]
    for (const unit of units) {
      if (seen.has(unit.id) || unit.head < 0 || !unit.seen_path) continue
      const head = this.head(unit)
      if (!head || head.kind === "delete") continue
      const present = await Promise.all(placements(harness, unit.seen_path).map((place) => statRecord(underHome(home, place))))
      if (present.some(Boolean)) continue
      this.addVersion(unit, "delete", 0, 0, null, null, Buffer.alloc(0), { path: unit.seen_path })
      report.versions.push({ unit: unit.key, kind: "delete", bytes: 0 })
    }
  }

  private async captureDatabase(harness: string, session: number, home: string, database: RecordDatabase, report: CaptureReport): Promise<void> {
    if (!existsSync(database.path)) return
    const name = homeRelative(home, database.path)
    // A database neither written nor checkpointed since the last capture, asked for the same rows, holds nothing new.
    const fingerprint = await databaseFingerprint(database)
    if (this.prepared("SELECT fingerprint FROM database_marks WHERE session = ? AND name = ?").get(session, name)?.["fingerprint"] === fingerprint) {
      report.unchanged += 1
      return
    }
    const known = this.heads(session, harness, `${name}\trow\t`, `${name}\trow\n`)
    const { database: db } = openReadOnly(database.path, { timeout: 5_000 })
    try {
      // One read transaction, so the schema and every table come from the same commit.
      db.exec("BEGIN")
      const statements = db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all().map((row) => String(row["sql"]))
      const userVersion = Number(db.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0)
      const schema = Buffer.from(JSON.stringify({ statements, userVersion }))
      await this.captureValue(harness, session, `${name}\tschema`, "schema", schema, sha256(schema), report)
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row["name"])))
      for (const table of database.tables) {
        if (!tables.has(table.table)) continue
        const keys = keyColumns(db, table.table)
        const taken = new Set<string>()
        // A row of an immutable table is read whole only when its key is new.
        const whole = table.immutable ? rowStatement(db, table.table, keys) : null
        for (const listed of ownedRowsOf(db, table, keys, table.immutable ? keys : undefined)) {
          const key = rowUnitKey(name, table.table, keys, listed)
          taken.add(key)
          const have = known.get(key)
          if (table.immutable && have && have.kind !== "delete") {
            report.unchanged += 1
            continue
          }
          if (table.immutable && !have && (this.unitByKey(harness, key)?.head ?? -1) >= 0) {
            this.unit(harness, key, "row", session)
            report.unchanged += 1
            continue
          }
          const row = whole ? whole.get(...keys.map((column) => listed[column] ?? null) as SQLInputValue[]) as RecordRow | undefined : listed
          if (!row) continue
          const bytes = encodeRow({ ...row })
          const digest = sha256(bytes)
          if (have && have.kind !== "delete" && have.digest?.equals(digest)) {
            report.unchanged += 1
            continue
          }
          await this.captureValue(harness, session, key, "row", bytes, digest, report)
        }
        const prefix = `${name}\trow\t${table.table}\t`
        let still: StatementSync | null = null
        for (const [key, have] of known) {
          if (taken.has(key) || have.kind === "delete" || !key.startsWith(prefix)) continue
          const lookup = rowKeyOf(key)
          still ??= db.prepare(`SELECT 1 FROM ${quoted(table.table)} WHERE ${lookup.columns.map((column) => `${quoted(column)} IS ?`).join(" AND ")}`)
          if (still.get(...lookup.values as SQLInputValue[])) this.prepared("DELETE FROM session_units WHERE session = ? AND unit = ?").run(session, have.unit.id)
          else {
            this.addVersion(have.unit, "delete", 0, 0, null, null, Buffer.alloc(0), null)
            report.versions.push({ unit: key, kind: "delete", bytes: 0 })
          }
        }
      }
      db.exec("COMMIT")
    } finally {
      db.close()
    }
    this.prepared("INSERT INTO database_marks (session, name, fingerprint) VALUES (?, ?, ?) ON CONFLICT (session, name) DO UPDATE SET fingerprint = excluded.fingerprint")
      .run(session, name, fingerprint)
  }

  /** The newest version of each of a session's units with keys in [from, to), in one read. */
  private heads(session: number, harness: string, from: string, to: string): Map<string, { unit: UnitRow; kind: VersionKind; digest: Buffer | null; size: number }> {
    const heads = new Map<string, { unit: UnitRow; kind: VersionKind; digest: Buffer | null; size: number }>()
    for (const row of this.prepared(`
      SELECT u.*, v.kind, v.digest, v.size FROM session_units su JOIN units u ON u.id = su.unit JOIN versions v ON v.unit = u.id AND v.seq = u.head
      WHERE su.session = ? AND u.harness = ? AND u.key >= ? AND u.key < ?`).iterate(session, harness, from, to)) {
      const unit = row as unknown as UnitRow
      heads.set(unit.key, { unit, kind: row["kind"] as VersionKind, digest: row["digest"] ? Buffer.from(row["digest"] as Uint8Array) : null, size: Number(row["size"]) })
    }
    return heads
  }

  private async captureValue(harness: string, session: number, key: string, role: UnitRole, bytes: Buffer, digest: Buffer, report: CaptureReport): Promise<void> {
    const unit = this.unit(harness, key, role, session)
    const head = this.head(unit)
    if (head && head.kind !== "delete" && head.digest?.equals(digest)) {
      report.unchanged += 1
      return
    }
    const { chunks } = await this.storeStream([{ bytes, at: 0 }], report)
    this.addVersion(unit, "replace", 0, bytes.length, digest, null, chunks, null)
    report.versions.push({ unit: key, kind: "replace", bytes: bytes.length })
  }

  private addVersion(unit: UnitRow, kind: VersionKind, at: number, size: number, digest: Buffer | null, tail: Buffer | null, chunks: Buffer, detail: object | null): void {
    const seq = unit.head + 1
    this.prepared("INSERT INTO versions (unit, seq, kind, at, size, digest, tail, chunks, captured_at, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(unit.id, seq, kind, at, size, digest, tail, chunks, Date.now(), detail ? JSON.stringify(detail) : null)
    this.prepared("UPDATE units SET head = ? WHERE id = ?").run(seq, unit.id)
    unit.head = seq
  }

  /** Chunks a stream of bytes, storing each chunk not yet stored; the chunk list, the whole digest and the tail hash. */
  private async storeStream(source: AsyncIterable<{ bytes: Buffer }> | Iterable<{ bytes: Buffer; at?: number }>, report: CaptureReport): Promise<{ chunks: Buffer; digest: Buffer; tail: Buffer }> {
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
    const versions = this.prepared("SELECT seq, kind, chunks FROM versions WHERE unit = ? AND seq <= ? ORDER BY seq").all(unit, upTo)
    let from = 0
    versions.forEach((version, index) => {
      if (version["kind"] === "replace") from = index
    })
    for (const version of versions.slice(from)) {
      if (version["kind"] === "delete") continue
      const list = Buffer.from(version["chunks"] as Uint8Array)
      for (let at = 0; at < list.length; at += HASH_BYTES) {
        const hash = list.subarray(at, at + HASH_BYTES)
        const place = this.prepared("SELECT pack, offset, stored, size, codec FROM chunks WHERE hash = ?").get(hash)
        if (!place) throw new Error(`The chunk ${hash.toString("hex")} is missing from the record store`)
        yield await this.packs.read(placeOf(place))
      }
    }
  }

  /** The size a file unit has as of its last version holding content: a harness deleting a session's file is expiry, not an edit. */
  private contentSize(unit: number): number {
    const versions = this.prepared("SELECT kind, size FROM versions WHERE unit = ? ORDER BY seq").all(unit)
    let size = 0
    for (const version of versions) if (version["kind"] !== "delete") size = Number(version["size"])
    return size
  }

  private lastContentSeq(unit: number): number {
    const row = this.prepared("SELECT max(seq) AS seq FROM versions WHERE unit = ? AND kind != 'delete'").get(unit)
    return row?.["seq"] === null || row?.["seq"] === undefined ? -1 : Number(row["seq"])
  }

  // Restore

  private async restoreNow(input: RestoreInput): Promise<RestoreReport> {
    const { harness, nativeId, home } = input
    const session = this.sessionId(harness, nativeId, false)
    if (session === null) throw new Error(`Mako holds no records of ${harness} session ${nativeId}`)
    const units = this.prepared("SELECT u.* FROM session_units su JOIN units u ON u.id = su.unit WHERE su.session = ? ORDER BY u.role, u.key").all(session) as unknown as UnitRow[]
    const report: RestoreReport = { actions: [], diverged: [], written: false }
    const files = units.filter((unit) => unit.role === "file" && unit.seen_path && this.lastContentSeq(unit.id) >= 0)
    const plans = new Map<number, { action: RestoreActionKind; target: string; from: number; existing?: string }>()
    for (const unit of files) {
      const plan = await this.planFile(harness, home, unit, report)
      if (plan) plans.set(unit.id, plan)
    }
    const databases = new Map<string, UnitRow[]>()
    for (const unit of units) {
      if (unit.role === "file") continue
      const name = unit.key.slice(0, unit.key.indexOf("\t"))
      const members = databases.get(name)
      if (members) members.push(unit)
      else databases.set(name, [unit])
    }
    const rowPlans = new Map<string, { unit: UnitRow; action: RestoreActionKind }[]>()
    for (const [name, members] of databases) rowPlans.set(name, this.planDatabase(home, name, members, report))
    if (input.destination) this.checkDestination(harness, home, input.destination, new Set(units.map((unit) => unit.key)), report)
    if (report.diverged.length || input.dryRun) return report
    if (await input.held?.()) {
      report.diverged.push({ unit: nativeId, reason: "Something on this machine holds the session open" })
      return report
    }
    for (const unit of files) {
      const plan = plans.get(unit.id)
      if (plan) await this.applyFile(unit, plan)
    }
    for (const [name, plansOf] of rowPlans) await this.applyDatabase(home, name, plansOf)
    report.written = report.actions.some((action) => action.action !== "skip")
    return report
  }

  private async planFile(harness: string, home: string, unit: UnitRow, report: RestoreReport) {
    const size = this.contentSize(unit.id)
    const target = underHome(home, plainRecordPath(unit.seen_path!))
    const path = unit.seen_path!
    let existing: string | undefined
    let info: Awaited<ReturnType<typeof statRecord>> = null
    for (const place of placements(harness, path)) {
      info = await statRecord(underHome(home, place))
      if (info) {
        existing = underHome(home, place)
        break
      }
    }
    const record = (action: RestoreActionKind, bytes: number) => report.actions.push({ unit: unit.key, action, path: plainRecordPath(path), bytes })
    if (!existing || !info) {
      record("write", size)
      return { action: "write" as const, target, from: 0 }
    }
    if (info.bytes > size) {
      report.diverged.push({ unit: unit.key, reason: `The destination holds ${info.bytes} bytes; Mako's newest version has ${size}` })
      return null
    }
    if (!(await this.prefixMatches(unit.id, existing, info.bytes))) {
      report.diverged.push({ unit: unit.key, reason: `The destination's ${info.bytes} bytes differ from Mako's version` })
      return null
    }
    if (info.bytes === size) {
      record("skip", 0)
      return null
    }
    if (info.encoding === "plain") {
      record("append", size - info.bytes)
      return { action: "append" as const, target: existing, from: info.bytes }
    }
    record("write-plain", size)
    return { action: "write-plain" as const, target, from: 0, existing }
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

  private async applyFile(unit: UnitRow, plan: { action: RestoreActionKind; target: string; from: number; existing?: string }): Promise<void> {
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

  private planDatabase(home: string, name: string, members: UnitRow[], report: RestoreReport): { unit: UnitRow; action: RestoreActionKind }[] {
    const path = underHome(home, name)
    const db = existsSync(path) ? openReadOnly(path, { timeout: 5_000 }).database : null
    const plans: { unit: UnitRow; action: RestoreActionKind }[] = []
    const heads = new Map<number, { kind: VersionKind; digest: Buffer | null; size: number }>()
    for (const row of this.prepared(`SELECT v.unit, v.kind, v.digest, v.size FROM units u JOIN versions v ON v.unit = u.id AND v.seq = u.head WHERE u.harness = (SELECT harness FROM units WHERE id = ?) AND u.key >= ? AND u.key < ?`)
      .iterate(members[0]?.id ?? -1, `${name}\t`, `${name}\n`))
      heads.set(Number(row["unit"]), { kind: row["kind"] as VersionKind, digest: row["digest"] ? Buffer.from(row["digest"] as Uint8Array) : null, size: Number(row["size"]) })
    const lookups = new Map<string, StatementSync>()
    try {
      const tables = new Set(db ? db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row["name"])) : [])
      for (const unit of members) {
        const head = heads.get(unit.id)
        if (!head) continue
        if (unit.role === "schema") {
          plans.push({ unit, action: "write" })
          continue
        }
        const { table, columns, values } = rowKeyOf(unit.key)
        let present: RecordRow | undefined
        if (db && tables.has(table)) {
          const sql = `${table}\n${columns.join("\n")}`
          let lookup = lookups.get(sql)
          if (!lookup) {
            lookup = db.prepare(`SELECT ${columns[0] === "rowid" ? `"rowid", *` : "*"} FROM ${quoted(table)} WHERE ${columns.map((column) => `${quoted(column)} IS ?`).join(" AND ")}`)
            lookup.setReadBigInts(true)
            lookups.set(sql, lookup)
          }
          const found = lookup.get(...values as SQLInputValue[])
          present = found ? ({ ...found } as RecordRow) : undefined
        }
        const action = ((): RestoreActionKind | null => {
          if (!present) return head.kind === "delete" ? "skip" : "insert"
          const digest = sha256(encodeRow(present))
          if (head.kind !== "delete" && head.digest?.equals(digest)) return "skip"
          const known = this.prepared("SELECT 1 FROM versions WHERE unit = ? AND digest = ?").get(unit.id, digest)
          if (!known) return null
          return head.kind === "delete" ? "delete" : "replace"
        })()
        if (action === null) report.diverged.push({ unit: unit.key, reason: "The destination's row differs from every version Mako captured" })
        else {
          report.actions.push({ unit: unit.key, action, path: name, bytes: head.size })
          if (action !== "skip") plans.push({ unit, action })
        }
      }
    } finally {
      db?.close()
    }
    return plans
  }

  private async applyDatabase(home: string, name: string, plans: { unit: UnitRow; action: RestoreActionKind }[]): Promise<void> {
    if (!plans.some((plan) => plan.unit.role === "row")) return
    const target = underHome(home, name)
    await mkdir(dirname(target), { recursive: true })
    const db = this.stores.openForWriting(target)
    // The harness may be running and writing the same database; its write lock is waited for, then held for the whole restore.
    db.exec(`PRAGMA busy_timeout = ${WRITE_BUSY_TIMEOUT_MS}`)
    // Rows arrive table by table, children before parents, and replacing a parent row must not cascade into rows already restored.
    db.exec("PRAGMA foreign_keys = OFF")
    db.exec("BEGIN IMMEDIATE")
    try {
      for (const { unit } of plans.filter((plan) => plan.unit.role === "schema")) {
        const { statements, userVersion } = JSON.parse((await collect(this.unitContent(unit.id, unit.head))).toString("utf8")) as { statements: string[]; userVersion: number }
        for (const statement of statements) {
          // A virtual table creates its shadow tables itself, and a home that already holds the store keeps its schema.
          if (!db.prepare("SELECT 1 FROM sqlite_master WHERE sql = ?").get(statement)) db.exec(statement)
        }
        const current = Number(db.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0)
        if (current === 0 && userVersion !== 0) db.exec(`PRAGMA user_version = ${Math.trunc(userVersion)}`)
      }
      for (const { unit, action } of plans) {
        if (unit.role !== "row") continue
        const { table, columns, values } = rowKeyOf(unit.key)
        if (action === "delete") {
          db.prepare(`DELETE FROM ${quoted(table)} WHERE ${columns.map((column) => `${quoted(column)} IS ?`).join(" AND ")}`).run(...values as SQLInputValue[])
          continue
        }
        const row = decodeRow(await collect(this.unitContent(unit.id, unit.head)))
        const names = Object.keys(row)
        db.prepare(`INSERT OR REPLACE INTO ${quoted(table)} (${names.map(quoted).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
          .run(...names.map((column) => row[column] ?? null) as SQLInputValue[])
      }
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    } finally {
      db.close()
    }
  }

  /** A file or owned row at the destination that Mako never captured means the session went on there. */
  private checkDestination(harness: string, home: string, destination: SessionRecords, known: Set<string>, report: RestoreReport): void {
    for (const path of destination.files) {
      const key = fileUnitKey(harness, homeRelative(home, path))
      if (!known.has(key)) report.diverged.push({ unit: key, reason: "The destination holds a file of the session Mako never captured" })
    }
    for (const database of destination.databases) {
      if (!existsSync(database.path)) continue
      const name = homeRelative(home, database.path)
      const { database: db } = openReadOnly(database.path, { timeout: 5_000 })
      try {
        const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row["name"])))
        for (const table of database.tables) {
          if (!tables.has(table.table)) continue
          const keys = keyColumns(db, table.table)
          for (const row of ownedRowsOf(db, table, keys)) {
            const key = rowUnitKey(name, table.table, keys, row)
            if (!known.has(key)) report.diverged.push({ unit: key, reason: "The destination holds a row of the session Mako never captured" })
          }
        }
      } finally {
        db.close()
      }
    }
  }
}

// Keys

/** A file's unit key: home-relative and plain; a Codex rollout by name alone, wherever Codex filed it. */
export function fileUnitKey(harness: string, homeRelativePath: string): string {
  const plain = plainRecordPath(homeRelativePath)
  if (harness === "codex") {
    const rollout = CODEX_ROLLOUT.exec(plain)
    if (rollout) return `${rollout[1]}rollouts/${rollout[2]}`
  }
  return plain
}

const CODEX_ROLLOUT = /^(.*?)(?:sessions\/\d{4}\/\d{2}\/\d{2}|archived_sessions)\/(rollout-[^/]+\.jsonl)$/

/** Where a file unit last seen at `seenPath` may be now, in every encoding, the place it was seen first. */
function placements(harness: string, seenPath: string): string[] {
  const plain = plainRecordPath(seenPath)
  const places = [plain]
  if (harness === "codex") {
    const rollout = CODEX_ROLLOUT.exec(plain)
    const dated = rollout && /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(rollout[2]!)
    if (rollout && dated) {
      places.push(`${rollout[1]}sessions/${dated[1]}/${dated[2]}/${dated[3]}/${rollout[2]}`, `${rollout[1]}archived_sessions/${rollout[2]}`)
    }
  }
  return [...new Set(places)].flatMap((place) => [place, `${place}.zst`])
}

function rowUnitKey(database: string, table: string, keys: readonly string[], row: RecordRow): string {
  return `${database}\trow\t${table}\t${JSON.stringify(Object.fromEntries(keys.map((column) => [column, tagged(row[column] ?? null)])))}`
}

function rowKeyOf(key: string): { table: string; columns: string[]; values: RecordValue[] } {
  const [, , table, encoded] = key.split("\t")
  const object = JSON.parse(encoded!) as Record<string, Tagged>
  return { table: table!, columns: Object.keys(object), values: Object.values(object).map(untagged) }
}

type Tagged = null | string | { int: string } | { real: number | "Infinity" | "-Infinity" | "NaN" } | { bytes: string }

function tagged(value: RecordValue): Tagged {
  if (value === null || typeof value === "string") return value
  if (typeof value === "bigint") return { int: value.toString() }
  if (typeof value === "number") return { real: Number.isFinite(value) ? value : (String(value) as "Infinity" | "-Infinity" | "NaN") }
  return { bytes: Buffer.from(value).toString("base64") }
}

function untagged(value: Tagged): RecordValue {
  if (value === null || typeof value === "string") return value
  if ("int" in value) return BigInt(value.int)
  if ("real" in value) return Number(value.real)
  return new Uint8Array(Buffer.from(value.bytes, "base64"))
}

// Rows

const NULL = 0, INT = 1, REAL = 2, TEXT = 3, BLOB = 4

/** A row as bytes: columns by name, each value tagged with its SQLite type, so it reads back as the same type. */
export function encodeRow(row: RecordRow): Buffer {
  const parts: Buffer[] = []
  const names = Object.keys(row).sort()
  const count = Buffer.alloc(4)
  count.writeUInt32LE(names.length)
  parts.push(count)
  for (const name of names) {
    const value = row[name] ?? null
    const label = Buffer.from(name, "utf8")
    const head = Buffer.alloc(3)
    head.writeUInt16LE(label.length)
    parts.push(head, label)
    if (value === null) head.writeUInt8(NULL, 2)
    else if (typeof value === "bigint") {
      head.writeUInt8(INT, 2)
      const body = Buffer.alloc(8)
      body.writeBigInt64LE(value)
      parts.push(body)
    } else if (typeof value === "number") {
      head.writeUInt8(REAL, 2)
      const body = Buffer.alloc(8)
      body.writeDoubleLE(value)
      parts.push(body)
    } else {
      const text = typeof value === "string"
      head.writeUInt8(text ? TEXT : BLOB, 2)
      const body = text ? Buffer.from(value, "utf8") : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      const length = Buffer.alloc(4)
      length.writeUInt32LE(body.length)
      parts.push(length, body)
    }
  }
  return Buffer.concat(parts)
}

export function decodeRow(bytes: Buffer): RecordRow {
  const row: RecordRow = {}
  let at = 0
  const count = bytes.readUInt32LE(at)
  at += 4
  for (let index = 0; index < count; index++) {
    const length = bytes.readUInt16LE(at)
    const tag = bytes.readUInt8(at + 2)
    at += 3
    const name = bytes.toString("utf8", at, at + length)
    at += length
    if (tag === NULL) row[name] = null
    else if (tag === INT) {
      row[name] = bytes.readBigInt64LE(at)
      at += 8
    } else if (tag === REAL) {
      row[name] = bytes.readDoubleLE(at)
      at += 8
    } else {
      const size = bytes.readUInt32LE(at)
      at += 4
      const body = bytes.subarray(at, at + size)
      row[name] = tag === TEXT ? body.toString("utf8") : new Uint8Array(body)
      at += size
    }
  }
  return row
}

/** The session's rows of `table` in key order: whole, or only the `columns` named. */
function* ownedRowsOf(db: DatabaseSync, { table, where, params = [] }: RecordTable, keys: readonly string[], columns?: readonly string[]): Generator<RecordRow> {
  const all = columns ? columns.map(quoted).join(", ") : keys[0] === "rowid" ? `"rowid", *` : "*"
  const statement = db.prepare(`SELECT ${all} FROM ${quoted(table)}${where ? ` WHERE ${where}` : ""} ORDER BY ${keys.map(quoted).join(", ")}`)
  // An INTEGER read as a JS number would come back as a REAL.
  statement.setReadBigInts(true)
  for (const row of statement.iterate(...params)) yield { ...row } as RecordRow
}

/** A statement reading one whole row of `table` by its key. */
function rowStatement(db: DatabaseSync, table: string, keys: readonly string[]): StatementSync {
  const statement = db.prepare(`SELECT ${keys[0] === "rowid" ? `"rowid", *` : "*"} FROM ${quoted(table)} WHERE ${keys.map((column) => `${quoted(column)} IS ?`).join(" AND ")}`)
  statement.setReadBigInts(true)
  return statement
}

/** A table's primary key columns in key order, or SQLite's own `rowid` when it declares none. */
function keyColumns(db: DatabaseSync, table: string): string[] {
  const columns = db.prepare(`SELECT name, pk FROM pragma_table_info(?)`).all(table)
    .map((row) => ({ name: String(row["name"]), pk: Number(row["pk"]) }))
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
  return columns.length ? columns.map((column) => column.name) : ["rowid"]
}

async function databaseFingerprint(database: RecordDatabase): Promise<string> {
  const files = await Promise.all(["", "-wal"].map(async (suffix) => {
    const info = await stat(`${database.path}${suffix}`).catch(() => null)
    return info ? [info.ino, info.size, info.mtimeMs] : null
  }))
  return sha256(Buffer.from(JSON.stringify([files, database.tables], (_key, value) => (typeof value === "bigint" ? `${value}n` : value)))).toString("hex")
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest()

// Files

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const part of source) parts.push(part)
  return Buffer.concat(parts)
}

const appendShaped = (path: string) => /\.(?:jsonl|ndjson)$/.test(plainRecordPath(path))

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

function homeRelative(home: string, path: string): string {
  const relativePath = relative(home, path)
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error(`${path} lies outside the home ${home}`)
  return relativePath.split(sep).join("/")
}

/** A home-relative path under `home`; anything naming somewhere else is refused. */
function underHome(home: string, file: string): string {
  const parts = file.split("/")
  if (!file || isAbsolute(file) || parts.some((part) => part === ".." || part === "." || part === "")) throw new Error(`${file} isn't a path inside the home`)
  return join(home, ...parts)
}

const quoted = (name: string) => `"${name.replaceAll(`"`, `""`)}"`

function placeOf(row: Record<string, unknown>): ChunkPlace {
  return { pack: Number(row["pack"]), offset: Number(row["offset"]), stored: Number(row["stored"]), size: Number(row["size"]), codec: Number(row["codec"]) as ChunkCodec }
}

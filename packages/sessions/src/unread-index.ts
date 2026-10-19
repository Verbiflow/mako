import { existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync, type StatementSync } from "node:sqlite"
import { z } from "zod"
import { RecordRefSchema, type EntryOf, type RecordRef } from "./entries.js"
import type { ThreadRef } from "./format.js"
import { openReadOnly } from "./read-only-sqlite.js"
import { RecordWriterLookup } from "./record-store.js"
import type { RecordWriter, WriterEvidence, WriterSource } from "./record-writers.js"
import { compareVersions } from "./runtime-version.js"
import { declareStoreFormat, inspectStoreFormat, readStoreFormat, storeAccess, writeStoreFormat, type StoreStanding } from "./store-format.js"

/**
 * Every record a saved reader couldn't read, by session, as the views were
 * decoded: an `unread` entry's kind, why, its id and the record it names,
 * never its content. Kept beside the views (`~/.mako/views/unread.sqlite`),
 * one row per entry, replaced whenever a view of the session is written,
 * and like the views a cache: deleting it is safe, and decoding again
 * fills it. A view kept in memory (a small session) notes its entries here
 * too, so the counts cover every session decoded, not only the large ones.
 *
 * `unreadCounts` adds them up by harness, the harness version that wrote
 * each record (from the record store, `RecordWriterLookup`), kind and
 * reason: what diagnostics show when a harness ships a release, and what a
 * decoder change should bring to zero.
 */

export const UNREAD_INDEX_FILE = "unread.sqlite"
/**
 * Its format: `schema` to write it, `reads` the oldest format that can
 * still read it, as the record store keeps them (`record-store.ts`). An
 * older build that can't write it reads it; one that can't read it either
 * leaves it and keeps none.
 */
const SCHEMA = 1

/** A declared kind the history doesn't draw yet is the harness table's own gap, not a record a new version wrote. */
const COUNTED = new Set(["unknown", "unreadable"])

export class UnreadIndex {
  private readonly db: DatabaseSync | null
  private readonly statements = new Map<string, StatementSync>()
  private formatVersion = -1
  /** Another build raised the index's format since it opened: this build notes nothing more in it. */
  private raised = false

  /** `file` null keeps the index in memory, for a catalog that writes nothing. `writer` stamps a format this build sets (`storeWriter`). */
  constructor(readonly file: string | null, options: { writer?: string } = {}) {
    this.db = open(file, options.writer)
  }

  /** Whether a newer Mako raised the index's format since it opened, read again after another build's commit. */
  private newer(db: DatabaseSync): boolean {
    if (this.raised || !this.file) return this.raised
    const version = DataVersionSchema.parse(this.prepared("PRAGMA data_version").get()).data_version
    if (version === this.formatVersion) return false
    this.formatVersion = version
    if (storeAccess(readStoreFormat(db, "meta"), SCHEMA) === "write") return false
    console.warn("Unread records not counted here: a newer Mako changed the index's format, so this build keeps no counts until it's updated")
    return (this.raised = true)
  }

  /** Replaces what is known of `ref`'s unread records with `entries`, those its view now holds. */
  note(ref: Pick<ThreadRef, "path" | "harness" | "nativeId">, translator: string, entries: Iterable<EntryOf<"unread">>): void {
    const db = this.db
    if (!db) return
    db.exec("BEGIN IMMEDIATE")
    if (this.newer(db)) {
      db.exec("ROLLBACK")
      return
    }
    try {
      this.prepared("DELETE FROM unread WHERE path = ?").run(ref.path)
      const insert = this.prepared("INSERT OR REPLACE INTO unread (path, harness, native_id, translator, id, kind, reason, record, at, noted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      const noted = Date.now()
      let index = 0
      for (const entry of entries) {
        index += 1
        if (!COUNTED.has(entry.reason)) continue
        insert.run(ref.path, ref.harness, ref.nativeId, translator, entry.id ?? `#${index}`, entry.kind, entry.reason, entry.record ? JSON.stringify(entry.record) : null, entry.at ?? null, noted)
      }
      db.exec("COMMIT")
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK")
      throw error
    }
  }

  /** The sessions whose unread records a build other than `build` noted, the most recently noted first. */
  stalePaths(build: string): string[] {
    if (!this.db) return []
    return z.object({ path: z.string() }).array().parse(this.prepared("SELECT path, max(noted) AS noted FROM unread WHERE translator != ? GROUP BY path ORDER BY noted DESC").all(build)).map((row) => row.path)
  }

  forget(path: string): void {
    if (this.db && !this.newer(this.db)) this.prepared("DELETE FROM unread WHERE path = ?").run(path)
  }

  /** Every row, for a catalog that keeps its index in memory. */
  rows(): UnreadRow[] {
    return this.db ? readRows(this.db) : []
  }

  close(): void {
    this.statements.clear()
    if (this.db?.isOpen) this.db.close()
  }

  private prepared(sql: string): StatementSync {
    let statement = this.statements.get(sql)
    if (!statement) this.statements.set(sql, (statement = this.db!.prepare(sql)))
    return statement
  }
}

/** The index at `file`, made if need be; null for one in a newer format this build can't write. */
const DataVersionSchema = z.object({ data_version: z.number() })

function open(file: string | null, writer: string | undefined): DatabaseSync | null {
  if (file) mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file ?? ":memory:", { timeout: 5_000 })
  try {
    if (file) db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL")
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID")
    const format = readStoreFormat(db, "meta")
    if (storeAccess(format, SCHEMA) !== "write") {
      // A newer Mako's: it keeps its counts, which diagnostics still read; this build keeps none rather than write what it doesn't know.
      db.close()
      return null
    }
    declareStoreFormat(db, SCHEMA)
    db.exec(`CREATE TABLE IF NOT EXISTS unread (
      path TEXT NOT NULL, harness TEXT NOT NULL, native_id TEXT NOT NULL, translator TEXT NOT NULL,
      id TEXT NOT NULL, kind TEXT NOT NULL, reason TEXT NOT NULL, record TEXT, at INTEGER, noted INTEGER NOT NULL,
      PRIMARY KEY (path, id)
    ) WITHOUT ROWID`)
    if (format === undefined) writeStoreFormat(db, "meta", { writableBy: SCHEMA, readableBy: SCHEMA }, writer)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

const RowSchema = z.object({
  path: z.string(), harness: z.string(), nativeId: z.string(), translator: z.string(), id: z.string(), kind: z.string(), reason: z.string(),
  record: z.string().nullable(), at: z.number().nullable(),
})

export interface UnreadRow {
  path: string
  harness: string
  nativeId: string
  translator: string
  id: string
  kind: string
  reason: string
  record: RecordRef | null
  at: number | null
}

function readRows(db: DatabaseSync): UnreadRow[] {
  return RowSchema.array().parse(db.prepare("SELECT path, harness, native_id AS nativeId, translator, id, kind, reason, record, at FROM unread").all()).map((row) => ({
    ...row,
    record: row.record ? RecordRefSchema.parse(JSON.parse(row.record)) : null,
  }))
}

/** Unread records of one harness version, kind and reason, counted without their content. */
export interface UnreadGroup {
  harness: string
  /** The harness version that wrote them, as the record store knows it; null where it doesn't. */
  version: string | null
  /** Where no version is known but the harness's evidence bounds it: the newest that could have written them, and what sets that bound. */
  upTo?: string
  bound?: WriterEvidence["bound"]
  source: WriterSource | null
  kind: string
  reason: string
  count: number
  sessions: number
  /** The newest of them: its session, its entry's id and record (which `SessionCatalog.original` opens) and when it was written. */
  newest: { path: string; id: string; at: number | null; record?: RecordRef }
}

export interface UnreadCounts {
  groups: UnreadGroup[]
  /** Sessions with any unread record, and how many records in all. */
  sessions: number
  records: number
  /** Records whose version the record store couldn't name: the session isn't held yet, or its records state none. */
  unattributed: number
}

/**
 * The unread records the index at `views` holds, counted by harness,
 * version, kind and reason, newest version first. Each record's version is
 * the one that wrote the bytes it names, read from the record store at
 * `records` (`RecordWriterLookup`); none when the store doesn't hold the
 * session or nothing stated or observed one. Reads only.
 */
export function unreadCounts(options: { views?: string | null; rows?: readonly UnreadRow[]; records?: string | null; harness?: string }): UnreadCounts {
  const rows = options.rows ?? readIndex(options.views ?? null)
  const lookup = options.records && existsSync(join(options.records, "records.sqlite")) ? new RecordWriterLookup(options.records) : null
  try {
    const groups = new Map<string, UnreadGroup & { paths: Set<string> }>()
    const sessions = new Set<string>()
    let unattributed = 0
    for (const row of rows) {
      if (options.harness && row.harness !== options.harness) continue
      const writer: RecordWriter | null = lookup?.writerOf(row.harness, row.nativeId, row.path, row.record) ?? null
      const upTo = writer ? null : lookup?.upToOf(row.harness, row.nativeId) ?? null
      const bound = upTo ? lookup?.boundOf(row.harness, row.nativeId) ?? null : null
      if (!writer) unattributed += 1
      sessions.add(row.path)
      const key = `${row.harness}\0${writer?.version ?? ""}\0${upTo ?? ""}\0${bound ?? ""}\0${row.kind}\0${row.reason}`
      const newest = { path: row.path, id: row.id, at: row.at, ...row.record && { record: row.record } }
      const group = groups.get(key) ?? { harness: row.harness, version: writer?.version ?? null, ...upTo && { upTo }, ...bound && { bound }, source: writer?.source ?? null, kind: row.kind, reason: row.reason, count: 0, sessions: 0, paths: new Set<string>(), newest }
      group.count += 1
      group.paths.add(row.path)
      if ((row.at ?? 0) >= (group.newest.at ?? 0)) group.newest = newest
      groups.set(key, group)
    }
    const ordered = [...groups.values()].map(({ paths, ...group }) => ({ ...group, sessions: paths.size }))
      .sort((a, b) => a.harness.localeCompare(b.harness) || compareNullable(b.version, a.version) || b.count - a.count || a.kind.localeCompare(b.kind))
    return { groups: ordered, sessions: sessions.size, records: rows.length, unattributed }
  } finally {
    lookup?.close()
  }
}

function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  return compareVersions(a, b)
}

/** Where the index at `file` stands for this build, read without writing: for Settings › Diagnostics. */
export function unreadIndexStanding(file: string): StoreStanding {
  const format = inspectStoreFormat(file, "meta")
  return format ? { access: storeAccess(format, SCHEMA), build: SCHEMA, format } : { access: "write", build: SCHEMA }
}

function readIndex(views: string | null): UnreadRow[] {
  if (!views) return []
  const file = join(views, UNREAD_INDEX_FILE)
  if (!existsSync(file)) return []
  const { database } = openReadOnly(file, { timeout: 5_000 })
  try {
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'unread'").get()) return []
    // A format newer than this build reads is a newer Mako's to count.
    const hasMeta = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()
    if (hasMeta && storeAccess(readStoreFormat(database, "meta"), SCHEMA) === "refused") return []
    return readRows(database)
  } finally {
    database.close()
  }
}

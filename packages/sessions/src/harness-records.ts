import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { appendFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite"
import { z } from "zod"
import { openNativeStoreForWriting, openReadOnly } from "./read-only-sqlite.js"

/**
 * A session's own records, as its harness wrote them. A capture takes them
 * from the store in segments, and each later capture takes only what changed
 * since its cursor. A restore writes them under another home byte for byte
 * and row for row, so a newer reader, or the harness itself on another
 * machine, reads what the first one did.
 *
 * Each reader names where its harness keeps one session
 * (`SessionProvider.records`), and the shape of each part follows from that:
 * - A `.jsonl` or `.ndjson` transcript grows at its end. A capture takes the
 *   bytes past the cursor, or the whole file when the bytes before the cursor
 *   changed (the harness rewrote it).
 * - Any other file beside it (Grok's `summary.json`) is taken again whole
 *   when its content changes.
 * - Database rows the session owns are keyed by primary key. A capture takes
 *   the rows whose content changed and the keys that went away, with the
 *   database's schema so a fresh home can hold them. A table whose rows never
 *   change under their key (Cursor's content-addressed blobs) is read in full
 *   only for keys the cursor hasn't seen.
 */

export interface RecordTable {
  table: string
  /** The session's rows, as an SQL condition over `params`; unset takes every row. */
  where?: string
  params?: SQLInputValue[]
  /** A row is never rewritten under its key. */
  immutable?: true
}

export interface RecordDatabase {
  path: string
  /** The tables holding the session's rows; the schema of every table is captured regardless. */
  tables: RecordTable[]
}

/** Where a harness keeps one session: absolute paths under the home its reader reads. */
export interface SessionRecords {
  files: string[]
  databases: RecordDatabase[]
}

export type RecordValue = null | number | bigint | string | Uint8Array
/** A row by column name. */
export type RecordRow = Record<string, RecordValue>

/** Paths are relative to the home, `/`-separated. */
export type RecordSegment =
  | { kind: "file"; file: string; bytes: Uint8Array }
  | { kind: "append"; file: string; at: number; bytes: Uint8Array }
  | { kind: "gone"; file: string }
  | { kind: "schema"; database: string; statements: string[]; userVersion: number }
  | { kind: "row"; database: string; table: string; values: RecordRow }
  | { kind: "deleted"; database: string; table: string; key: RecordRow }

/** What a capture has taken: where each file ended, each schema, each row's content by key. */
export interface RecordsCursor {
  /** A transcript's size and the hash of the bytes just before it; another file's size and whole hash. */
  files: Record<string, { size: number; hash: string }>
  schemas: Record<string, string>
  /** `<database>\n<table>` → the marks of its rows. */
  rows: Record<string, RowMarks>
}

/** Encoded key → row hash ("" for an immutable table). */
export type RowMarks = Record<string, string>

/** How far back from a transcript's cursor a capture checks that nothing before it was rewritten. */
const TAIL_BYTES = 64 * 1024

const appends = (file: string) => /\.(?:jsonl|ndjson)$/.test(file)

export async function captureRecords(
  records: SessionRecords,
  home: string,
  since?: RecordsCursor
): Promise<{ segments: RecordSegment[]; cursor: RecordsCursor }> {
  const segments: RecordSegment[] = []
  const cursor: RecordsCursor = { files: {}, schemas: {}, rows: {} }
  const listed = new Set<string>()
  for (const path of records.files) {
    const file = homeRelative(home, path)
    listed.add(file)
    const mark = await captureFile(path, file, since?.files[file], segments)
    if (mark) cursor.files[file] = mark
    else if (since?.files[file]) segments.push({ kind: "gone", file })
  }
  for (const file of Object.keys(since?.files ?? {}))
    if (!listed.has(file)) segments.push({ kind: "gone", file })
  for (const database of records.databases) captureDatabase(database, homeRelative(home, database.path), since, segments, cursor)
  return { segments, cursor }
}

async function captureFile(
  path: string,
  file: string,
  previous: RecordsCursor["files"][string] | undefined,
  segments: RecordSegment[]
): Promise<RecordsCursor["files"][string] | undefined> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return undefined
  if (appends(file) && previous && info.size >= previous.size && (await tailHash(path, previous.size)) === previous.hash) {
    if (info.size > previous.size) segments.push({ kind: "append", file, at: previous.size, bytes: await readRange(path, previous.size, info.size) })
    return { size: info.size, hash: await tailHash(path, info.size) }
  }
  const bytes = await readFile(path)
  const hash = appends(file) ? windowHash(bytes, bytes.length) : digest(bytes)
  if (previous?.hash !== hash || previous.size !== bytes.length) segments.push({ kind: "file", file, bytes })
  return { size: bytes.length, hash }
}

function captureDatabase(
  database: RecordDatabase,
  name: string,
  since: RecordsCursor | undefined,
  segments: RecordSegment[],
  cursor: RecordsCursor
): void {
  if (!existsSync(database.path)) return
  const { database: db } = openReadOnly(database.path, { timeout: 5_000 })
  try {
    // One read transaction, so the schema and every table come from the same commit.
    db.exec("BEGIN")
    const statements = db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all()
      .map((row) => String(row["sql"]))
    const userVersion = Number(db.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0)
    const schema = digest(JSON.stringify([statements, userVersion]))
    cursor.schemas[name] = schema
    if (since?.schemas[name] !== schema) segments.push({ kind: "schema", database: name, statements, userVersion })
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row["name"])))
    for (const table of database.tables) {
      if (!tables.has(table.table)) continue
      const at = `${name}\n${table.table}`
      const marks: RowMarks = {}
      cursor.rows[at] = marks
      captureTable(db, name, table, since?.rows[at] ?? {}, marks, segments)
    }
    db.exec("COMMIT")
  } finally {
    db.close()
  }
}

function captureTable(
  db: DatabaseSync,
  database: string,
  { table, where, params = [], immutable }: RecordTable,
  previous: RowMarks,
  marks: RowMarks,
  segments: RecordSegment[]
): void {
  const keys = keyColumns(db, table)
  const condition = where ? ` WHERE ${where}` : ""
  const order = ` ORDER BY ${keys.map(quoted).join(", ")}`
  const all = keys[0] === "rowid" ? `"rowid", *` : "*"
  const keyOf = (row: RecordRow) => JSON.stringify(keys.map((column) => encodeValue(row[column] ?? null)))
  if (immutable) {
    const listing = reading(db.prepare(`SELECT ${keys.map(quoted).join(", ")} FROM ${quoted(table)}${condition}${order}`))
    const one = reading(db.prepare(`SELECT ${all} FROM ${quoted(table)} WHERE ${keys.map((column) => `${quoted(column)} IS ?`).join(" AND ")}`))
    for (const row of listing.iterate(...params)) {
      const key = keyOf(row)
      marks[key] = ""
      if (key in previous) continue
      const values = one.get(...keys.map((column) => row[column] ?? null))
      if (values) segments.push({ kind: "row", database, table, values: { ...values } })
    }
  } else {
    for (const row of reading(db.prepare(`SELECT ${all} FROM ${quoted(table)}${condition}${order}`)).iterate(...params)) {
      const values = { ...row }
      const key = keyOf(values)
      const hash = digest(JSON.stringify(encodeValues(values))).slice(0, 32)
      marks[key] = hash
      if (previous[key] !== hash) segments.push({ kind: "row", database, table, values })
    }
  }
  for (const key of Object.keys(previous)) {
    if (key in marks) continue
    const parts = z.array(DecodedValue).parse(JSON.parse(key))
    segments.push({ kind: "deleted", database, table, key: Object.fromEntries(keys.map((column, index) => [column, parts[index] ?? null])) })
  }
}

/** A table's primary key columns in key order, or SQLite's own `rowid` when it declares none. */
function keyColumns(db: DatabaseSync, table: string): string[] {
  const columns = db.prepare(`SELECT name, pk FROM pragma_table_info(?)`).all(table)
    .map((row) => ({ name: String(row["name"]), pk: Number(row["pk"]) }))
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
  return columns.length ? columns.map((column) => column.name) : ["rowid"]
}

function reading(statement: StatementSync): StatementSync {
  // An INTEGER read as a JS number would come back as a REAL.
  statement.setReadBigInts(true)
  return statement
}

/**
 * Write `segments` under `home`, in order. A transcript's appended bytes must
 * land where the capture took them from; anything else is refused before
 * a byte is written past it.
 */
export async function restoreRecords(segments: Iterable<RecordSegment>, home: string): Promise<void> {
  const databases = new Map<string, Restoring>()
  try {
    for (const segment of segments) {
      switch (segment.kind) {
        case "file": {
          const target = underHome(home, segment.file)
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, segment.bytes)
          break
        }
        case "append": {
          const target = underHome(home, segment.file)
          const size = (await stat(target).catch(() => null))?.size ?? 0
          if (size !== segment.at) throw new Error(`${segment.file} holds ${size} bytes, but the segment continues it at ${segment.at}`)
          await appendFile(target, segment.bytes)
          break
        }
        case "gone":
          await rm(underHome(home, segment.file), { force: true })
          break
        case "schema":
          (await restoring(databases, home, segment.database)).schema(segment.statements, segment.userVersion)
          break
        case "row":
          (await restoring(databases, home, segment.database)).row(segment.table, segment.values)
          break
        case "deleted":
          (await restoring(databases, home, segment.database)).delete(segment.table, segment.key)
          break
      }
    }
    for (const database of databases.values()) database.commit()
  } finally {
    for (const database of databases.values()) database.close()
  }
}

interface Restoring {
  schema(statements: readonly string[], userVersion: number): void
  row(table: string, values: RecordRow): void
  delete(table: string, key: RecordRow): void
  commit(): void
  close(): void
}

async function restoring(databases: Map<string, Restoring>, home: string, database: string): Promise<Restoring> {
  const existing = databases.get(database)
  if (existing) return existing
  const target = underHome(home, database)
  await mkdir(dirname(target), { recursive: true })
  const db = openNativeStoreForWriting(target)
  // Rows arrive table by table, children before parents, and replacing a parent row must not cascade into the children already restored.
  db.exec("PRAGMA foreign_keys = OFF")
  db.exec("BEGIN")
  let open = true
  const statements = new Map<string, StatementSync>()
  const prepared = (sql: string) => {
    let statement = statements.get(sql)
    if (!statement) statements.set(sql, statement = db.prepare(sql))
    return statement
  }
  const restored: Restoring = {
    schema(sql, userVersion) {
      for (const statement of sql) {
        // A virtual table creates its shadow tables itself, and a home that already holds the store keeps its schema.
        const present = db.prepare("SELECT 1 FROM sqlite_master WHERE sql = ?").get(statement)
        if (!present) db.exec(statement)
      }
      const current = Number(db.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0)
      if (current === 0 && userVersion !== 0) db.exec(`PRAGMA user_version = ${Math.trunc(userVersion)}`)
    },
    row(table, values) {
      const columns = Object.keys(values)
      prepared(`INSERT OR REPLACE INTO ${quoted(table)} (${columns.map(quoted).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
        .run(...columns.map((column) => values[column] ?? null))
    },
    delete(table, key) {
      const columns = Object.keys(key)
      prepared(`DELETE FROM ${quoted(table)} WHERE ${columns.map((column) => `${quoted(column)} IS ?`).join(" AND ")}`)
        .run(...columns.map((column) => key[column] ?? null))
    },
    commit() {
      db.exec("COMMIT")
      open = false
    },
    close() {
      if (open) db.exec("ROLLBACK")
      db.close()
    },
  }
  databases.set(database, restored)
  return restored
}

/** Every file under `folder`, in a stable order; none when it doesn't exist. */
export async function filesUnder(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true, recursive: true }).catch(() => [])
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort()
}

/**
 * The rows of a shared database a session owns, under any of `ids` (the
 * session and the sessions it spawned). Each table in `keyed` holds them
 * under that column, as does every other table with an `owner` column, so a
 * table a later build adds is taken too. `shared`
 * tables are taken whole: the migration bookkeeping a harness checks before
 * it opens the store. `extra` tables name their own rows. Null when the
 * database doesn't exist.
 */
export function ownedRows(
  path: string,
  ids: readonly string[],
  rule: { owner: string; keyed?: Readonly<Record<string, string>>; shared?: readonly string[]; extra?: readonly RecordTable[] }
): RecordDatabase | null {
  const tables = tableColumns(path)
  if (!tables.size) return null
  const owned: RecordTable[] = []
  for (const [table, columns] of tables) {
    const extra = rule.extra?.find((candidate) => candidate.table === table)
    const column = rule.keyed?.[table] ?? (columns.includes(rule.owner) ? rule.owner : undefined)
    if (extra) owned.push(extra)
    else if (rule.shared?.includes(table)) owned.push({ table })
    else if (column) owned.push({ table, where: `${quoted(column)} IN (${placeholders(ids)})`, params: [...ids] })
  }
  return { path, tables: owned }
}

/** Each table of a database with its column names. */
export function tableColumns(path: string): Map<string, string[]> {
  const tables = new Map<string, string[]>()
  if (!existsSync(path)) return tables
  const { database } = openReadOnly(path, { timeout: 5_000 })
  try {
    for (const row of database.prepare("SELECT m.name AS tbl, p.name AS col FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' ORDER BY m.name, p.cid").all()) {
      const table = String(row["tbl"])
      tables.set(table, [...tables.get(table) ?? [], String(row["col"])])
    }
  } finally {
    database.close()
  }
  return tables
}

/** A SQLite value as JSON: TEXT and NULL as themselves, INTEGER, REAL and BLOB tagged so none reads back as another. */
const EncodedValue = z.union([
  z.null(),
  z.string(),
  z.bigint().transform((int) => ({ int: int.toString() })),
  z.number().transform((real) => ({ real: Number.isFinite(real) ? real : real > 0 ? "Infinity" : "-Infinity" })),
  z.instanceof(Uint8Array).transform((bytes) => ({ bytes: Buffer.from(bytes).toString("base64") })),
])
const DecodedValue = z.union([
  z.null(),
  z.string(),
  z.object({ int: z.string().regex(/^-?\d+$/) }).strict().transform((value) => BigInt(value.int)),
  z.object({ real: z.number() }).strict().transform((value) => value.real),
  z.object({ real: z.enum(["Infinity", "-Infinity"]) }).strict().transform((value) => (value.real === "Infinity" ? Infinity : -Infinity)),
  z.object({ bytes: z.string() }).strict().transform((value) => new Uint8Array(Buffer.from(value.bytes, "base64"))),
])
type EncodedRow = Record<string, z.output<typeof EncodedValue>>

const encodeValue = (value: RecordValue) => EncodedValue.parse(value)

function encodeValues(values: RecordRow): EncodedRow {
  return Object.fromEntries(Object.entries(values).map(([column, value]) => [column, encodeValue(value)]))
}

const Bytes = z.string().transform((text) => new Uint8Array(Buffer.from(text, "base64")))
const Values = z.record(z.string(), DecodedValue)
const EncodedSegment = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), file: z.string(), bytes: Bytes }),
  z.object({ kind: z.literal("append"), file: z.string(), at: z.number().int().nonnegative(), bytes: Bytes }),
  z.object({ kind: z.literal("gone"), file: z.string() }),
  z.object({ kind: z.literal("schema"), database: z.string(), statements: z.array(z.string()), userVersion: z.number().int() }),
  z.object({ kind: z.literal("row"), database: z.string(), table: z.string(), values: Values }),
  z.object({ kind: z.literal("deleted"), database: z.string(), table: z.string(), key: Values }),
])

/** A segment as one line of JSON; the same segment always encodes to the same line. */
export function encodeSegment(segment: RecordSegment): string {
  switch (segment.kind) {
    case "file":
    case "append":
      return JSON.stringify({ ...segment, bytes: Buffer.from(segment.bytes).toString("base64") })
    case "row":
      return JSON.stringify({ ...segment, values: encodeValues(segment.values) })
    case "deleted":
      return JSON.stringify({ ...segment, key: encodeValues(segment.key) })
    default:
      return JSON.stringify(segment)
  }
}

export function decodeSegment(line: string): RecordSegment {
  return EncodedSegment.parse(JSON.parse(line))
}

/** The address of an encoded segment. */
export function segmentId(encoded: string): string {
  return digest(encoded)
}

function homeRelative(home: string, path: string): string {
  const relativePath = relative(home, path)
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error(`${path} lies outside the home ${home}`)
  return relativePath.split(sep).join("/")
}

/** A segment's path under `home`; a segment naming anywhere else is refused. */
function underHome(home: string, file: string): string {
  const parts = file.split("/")
  if (!file || isAbsolute(file) || parts.some((part) => part === ".." || part === "." || part === "")) throw new Error(`A segment names ${file}, which isn't a path inside the home`)
  return join(home, ...parts)
}

const quoted = (name: string) => `"${name.replaceAll(`"`, `""`)}"`

/** One `?` per value, for an `IN (…)` list. */
export const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(", ")

function digest(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}

/** The hash of the bytes just before `size`, which a rewrite of the transcript changes. */
async function tailHash(path: string, size: number): Promise<string> {
  const from = Math.max(0, size - TAIL_BYTES)
  return windowHash(await readRange(path, from, size), size)
}

function windowHash(bytes: Uint8Array, size: number): string {
  const window = bytes.subarray(Math.max(0, bytes.length - TAIL_BYTES))
  return digest(Buffer.concat([Buffer.from(`${size}\n`), window]))
}

async function readRange(path: string, from: number, to: number): Promise<Uint8Array> {
  const handle = await open(path, "r")
  try {
    const bytes = new Uint8Array(to - from)
    let read = 0
    while (read < bytes.length) {
      const { bytesRead } = await handle.read(bytes, read, bytes.length - read, from + read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    return bytes.subarray(0, read)
  } finally {
    await handle.close()
  }
}

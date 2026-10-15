import { createHash } from "node:crypto"
import type { DatabaseSync, StatementSync } from "node:sqlite"
import { z } from "zod"
import type { RecordRow, RecordValue } from "./harness-records.js"

/**
 * A database row as the record store keeps it: its identity, its bytes, and
 * how a capture finds it again while the harness goes on writing.
 */

// Values

/** A SQLite value by its storage class, read once where it leaves SQLite. */
export type SqlValue =
  | { type: "null" }
  | { type: "integer"; value: bigint }
  | { type: "real"; value: number }
  | { type: "text"; value: string }
  | { type: "blob"; value: Uint8Array }

export const SqlValueSchema = z.union([
  z.null().transform((): SqlValue => ({ type: "null" })),
  z.bigint().transform((value): SqlValue => ({ type: "integer", value })),
  // SQLite keeps ±Infinity as REAL; zod's own number refuses it.
  z.custom<number>((value) => Number.isFinite(value) || value === Infinity || value === -Infinity || Number.isNaN(value))
    .transform((value): SqlValue => ({ type: "real", value })),
  z.string().transform((value): SqlValue => ({ type: "text", value })),
  z.instanceof(Uint8Array).transform((value): SqlValue => ({ type: "blob", value })),
])

const sqlValue = (value: RecordValue | undefined): SqlValue => SqlValueSchema.parse(value ?? null)

/** A value in a unit key: JSON, with integers, non-finite reals and bytes tagged so they read back as the same type. */
const TaggedSchema = z.union([
  z.null(),
  z.string(),
  z.object({ int: z.string() }),
  z.object({ real: z.union([z.number(), z.enum(["Infinity", "-Infinity", "NaN"])]) }),
  z.object({ bytes: z.string() }),
])
type Tagged = z.infer<typeof TaggedSchema>

export function tagged(value: SqlValue): Tagged {
  switch (value.type) {
    case "null": return null
    case "text": return value.value
    case "integer": return { int: value.value.toString() }
    case "real": return { real: value.value === Infinity ? "Infinity" : value.value === -Infinity ? "-Infinity" : Number.isNaN(value.value) ? "NaN" : value.value }
    case "blob": return { bytes: Buffer.from(value.value).toString("base64") }
  }
}

function untagged(value: Tagged): RecordValue {
  if (value === null) return null
  if (!(value instanceof Object)) return value
  if ("int" in value) return BigInt(value.int)
  if ("real" in value) return Number(value.real)
  return new Uint8Array(Buffer.from(value.bytes, "base64"))
}

/** A row with each value tagged as unit keys tag it, for printing. */
export function taggedRow(row: RecordRow): Record<string, Tagged> {
  return Object.fromEntries(Object.entries(row).map(([column, value]) => [column, tagged(sqlValue(value))]))
}

// Keys

/**
 * A row's unit key: its table's key (`keyColumns`), or all of its columns
 * where the table has none or the row's key is NULL. A rowid table lets a key
 * that isn't `INTEGER PRIMARY KEY` be NULL (OpenCode's `__drizzle_migrations`
 * declares `id SERIAL PRIMARY KEY` and every id is NULL). A rowid is never a
 * row's identity: `VACUUM` renumbers it, and in another home it names
 * another session's row.
 */
export function rowUnitKey(database: string, table: string, keys: readonly string[], row: RecordRow): string {
  const identity = !keys.length || keys.some((column) => (row[column] ?? null) === null) ? Object.keys(row) : keys
  return `${database}\trow\t${table}\t${JSON.stringify(Object.fromEntries(identity.map((column) => [column, tagged(sqlValue(row[column]))])))}`
}

/** The row a unit key names: its table, and each key column's value. */
export interface RowKey {
  table: string
  columns: string[]
  values: RecordValue[]
}

export function rowKeyOf(key: string): RowKey {
  const [, , table = "", encoded = "{}"] = key.split("\t")
  const object = z.record(z.string(), TaggedSchema).parse(JSON.parse(encoded))
  return { table, columns: Object.keys(object), values: Object.values(object).map(untagged) }
}

const TableColumnSchema = z.object({ name: z.string(), pk: z.number() })
const IndexSchema = z.object({ name: z.string() })
const IndexPartSchema = z.object({ name: z.string().nullable() })
const TableListSchema = z.object({ wr: z.number() })

/** The columns that name one row of `table`: its primary key, else its first plain unique index (Cursor's `cursorDiskKV` declares only `key UNIQUE`), else none. */
export function keyColumns(db: DatabaseSync, table: string): string[] {
  const primary = TableColumnSchema.array().parse(db.prepare(`SELECT name, pk FROM pragma_table_info(?)`).all(table))
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
  if (primary.length) return primary.map((column) => column.name)
  const indexes = IndexSchema.array().parse(db.prepare(`SELECT name FROM pragma_index_list(?) WHERE "unique" = 1 AND partial = 0 ORDER BY seq`).all(table))
  for (const index of indexes) {
    const parts = IndexPartSchema.array().parse(db.prepare(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`).all(index.name))
    // An index on an expression lists that column's name as NULL.
    const columns = parts.flatMap((part) => (part.name === null ? [] : [part.name]))
    if (columns.length && columns.length === parts.length) return columns
  }
  return []
}

export interface Positions {
  columns: string[]
  /** The position is the rowid, which SQLite gives a new row above every row there is. */
  rowid: boolean
  /**
   * How a read by position reaches the table, so the planner seeks each
   * position rather than walk an index the session's condition matches
   * (Cursor's `run_events` by `run_id`): `NOT INDEXED` still seeks the rowid.
   */
  access: string
}

/**
 * Where a capture finds a row again in a later read: its rowid while the
 * read lasts, or a `WITHOUT ROWID` table's primary key, which can't be NULL.
 * Only a capture's own bookkeeping, never a row's identity. Null when the
 * table's columns hide every name of the rowid.
 */
export function positionColumns(db: DatabaseSync, table: string, keys: readonly string[]): Positions | null {
  const listed = TableListSchema.optional().parse(db.prepare("SELECT wr FROM pragma_table_list WHERE name = ? AND schema = 'main'").get(table))
  if (listed?.wr === 1) {
    const primary = IndexSchema.optional().parse(db.prepare("SELECT name FROM pragma_index_list(?) WHERE origin = 'pk'").get(table))
    return keys.length && primary ? { columns: [...keys], rowid: false, access: `INDEXED BY ${quoted(primary.name)}` } : null
  }
  const columns = new Set(TableColumnSchema.array().parse(db.prepare(`SELECT name, pk FROM pragma_table_info(?)`).all(table)).map((column) => column.name.toLowerCase()))
  const alias = ["rowid", "_rowid_", "oid"].find((name) => !columns.has(name))
  return alias ? { columns: [alias], rowid: true, access: "NOT INDEXED" } : null
}

// Key digests

/**
 * A row's key columns as one SQL text, each value a literal of its own type
 * (a REAL to the 17 digits that give it back exactly), so two rows' texts
 * are equal only when their keys are; NULL where a key column is.
 */
export function keyLiteralSql(keys: readonly string[]): string {
  return keys.map((column) => `CASE typeof(${quoted(column)}) WHEN 'null' THEN NULL WHEN 'real' THEN printf('%!.17g', ${quoted(column)}) ELSE quote(${quoted(column)}) END`).join(" || ',' || ")
}

export const KEY_DIGESTS = "mako_key_digests"

/** What `mako_key_digests(literal, below)` gives back. */
export const KeyDigestsSchema = z.object({
  /** Of every row's key, in the order SQLite read them. */
  all: z.string(),
  /** Of the keys of the rows `below`, in the same order. */
  below: z.string(),
  rows: z.number(),
  rowsBelow: z.number(),
})
export type KeyDigests = z.infer<typeof KeyDigestsSchema>

/**
 * `mako_key_digests(literal, below)`: the sha256 of the rows' `keyLiteralSql`
 * texts, and of those `below`, hashed as SQLite reads them, without a text
 * of them all; NULL when a row's key holds a NULL, which names no row.
 */
export function registerKeyDigests(db: DatabaseSync): void {
  // A statement digests one table at a time on its connection, so the state is the function's, begun again after each result.
  const fresh = () => ({ all: createHash("sha256"), below: createHash("sha256"), rows: 0, rowsBelow: 0, named: true })
  let state = fresh()
  db.aggregate(KEY_DIGESTS, {
    start: null,
    step: (_, literal, under) => {
      if (literal === null) state.named = false
      const line = `${String(literal)}\n`
      state.all.update(line)
      state.rows += 1
      if (under === 1) {
        state.below.update(line)
        state.rowsBelow += 1
      }
      return null
    },
    result: () => {
      const { all, below, rows, rowsBelow, named } = state
      state = fresh()
      return named ? JSON.stringify({ all: all.digest("hex"), below: below.digest("hex"), rows, rowsBelow }) : null
    },
  })
}

/** Rows of `table` where `columns` are each `IS ?`, and the session's own condition holds. */
export function lookupSql(table: string, columns: readonly string[], where?: string): string {
  return `SELECT * FROM ${quoted(table)} WHERE ${columns.map((column) => `${quoted(column)} IS ?`).join(" AND ")}${where ? ` AND (${where})` : ""}`
}

export function lookupStatement(db: DatabaseSync, table: string, columns: readonly string[], where?: string): StatementSync {
  const statement = db.prepare(lookupSql(table, columns, where))
  // An INTEGER read as a JS number would come back as a REAL.
  statement.setReadBigInts(true)
  return statement
}

// Rows as bytes

const NULL = 0, INT = 1, REAL = 2, TEXT = 3, BLOB = 4

/** A row as bytes: columns by name, each value tagged with its SQLite type, so it reads back as the same type. */
export function encodeRow(row: RecordRow): Buffer {
  const parts: Buffer[] = []
  const names = Object.keys(row).sort()
  const count = Buffer.alloc(4)
  count.writeUInt32LE(names.length)
  parts.push(count)
  for (const name of names) {
    const value = sqlValue(row[name])
    const label = Buffer.from(name, "utf8")
    const head = Buffer.alloc(3)
    head.writeUInt16LE(label.length)
    parts.push(head, label)
    const sized = (tag: number, body: Buffer) => {
      head.writeUInt8(tag, 2)
      const length = Buffer.alloc(4)
      length.writeUInt32LE(body.length)
      parts.push(length, body)
    }
    switch (value.type) {
      case "null":
        head.writeUInt8(NULL, 2)
        break
      case "integer": {
        head.writeUInt8(INT, 2)
        const body = Buffer.alloc(8)
        body.writeBigInt64LE(value.value)
        parts.push(body)
        break
      }
      case "real": {
        head.writeUInt8(REAL, 2)
        const body = Buffer.alloc(8)
        body.writeDoubleLE(value.value)
        parts.push(body)
        break
      }
      case "text":
        sized(TEXT, Buffer.from(value.value, "utf8"))
        break
      case "blob":
        sized(BLOB, Buffer.from(value.value.buffer, value.value.byteOffset, value.value.byteLength))
        break
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

export const quoted = (name: string) => `"${name.replaceAll(`"`, `""`)}"`

import { existsSync } from "node:fs"
import type { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { openReadOnly, ReadOnlyStoreError } from "./read-only-sqlite.js"

/**
 * How a store that several Mako builds share says which of them may read it
 * and which may write it.
 *
 * The installed app, the `dev` profile and every sandbox or review profile
 * open the same stores under `~/.mako`. A build that refused a store in a
 * newer format lost its Threads, sessions and remembered settings the
 * moment a development build migrated them, so no build refuses for that
 * alone. A store keeps two numbers in its key-value meta table, the way
 * SQLite keeps its own file format's:
 *
 * - `schema` (`writableBy`): the format a build must know to write it;
 * - `reads` (`readableBy`): the oldest format whose builds can still read it.
 *
 * A change older builds can live with (a table or column they never read)
 * raises neither. A build at or above `writableBy` reads and writes; one at
 * or above `readableBy` reads and writes nothing it doesn't know how to
 * (each store says what it declines and what it leaves for later); only a
 * build below `readableBy` leaves the store, naming the Mako that can read
 * it. The build that raises a number stamps its own name beside it
 * (`schema_by`, `reads_by`), which is how an older build names it.
 *
 * Every writing connection declares this build's format to SQLite
 * (`declareStoreFormat`), so a build that raises `writableBy` can leave
 * triggers (`guardStoreWrites`) that stop an older build's writes inside
 * SQLite itself, even one that opened the store before the raise.
 */
export interface StoreFormat {
  /** `schema`: the format a build must know to write the store. */
  writableBy: number
  /** `reads`: the oldest format whose builds can still read it. */
  readableBy: number
  /** `schema_by`: the Mako that raised `writableBy`, as it named itself. */
  writtenBy?: string
  /** `reads_by`: the Mako that raised `readableBy`, the oldest that reads the store. */
  readableFrom?: string
}

/** What this build may do with a store: write it, only read it, or leave it as it is. */
export type StoreAccess = "write" | "read" | "refused"

/** Where a store stands for this build, as Settings › Diagnostics lists it. */
export interface StoreStanding {
  access: StoreAccess
  /** This build's format of the store. */
  build: number
  /** The store's own numbers, when it has any. */
  format?: StoreFormat
}

/** A store whose numbers this build can't read, or a newer format, is never written. */
export function storeAccess(found: StoreFormat | undefined, build: number): StoreAccess {
  if (!found || found.writableBy <= build) return "write"
  return found.readableBy <= build ? "read" : "refused"
}

const KEYS = ["schema", "reads", "schema_by", "reads_by"] as const
const MetaRowSchema = z.object({ key: z.enum(KEYS), value: z.string() })

/**
 * The numbers a store keeps in its key-value `table`; undefined for a store
 * that has none yet. A store that names no `reads` is read by builds of its
 * own format only.
 */
export function readStoreFormat(db: DatabaseSync, table: string): StoreFormat | undefined {
  const found = new Map<string, string>()
  for (const row of MetaRowSchema.array().parse(db.prepare(`SELECT key, value FROM ${table} WHERE key IN (${KEYS.map(() => "?").join(", ")})`).all(...KEYS)))
    found.set(row.key, row.value)
  const schema = found.get("schema")
  if (schema === undefined) return undefined
  const writableBy = formatNumber(schema)
  const format: StoreFormat = { writableBy, readableBy: formatNumber(found.get("reads") ?? schema) }
  const writtenBy = found.get("schema_by")
  const readableFrom = found.get("reads_by")
  if (writtenBy) format.writtenBy = writtenBy
  if (readableFrom) format.readableFrom = readableFrom
  return format
}

/** A number another build wrote; one this build can't read counts as newer than any it knows. */
function formatNumber(text: string): number {
  const value = Number(text)
  return Number.isSafeInteger(value) && value >= 0 ? value : Number.MAX_SAFE_INTEGER
}

/**
 * Write a store's numbers, in the caller's transaction. A number that rises
 * is stamped with `writer`, the build raising it; one that stays keeps its
 * stamp, so it always names the Mako that set it.
 */
export function writeStoreFormat(db: DatabaseSync, table: string, format: { writableBy: number; readableBy: number }, writer?: string): void {
  const found = readStoreFormat(db, table)
  const set = db.prepare(`INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
  if (found?.writableBy !== format.writableBy) {
    set.run("schema", String(format.writableBy))
    if (writer) set.run("schema_by", writer)
  }
  const raised = found?.readableBy !== format.readableBy
  // A store from before `reads` was kept says its own format; this writes it down.
  if (raised || !db.prepare(`SELECT 1 AS found FROM ${table} WHERE key = 'reads'`).get()) set.run("reads", String(format.readableBy))
  if (raised && writer) set.run("reads_by", writer)
}

/**
 * The numbers of the store at `path`, read without writing or creating any
 * file; undefined when there's no store, no table or no numbers yet.
 */
export function inspectStoreFormat(path: string, table: string): StoreFormat | undefined {
  if (!existsSync(path)) return undefined
  const { database } = openReadOnly(path, { timeout: 1_000 })
  try {
    if (!database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return undefined
    return readStoreFormat(database, table)
  } finally {
    database.close()
  }
}

/** The build that raised a store's format, by its stamp: "a newer Mako (0.163.0)", or a development build. */
export function newerMako(writer: string | undefined): string {
  const named = stamp(writer)
  if (!named) return "a newer Mako"
  return named.development ? `a development build of Mako (${named.version})` : `a newer Mako (${named.version})`
}

/** The Mako a store needs, by the stamp of the build that raised `reads`. */
export function makoNeeded(writer: string | undefined): string {
  const named = stamp(writer)
  if (!named) return "a newer Mako"
  return named.development ? `a development build of Mako (${named.version}) or later` : `Mako ${named.version} or later`
}

function stamp(writer: string | undefined): { version: string; development: boolean } | undefined {
  if (!writer) return undefined
  const development = writer.endsWith(DEVELOPMENT)
  return { version: development ? writer.slice(0, -DEVELOPMENT.length) : writer, development }
}

const DEVELOPMENT = "+development"

/** How a build stamps the formats it raises: its version, marked when it runs from a checkout. */
export function storeWriter(build: { version: string; development: boolean }): string {
  return build.development ? `${build.version}${DEVELOPMENT}` : build.version
}

/**
 * A store this build can't read: it's left as it is, and the message names
 * the Mako that can.
 */
export class NewerStoreError extends Error {
  readonly format: StoreFormat
  readonly build: number
  constructor(store: string, format: StoreFormat, build: number) {
    super(`${capitalized(store)} needs ${makoNeeded(format.readableFrom)} to read (its format ${format.writableBy}, read from format ${format.readableBy}; this build knows ${build}). It's kept as it is.`)
    this.name = "NewerStoreError"
    this.format = format
    this.build = build
  }
}

/**
 * A write this build declines because a newer Mako changed the store's
 * format: "A newer Mako (0.163.0) updated your Threads; this one
 * `consequence`." Still a `ReadOnlyStoreError`, so whoever already treats a
 * read-only store's refusal as one goes on doing so.
 */
export class NewerStoreReadOnlyError extends ReadOnlyStoreError {
  readonly format: StoreFormat
  constructor(store: string, format: StoreFormat, consequence: string) {
    super(store)
    this.name = "NewerStoreReadOnlyError"
    this.format = format
    this.message = `${capitalized(newerMako(format.writtenBy))} updated ${store}; this one ${consequence}.`
  }
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** The SQL function a writing connection answers with its build's format. */
const FORMAT_FUNCTION = "mako_store_format"
/** What a guard's refusal starts with, so a store can tell it from other failures. */
const GUARD_REFUSAL = "Written by a newer Mako:"

/** Tell SQLite which format this build writes, for the guards a newer build may leave. */
export function declareStoreFormat(db: DatabaseSync, build: number): void {
  db.function(FORMAT_FUNCTION, { deterministic: true }, () => build)
}

/**
 * For a build that raises `writableBy`: triggers on `tables` that abort any
 * insert, update or delete from a connection whose declared format is
 * older, or that declared none (a build from before this rule). Reads are
 * untouched. Run in the transaction that raises the number.
 *
 * `shared` is what every format of a store keeps valid for older builds
 * (`SharedWrites`, declared by the store, such as the session ledger's
 * holds): an update of only those columns, and a delete from those
 * tables, still goes through.
 */
export function guardStoreWrites(db: DatabaseSync, tables: readonly string[], writableBy: number, shared: SharedWrites = {}): void {
  for (const table of tables)
    for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      const name = `${FORMAT_FUNCTION}_${table}_${operation.toLowerCase()}`
      db.exec(`DROP TRIGGER IF EXISTS ${name}`)
      if (operation === "DELETE" && shared.delete?.includes(table)) continue
      const kept = operation === "UPDATE" ? shared.update?.[table] : undefined
      // Only an update that sets a column other than the shared ones is stopped.
      const columns = kept ? ColumnNamesSchema.parse(db.prepare(`PRAGMA table_info(${table})`).all()).map((column) => column.name).filter((column) => !kept.includes(column)) : null
      if (columns?.length === 0) continue
      const event = columns ? `UPDATE OF ${columns.join(", ")}` : operation
      db.exec(`CREATE TRIGGER ${name} BEFORE ${event} ON ${table}
        WHEN ${FORMAT_FUNCTION}() < ${writableBy}
        BEGIN SELECT RAISE(ABORT, '${GUARD_REFUSAL} update Mako to change this store'); END;`)
    }
}

/**
 * Writes every later format of a store keeps valid for older builds, so a
 * running older host goes on doing them after a newer one raises the
 * format: columns of a table it may still update, and tables it may still
 * delete its own rows from.
 */
export interface SharedWrites {
  update?: Readonly<Record<string, readonly string[]>>
  delete?: readonly string[]
}

const ColumnNamesSchema = z.object({ name: z.string() }).array()

/** Whether a write failed on a newer build's guard: this build declared an older format, or none. */
export function guardRefused(error: Error): boolean {
  return error.message.includes(GUARD_REFUSAL) || error.message.includes(`no such function: ${FORMAT_FUNCTION}`)
}

/** A JSON value as another build wrote it, carried whole. */
export const JsonValueSchema = z.json()
export type JsonValue = z.infer<typeof JsonValueSchema>
/** A JSON object as another build wrote it: what a rewrite carries back. */
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema)
export type JsonObject = z.infer<typeof JsonObjectSchema>

const JsonFormatSchema = z.object({ version: z.number().int().nonnegative(), reads: z.number().int().nonnegative().optional() })

/**
 * The same rule for a JSON file several builds rewrite: `version` is the
 * format a build must know to write it and `reads`, when there, the oldest
 * that can read it. A file with no version this build can read is its own
 * format's, which it rewrites.
 */
export function jsonStoreAccess(file: JsonValue, build: number): StoreAccess {
  const found = JsonFormatSchema.safeParse(file)
  if (!found.success) return "write"
  return storeAccess({ writableBy: found.data.version, readableBy: found.data.reads ?? found.data.version }, build)
}

/**
 * The fields of `value` this build doesn't name, to write back as they
 * were: a newer Mako's additions survive an older build's rewrite. A value
 * that isn't an object has none.
 */
export function unknownFields(value: JsonValue | undefined, known: readonly string[]): JsonObject {
  const object = JsonObjectSchema.safeParse(value)
  if (!object.success || Array.isArray(value)) return {}
  const names = new Set(known)
  return Object.fromEntries(Object.entries(object.data).filter(([key]) => !names.has(key)))
}

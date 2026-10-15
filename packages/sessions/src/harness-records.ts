import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import type { SQLInputValue, SQLOutputValue } from "node:sqlite"
import { openReadOnly } from "./read-only-sqlite.js"

/**
 * Where a harness keeps one session (`SessionProvider.records`): its files,
 * and the rows it owns in shared databases. The record store
 * (`record-store.ts`) keeps them as units and versions; each reader only
 * says where they are.
 */

export interface RecordTable {
  table: string
  /** The session's rows, as an SQL condition over `params`; unset takes every row. */
  where?: string
  params?: SQLInputValue[]
  /**
   * A row is never rewritten under its key, nor its key used again once
   * deleted: once held, it isn't read whole again until the database's
   * schema changes, and once a capture has taken every row, the rows are
   * matched by one digest of their keys and only new ones listed. Deletes
   * are still seen. A harness that rewrote such a row would leave Mako's
   * copy behind, so a table is marked only on its writer's own code.
   */
  immutable?: true
  /** Columns whose value is a path into the harness's own records (Codex's `threads.rollout_path`), which a restore moves with its root. A working directory isn't one: the harness takes a new one when the session resumes there. */
  paths?: string[]
}

/** A folder a harness keeps records under, by a name that is the same wherever the folder is. */
export interface RecordRoot {
  /** Lowercase, as `codex` or `cursor-sdk`; one beyond the usual folder adds `@` and a hash of its path (`extraRoot`). */
  name: string
  path: string
}

/** The lines of a shared JSON Lines file that are one session's, by a field's value: Codex's `session_index.jsonl` names threads so. */
export interface RecordLines {
  path: string
  field: string
  value: string
}

export interface RecordDatabase {
  path: string
  /** The tables holding the session's rows; the schema of every table is captured regardless. */
  tables: RecordTable[]
}

/** A file the harness may move or compress without changing it (a Codex rollout, dated or archived). */
export interface RecordPlace {
  /** Its unit key, the same wherever the harness filed it. */
  key: string
  /** Every plain path it may be at, named as the store names paths (`record-roots.ts`). */
  places: string[]
}

/** Where a harness keeps one session: absolute paths under its roots. */
export interface SessionRecords {
  /** Every folder the session's files and databases lie under. */
  roots: RecordRoot[]
  files: string[]
  databases: RecordDatabase[]
  lines?: RecordLines[]
  /** A file's key and places, by its plain path as the store names it (`codex:sessions/…`); unset, or null for a path, keys a file by where it is. */
  place?: (path: string) => RecordPlace | null
}

export type RecordValue = SQLOutputValue
/** A row by column name. */
export type RecordRow = Record<string, RecordValue>

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

const quoted = (name: string) => `"${name.replaceAll(`"`, `""`)}"`

/** One `?` per value, for an `IN (…)` list. */
export const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(", ")

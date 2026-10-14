import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import type { SQLInputValue } from "node:sqlite"
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

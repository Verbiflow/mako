import type { DatabaseSync } from "node:sqlite"
import { openNativeStoreForWriting } from "./read-only-sqlite.js"

/**
 * Delete one session's rows from a SQLite store that several apps may hold
 * open: every table with a `session_id` column loses the rows for that id,
 * then the session rows themselves go, all in one transaction. Child
 * sessions (a `parent_id` pointing at the session) are removed the same way
 * first, since they have no life without their parent.
 */
export async function removeSessionRows(
  file: string,
  id: string,
  sessionTables: readonly string[]
): Promise<boolean> {
  const sqlite = await import("node:sqlite").catch(() => null)
  if (!sqlite) return false
  const database: DatabaseSync = openNativeStoreForWriting(file)
  try {
    database.exec("PRAGMA busy_timeout = 3000")
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name))
    const columns = (table: string) =>
      database
        .prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
        .all()
        .map((row) => String(row.name))
    const present = sessionTables.filter((table) => tables.includes(table))
    if (!present.length) return false
    const referencing = tables.filter(
      (table) => !present.includes(table) && columns(table).includes("session_id")
    )
    const ids = [id]
    for (const table of present) {
      if (!columns(table).includes("parent_id")) continue
      for (const row of database
        .prepare(`SELECT id FROM "${table}" WHERE parent_id = ?`)
        .all(id))
        ids.push(String(row.id))
    }
    database.exec("BEGIN IMMEDIATE")
    try {
      let removed = 0
      for (const target of ids) {
        for (const table of referencing)
          database.prepare(`DELETE FROM "${table}" WHERE session_id = ?`).run(target)
        for (const table of present)
          removed += Number(
            database.prepare(`DELETE FROM "${table}" WHERE id = ?`).run(target).changes
          )
      }
      database.exec("COMMIT")
      return removed > 0
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
  } finally {
    database.close()
  }
}

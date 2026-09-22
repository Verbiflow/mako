import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { NativeResumeRecord } from "../../native-continuation.js"

export type OpenCodeResumeRecord =
  | { kind: "available"; checkpoint: string; generation: "v1" | "v2" }
  | Extract<NativeResumeRecord, { kind: "unavailable" }>

export function openCodeRecordLocator(path: string): { database: string; nativeId: string; v2: boolean } | null {
  const split = path.lastIndexOf("#")
  if (split < 1) return null
  const database = path.slice(0, split)
  if (!isAbsolute(database)) return null
  const fragment = path.slice(split + 1)
  const v2 = fragment.startsWith("v2:")
  try {
    const nativeId = decodeURIComponent(v2 ? fragment.slice(3) : fragment)
    return /^[\w-]{1,200}$/.test(nativeId) ? { database, nativeId, v2 } : null
  } catch { return null }
}

/** Worker-only: fingerprint one native record in a consistent read transaction. */
export function readOpenCodeResumeRecord(path: string, nativeId: string): OpenCodeResumeRecord {
  const target = openCodeRecordLocator(path)
  if (!target || target.nativeId !== nativeId)
    return { kind: "unavailable", reason: "The saved OpenCode source does not match its native session ID." }
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(target.database, { readOnly: true })
    db.exec("PRAGMA busy_timeout=100; BEGIN")
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name))
    const sessionTable = target.v2 ? "session_v2" : "session"
    // The unmarked locator in a mixed database names the legacy session table.
    const legacy = !target.v2 && tables.has("message") && tables.has("part") && !target.database.endsWith("opencode-next.db")
    const contentTables = legacy ? ["message", "part"] : ["session_message"]
    if (!tables.has(sessionTable) || contentTables.some(table => !tables.has(table)))
      return { kind: "unavailable", reason: "This OpenCode native store layout is not supported by the recovery reader." }
    const session = db.prepare(`SELECT * FROM ${sessionTable} WHERE id=?`).get(nativeId)
    if (!session)
      return { kind: "unavailable", reason: "The OpenCode session is missing from its native database." }
    // Loading can wake already-admitted native inputs. Do not disguise that as
    // a harmless replay of history or resend them through Mako's queue.
    if (!legacy) {
      for (const table of ["session_pending", "session_inbox"]) {
        if (tables.has(table) && db.prepare(`SELECT 1 FROM ${table} WHERE session_id=? LIMIT 1`).get(nativeId))
          return { kind: "unavailable", reason: "OpenCode still has native inputs awaiting execution. Their recovery must be reconciled before reconnecting." }
      }
    }
    const hash = createHash("sha256")
    hash.update(JSON.stringify(["opencode-record-v1", sessionTable, session]) + "\n")
    for (const table of contentTables) {
      hash.update(table + "\n")
      for (const row of db.prepare(`SELECT * FROM ${table} WHERE session_id=? ORDER BY id`).iterate(nativeId))
        hash.update(JSON.stringify(row) + "\n")
    }
    return { kind: "available", checkpoint: hash.digest("hex"), generation: legacy ? "v1" : "v2" }
  } catch {
    return { kind: "unavailable", reason: "The OpenCode native record could not be read consistently." }
  } finally {
    if (db) { if (db.isTransaction) db.exec("ROLLBACK"); db.close() }
  }
}

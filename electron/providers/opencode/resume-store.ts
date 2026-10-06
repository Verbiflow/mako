import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { isAbsolute } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { openNativeStore } from "@mako/sessions/read-only-sqlite"
import type { NativeResumeRecord } from "../../native-continuation.js"

export type OpenCodeResumeRecord =
  | { kind: "available"; checkpoint: string; generation: "v2" }
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

type SessionStore =
  | { kind: "supported"; sessionTable: string; tables: Set<unknown> }
  | Extract<NativeResumeRecord, { kind: "unavailable" }>

const CONTENT_TABLES = ["session_message"]

function sessionStore(db: DatabaseSync, target: { v2: boolean }, database: string): SessionStore {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name))
  const sessionTable = target.v2 ? "session_v2" : "session"
  // The unmarked locator in a mixed database names the legacy session table.
  const legacy = !target.v2 && tables.has("message") && tables.has("part") && !database.endsWith("opencode-next.db")
  if (legacy) return { kind: "unavailable", reason: "OpenCode v1 sessions are no longer supported for continuation. Saved history remains available." }
  if (!tables.has(sessionTable) || CONTENT_TABLES.some(table => !tables.has(table)))
    return { kind: "unavailable", reason: "This OpenCode native store layout is not supported by the recovery reader." }
  return { kind: "supported", sessionTable, tables }
}

/** Worker-only: whether this locator's store holds the session's row, whatever state the session is in. */
export function openCodeStoreHolds(path: string, nativeId: string): boolean {
  const target = openCodeRecordLocator(path)
  if (!target || target.nativeId !== nativeId) return false
  let db: DatabaseSync | undefined
  try {
    const database = realpathSync(target.database)
    db = openNativeStore(database)
    db.exec("PRAGMA busy_timeout=100")
    const store = sessionStore(db, target, database)
    return store.kind === "supported" && Boolean(db.prepare(`SELECT 1 FROM ${store.sessionTable} WHERE id=?`).get(nativeId))
  } catch {
    return false
  } finally {
    db?.close()
  }
}

/** Worker-only: fingerprint one native record in a consistent read transaction. */
export function readOpenCodeResumeRecord(path: string, nativeId: string): OpenCodeResumeRecord {
  const target = openCodeRecordLocator(path)
  if (!target || target.nativeId !== nativeId)
    return { kind: "unavailable", reason: "The saved OpenCode source does not match its native session ID." }
  let db: DatabaseSync | undefined
  try {
    const database = realpathSync(target.database)
    db = openNativeStore(database)
    db.exec("PRAGMA busy_timeout=100; BEGIN")
    const store = sessionStore(db, target, database)
    if (store.kind === "unavailable") return store
    const { sessionTable, tables } = store
    const session = db.prepare(`SELECT * FROM ${sessionTable} WHERE id=?`).get(nativeId)
    if (!session)
      return { kind: "unavailable", reason: "The OpenCode session is missing from its native database." }
    // Loading can wake already-admitted native inputs. Do not disguise that as
    // a harmless replay of history or resend them through Mako's queue.
    for (const table of ["session_pending", "session_inbox"]) {
      if (tables.has(table) && db.prepare(`SELECT 1 FROM ${table} WHERE session_id=? LIMIT 1`).get(nativeId))
        return { kind: "unavailable", reason: "OpenCode still has native inputs awaiting execution. Their recovery must be reconciled before reconnecting." }
    }
    const hash = createHash("sha256")
    hash.update(JSON.stringify(["opencode-record-v1", sessionTable, session]) + "\n")
    for (const table of CONTENT_TABLES) {
      hash.update(table + "\n")
      for (const row of db.prepare(`SELECT * FROM ${table} WHERE session_id=? ORDER BY id`).iterate(nativeId))
        hash.update(JSON.stringify(row) + "\n")
    }
    return { kind: "available", checkpoint: hash.digest("hex"), generation: "v2" }
  } catch {
    return { kind: "unavailable", reason: "The OpenCode native record could not be read consistently." }
  } finally {
    if (db) { if (db.isTransaction) db.exec("ROLLBACK"); db.close() }
  }
}

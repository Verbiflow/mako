import type { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { boundedChildren, type ChildTranscript } from "../children.js"
import type { NativeStores } from "../read-only-sqlite.js"
import { READ_BUSY_TIMEOUT_MS, SqliteBusy } from "./sqlite-busy.js"
import { SessionUnreadable } from "./types.js"

/**
 * OpenCode's subagents are sessions of their own in the same database, with
 * `parent_id` naming the session that started them; a subagent's own
 * subagents name it. The parent's `subagent` call (`task` before v2) names
 * the child in its state's metadata (`sessionID`) with the call's status.
 */

const MAX_DEPTH = 4
const ENDED = new Set(["completed", "error", "failed", "succeeded", "interrupted"])
const ToolPart = z.object({
  type: z.literal("tool"),
  id: z.string().optional(),
  callID: z.string().optional(),
  state: z.object({
    status: z.string().optional(),
    input: z.object({ description: z.string().optional(), agent: z.string().optional(), subagent_type: z.string().optional() }).partial().optional(),
    metadata: z.object({ sessionID: z.string().optional(), sessionId: z.string().optional(), status: z.string().optional() }).optional(),
  }),
})

const SessionRow = z.object({
  id: z.string(),
  title: z.string().nullable(),
  created: z.number().nullable(),
  updated: z.number().nullable(),
  outcome: z.string().nullable(),
})
const ColumnRow = z.object({ name: z.string() })
const ParentRow = z.object({ parent_id: z.string().nullable() })
const DataRow = z.object({ data: z.string() })
const MessageContent = z.object({ content: z.array(z.unknown()) })

interface Call {
  toolId?: string
  status?: string
  title?: string
  role?: string
}

export function openCodeChildren(
  stores: NativeStores,
  database: string,
  id: string,
  v2: boolean,
  pathOf: (id: string) => string
): ChildTranscript[] | null {
  let db: DatabaseSync
  try {
    db = stores.open(database, { timeout: READ_BUSY_TIMEOUT_MS })
  } catch {
    return null
  }
  try {
    const table = v2 ? "session_v2" : "session"
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) return null
    const columns = new Set(db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).flatMap((row) => ColumnRow.safeParse(row).data?.name ?? []))
    const outcome = columns.has("idle_outcome") ? "idle_outcome" : "NULL"
    const sessions = db.prepare(`SELECT id, title, time_created AS created, time_updated AS updated, ${outcome} AS outcome FROM ${table} WHERE parent_id = ?`)
    const children: ChildTranscript[] = []
    const calls = new Map<string, Call>()
    const located = new Set<string>()
    let level = [id]
    for (let depth = 0; depth <= MAX_DEPTH && level.length; depth++) {
      const next: string[] = []
      for (const parent of level) {
        for (const [child, call] of parentCalls(db, v2, parent)) calls.set(child, call)
        for (const raw of sessions.all(parent)) {
          const row = SessionRow.safeParse(raw).data
          if (!row || located.has(row.id)) continue
          const child = row.id
          located.add(child)
          next.push(child)
          const call = calls.get(child)
          const ended = (call?.status && ENDED.has(call.status)) || (row.outcome !== null && ENDED.has(row.outcome))
          const entry: ChildTranscript = {
            nativeId: child,
            path: pathOf(child),
            state: ended ? { kind: "complete" } : { kind: "partial", reason: "OpenCode hasn't recorded this subagent's end: it is still running, or stopped without reporting." },
          }
          if (call?.toolId) entry.toolId = call.toolId
          if (parent !== id) entry.spawnedBy = parent
          const title = row.title || call?.title
          if (title) entry.title = title
          if (call?.role) entry.role = call.role
          if (row.created && row.created > 0) entry.startedAt = new Date(row.created).toISOString()
          if (row.updated && row.updated > 0) entry.updatedAt = new Date(row.updated).toISOString()
          children.push(entry)
        }
      }
      level = next
    }
    // Named by a call, kept nowhere: the session it started is gone from the database.
    for (const [child, call] of calls) {
      if (located.has(child)) continue
      const entry: ChildTranscript = { nativeId: child, state: { kind: "missing", reason: "OpenCode keeps no session for this subagent." } }
      if (call.toolId) entry.toolId = call.toolId
      if (call.title) entry.title = call.title
      children.push(entry)
    }
    return boundedChildren(children.sort((left, right) => (left.startedAt ?? "~").localeCompare(right.startedAt ?? "~"))).children
  } catch (error) {
    if (SqliteBusy.safeParse(error).success) throw new SessionUnreadable(database, { cause: error })
    return null
  } finally {
    db.close()
  }
}

/** The session that started `id`, when one did. */
export function openCodeParent(db: DatabaseSync, table: "session" | "session_v2", id: string): string | undefined {
  return ParentRow.safeParse(db.prepare(`SELECT parent_id FROM ${table} WHERE id = ?`).get(id)).data?.parent_id || undefined
}

/** The calls in a session's messages that name a child session, by child. Only rows holding such a name are decoded. */
function parentCalls(db: DatabaseSync, v2: boolean, session: string): Map<string, Call> {
  const found = new Map<string, Call>()
  const rows = v2
    ? db.prepare("SELECT data FROM session_message WHERE session_id = ? AND (instr(data, '\"sessionID\"') > 0 OR instr(data, '\"sessionId\"') > 0)").all(session)
    : db.prepare("SELECT data FROM part WHERE session_id = ? AND (instr(data, '\"sessionID\"') > 0 OR instr(data, '\"sessionId\"') > 0)").all(session)
  for (const row of rows) {
    const data = DataRow.safeParse(row).data?.data
    if (data === undefined) continue
    let value: unknown
    try {
      value = JSON.parse(data)
    } catch {
      continue
    }
    const parts = MessageContent.safeParse(value).data?.content ?? [value]
    for (const part of parts) {
      const tool = ToolPart.safeParse(part)
      if (!tool.success) continue
      const { state } = tool.data
      const child = state.metadata?.sessionID ?? state.metadata?.sessionId
      if (!child) continue
      found.set(child, {
        toolId: tool.data.callID ?? tool.data.id,
        status: state.metadata?.status ?? state.status,
        title: state.input?.description,
        role: state.input?.agent ?? state.input?.subagent_type,
      })
    }
  }
  return found
}

import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import type { NativeAgentObservation } from "../../contracts/native-agents.js"

const childRow = z.object({ id: z.string(), parent_id: z.string(), title: z.string().nullable(), time_idle: z.number().nullable(), idle_outcome: z.string().nullable() })
const messageRow = z.object({ id: z.string(), seq: z.number(), time_created: z.number(), completed: z.number().nullable(), finish: z.string().nullable() })

/** Called only on the observation worker. Indexed metadata, never transcript replay. */
export function readOpenCodeAgents(paths: readonly string[], parent: string): NativeAgentObservation[] {
  const agents: NativeAgentObservation[] = []
  for (const path of paths) {
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(path, { readOnly: true })
      db.exec("PRAGMA busy_timeout=100; BEGIN")
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='session_v2'").get()) continue
      if (!db.prepare("SELECT 1 FROM session_v2 WHERE id=?").get(parent)) continue
      const children = db.prepare(`WITH RECURSIVE children(id) AS (
        SELECT id FROM session_v2 WHERE parent_id=?
        UNION SELECT s.id FROM session_v2 s JOIN children c ON s.parent_id=c.id
      ) SELECT s.id,s.parent_id,s.title,s.time_idle,s.idle_outcome FROM session_v2 s JOIN children c ON s.id=c.id`).all(parent)
      const latest = db.prepare(`SELECT id,seq,time_created,
        json_extract(data,'$.time.completed') completed,json_extract(data,'$.finish') finish
        FROM session_message WHERE session_id=? AND type=? ORDER BY seq DESC LIMIT 1`)
      const pending = db.prepare("SELECT id FROM session_pending WHERE session_id=? ORDER BY admitted_seq DESC LIMIT 1")
      const inbox = db.prepare("SELECT id FROM session_inbox WHERE session_id=? ORDER BY enqueued_seq DESC LIMIT 1")
      for (const row of children) {
        const child = childRow.parse(row)
        const queued = z.object({ id: z.string() }).optional().parse(pending.get(child.id) ?? inbox.get(child.id))
        const input = messageRow.optional().parse(latest.get(child.id, "user"))
        const answer = messageRow.optional().parse(latest.get(child.id, "assistant"))
        // v2 retains the PREVIOUS idle outcome while the next input/assistant
        // is running. A terminal result must follow the current input and
        // completed assistant, not just exist somewhere in this session.
        const terminal = !queued && input && answer && answer.seq > input.seq &&
          answer.completed !== null && answer.completed >= input.time_created &&
          child.time_idle !== null && child.time_idle >= answer.completed &&
          child.time_idle > input.time_created
        let state: NativeAgentObservation["state"] = { kind: "working" }
        if (terminal && child.idle_outcome === "succeeded" && answer.finish === "stop") state = { kind: "completed" }
        else if (terminal && child.idle_outcome === "failed") state = { kind: "failed", error: "Native child execution failed" }
        else if (terminal && child.idle_outcome === "interrupted") state = { kind: "canceled" }
        agents.push({ nativeId: child.id, parentNativeId: child.parent_id, nativeRunId: queued?.id ?? input?.id,
          title: (child.title ?? "Subagent").slice(0, 512), state })
      }
      return agents
    } catch (error) {
      // Missing candidate stores are expected. A present but unreadable store
      // must not be interpreted as an empty or completed child set.
      const missing = z.object({ code: z.literal("ERR_SQLITE_ERROR"), errcode: z.literal(14) }).safeParse(error)
      if (!missing.success) throw error
    } finally { if (db) { if (db.isTransaction) db.exec("ROLLBACK"); db.close() } }
  }
  return agents
}

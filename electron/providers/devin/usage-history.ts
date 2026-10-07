import { existsSync } from "node:fs"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { devinCliDirectory } from "@mako/sessions"
import { DevinStoredCall, devinStoredTokens } from "@mako/sessions/harnesses"
import { openNativeStore } from "@mako/sessions/read-only-sqlite"
import { z } from "zod"
import { tokenTotal, usageCounts, yieldToMain, type UsageEvent, type UsageScan } from "../../usage-scan.js"
import type { ProviderUsageHistory } from "../usage-history.js"

export const devinUsageHistory: ProviderUsageHistory = {
  provider: "devin",
  scan,
}

const RowSchema = z.object({ session_id: z.string(), node_id: z.number(), created_at: z.number().nullable(), call: z.string().nullable() })
const LastRowSchema = z.object({ last: z.number().nullable() })
const SessionSchema = z.object({ id: z.string(), model: z.string().nullable(), working_directory: z.string().nullable() })
/**
 * Rows read between yields to the main process, where the summary runs: on
 * a 309,000-row month, 2,048 rows held it at most 39 ms, 8,192 rows 312 ms,
 * at the same 0.6 s in all.
 */
const ROWS_PER_READ = 2_048
/** `json_extract`'s array of the call's fields, in the order the query asks for them. */
const CallFields = z.tuple([z.unknown(), z.unknown(), z.unknown(), z.unknown()])

/**
 * Devin's CLI store keeps each call's metrics in its chat message; on this
 * machine it reached 5 GB with a 16 GB WAL. `row_id` is AUTOINCREMENT, and
 * Devin 3000.10.23 never updates a row: it adds one per message, and saves a
 * message again, once its deferred fields arrive, with `INSERT OR REPLACE` on
 * `(session_id, node_id)`, which deletes the row and adds it with a new
 * `row_id`. So every write is a `row_id` above `sqlite_sequence`'s mark for
 * the table, which a deleted session doesn't lower. The first read finds the
 * window's first row by binary search on `row_id` (rows are added in time
 * order), and each read after continues past the mark the one before saw.
 * Only rows whose message mentions `"input_tokens"` are decoded.
 */
async function scan(scan: UsageScan): Promise<void> {
  const path = join(devinCliDirectory(scan.env, scan.homeRoot), "sessions.db")
  if (!existsSync(path)) return
  await scan.store(path, async (cursor) => {
    const db = openNativeStore(path)
    try {
      const last = lastRow(db)
      if (last === undefined) return undefined
      if (cursor === last) return cursor
      // A cursor past the mark is a store made again, whose rows start over.
      const from = cursor !== undefined && cursor < last ? cursor + 1 : firstRowSince(db, scan.since, last)
      const sessions = new Map(db.prepare("SELECT id, model, working_directory FROM sessions").all().flatMap((row) => {
        const session = SessionSchema.safeParse(row).data
        return session ? [[session.id, session] as const] : []
      }))
      const calls = db.prepare(
        `SELECT session_id, node_id, created_at,
                CASE WHEN json_valid(chat_message) THEN json_extract(chat_message,
                  '$.metadata.request_id', '$.metadata.created_at', '$.metadata.generation_model', '$.metadata.metrics') END AS call
         FROM message_nodes
         WHERE row_id BETWEEN ? AND ? AND instr(chat_message, '"input_tokens"') > 0`
      )
      for (let start = from; start <= last; start += ROWS_PER_READ) {
        for (const row of calls.iterate(start, Math.min(last, start + ROWS_PER_READ - 1))) {
          const parsed = RowSchema.safeParse(row).data
          const event = parsed && devinEvent(scan.source, parsed, sessions)
          if (event) scan.record(event)
        }
        await yieldToMain()
      }
      return last
    } finally {
      db.close()
    }
  })
}

/** The highest `row_id` the store has given out, though its row may be gone. */
function lastRow(db: DatabaseSync): number | undefined {
  const query = "SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'message_nodes'), (SELECT max(row_id) FROM message_nodes)) AS last"
  return LastRowSchema.safeParse(db.prepare(query).get()).data?.last ?? undefined
}

/** The first row added at or after `since` (epoch ms); `created_at` is in seconds. */
function firstRowSince(db: DatabaseSync, since: number, last: number): number {
  const at = db.prepare("SELECT row_id, created_at FROM message_nodes WHERE row_id >= ? ORDER BY row_id LIMIT 1")
  const probe = (row: number) => {
    const found = at.get(row)
    return { row: Number(found?.row_id ?? last + 1), created: Number(found?.created_at ?? Number.POSITIVE_INFINITY) }
  }
  const sinceSeconds = Math.floor(since / 1000)
  let low = 0
  let high = last + 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const { row, created } = probe(middle)
    if (created >= sinceSeconds) high = middle
    else low = row + 1
  }
  return low
}

function devinEvent(source: string, row: z.infer<typeof RowSchema>, sessions: ReadonlyMap<string, z.infer<typeof SessionSchema>>): UsageEvent | undefined {
  const fields = row.call === null ? undefined : CallFields.safeParse(JSON.parse(row.call)).data
  const [request, written, model, metrics] = fields ?? []
  const call = DevinStoredCall.safeParse({ request_id: request, created_at: written, generation_model: model, metrics }).data
  if (!call) return undefined
  const counts = usageCounts(devinStoredTokens(call.metrics))
  if (tokenTotal(counts) === 0) return undefined
  const session = sessions.get(row.session_id)
  const writtenAt = Date.parse(call.created_at ?? "")
  return {
    ...counts,
    // A call is kept in several rows, and a fork copies it into another session, always with its request id.
    // A node saved again keeps its node_id, not its row_id.
    key: `${source}:${call.request_id ?? `${row.session_id}:${row.node_id}`}`,
    source,
    session: row.session_id,
    timestamp: new Date(Number.isFinite(writtenAt) ? writtenAt : (row.created_at ?? 0) * 1000).toISOString(),
    model: call.generation_model ?? session?.model ?? "unknown",
    cwd: session?.working_directory ?? "unknown",
  }
}

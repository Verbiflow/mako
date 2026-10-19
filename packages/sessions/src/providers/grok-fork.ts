import { z } from "zod"
import type { ForkIds, RecordFork } from "../harness-records.js"
import { replaceQuoted, rootAndBelow, uuidFrom } from "../record-fork.js"

/**
 * A Grok session written again as its own fork, as Grok writes one: the
 * session's folder copied beside it under the new id, each record naming
 * the new session (an update's `sessionId`; an event id that only starts
 * with the old one is kept, as Grok keeps it), and `summary.json` saying
 * it's a fork of the session (`parent_session_id`, `forked_at`,
 * `session_kind`). Its subagents' sessions, elsewhere in the tree, stay the
 * source's.
 */
export const grokFork: RecordFork = {
  id: (seed, from) => uuidFrom(seed, 7, from),
  file(path, ids) {
    const { root, below } = rootAndBelow(path)
    const parts = below.split("/")
    if (parts[0] !== "sessions" || parts.length < 4) return null
    if (parts[2] !== ids.from) return "shared"
    const moved = `${root}:${["sessions", parts[1], ids.to, ...parts.slice(3)].join("/")}`
    if (parts.length === 4 && parts[3] === "summary.json") return { path: moved, whole: (bytes) => forkedSummary(bytes, ids) }
    if (below.endsWith(".jsonl")) return { path: moved, line: (line) => replaceQuoted(line, ids.from, ids.to) }
    return { path: moved, whole: (bytes) => replaceQuoted(bytes, ids.from, ids.to) }
  },
  table: () => null,
}

const SummarySchema = z.object({
  info: z.object({ id: z.string() }).loose().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
}).loose()
/** Every field as Grok wrote it, in its order. */
const Fields = z.record(z.string(), z.unknown())

/** `summary.json` as Grok writes a fork's: its id, the session it was forked from, and when; the time is the source's last update, so the same restore writes the same file. */
function forkedSummary(bytes: Buffer, ids: ForkIds): Buffer {
  let raw: unknown
  try {
    raw = JSON.parse(bytes.toString("utf8"))
  } catch {
    return replaceQuoted(bytes, ids.from, ids.to)
  }
  const parsed = SummarySchema.safeParse(raw)
  const fields = Fields.safeParse(raw)
  if (!parsed.success || !fields.success) return replaceQuoted(bytes, ids.from, ids.to)
  // Spread from what Grok wrote, so its fields keep their order and the fork's own land where Grok puts them.
  const forked = {
    ...fields.data,
    ...parsed.data.info && { info: { ...parsed.data.info, id: ids.to } },
    parent_session_id: ids.from,
    forked_at: parsed.data.updated_at ?? parsed.data.created_at ?? null,
    session_kind: "fork",
  }
  const text = JSON.stringify(forked, null, 2)
  return Buffer.from(bytes[bytes.length - 1] === 0x0a ? `${text}\n` : text)
}

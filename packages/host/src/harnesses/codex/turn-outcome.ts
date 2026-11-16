import { z } from "zod"
import { readTurnFile, type NativeTurnReader } from "../native-turn.js"

const Record = z.object({ type: z.string(), payload: z.object({ id: z.string().optional(), type: z.string().optional(), turn_id: z.string().optional(), error: z.unknown().optional() }).optional() })

/** Codex turn/start's ID is the rollout's turn_id, not the user-message ID. */
export const readCodexTurn: NativeTurnReader = async ({ binding, runId }) => {
  if (!binding.nativeId || !binding.path) return { kind: "unavailable", reason: "The native turn has no source." }
  let session: string | undefined
  let found = false
  let completed = false
  let ambiguous = false
  let following: string | undefined
  const read = await readTurnFile(binding.path, Record, (record) => {
    if (record.type === "history_base") ambiguous = true
    const payload = record.payload
    if (!payload) return
    if (record.type === "session_meta") {
      if (session !== undefined) ambiguous = true
      session = payload.id
    }
    if (record.type !== "event_msg") return
    const type = payload["type"]
    const turn = payload["turn_id"]
    if (type === "thread_rolled_back") ambiguous = true
    if (type === "task_started" || type === "turn_started") {
      if (found && turn !== runId) ambiguous = true
      following = turn
      if (turn === runId) { if (found) ambiguous = true; found = true }
    }
    if (turn !== runId) return
    if (type === "task_complete" || type === "turn_complete") {
      if (!found || following !== runId || payload["error"]) ambiguous = true
      else completed = true
    }
    // An explicit native abort may have been a person's Stop in another app.
    if (type === "turn_aborted") ambiguous = true
  })
  if (read === "unavailable" || (read === "read" && session !== binding.nativeId)) return { kind: "unavailable", reason: "The native source could not be read consistently." }
  if (read === "unknown") return { kind: "unknown", reason: "The source was verified, but a bounded scan cannot prove this turn completed." }
  if (!found || ambiguous) return { kind: "unknown", reason: "The native source was read, but this turn has no unambiguous outcome." }
  return { kind: completed ? "completed" : "unfinished" }
}

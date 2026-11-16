import { z } from "zod"
import { readTurnFile, type NativeTurnReader } from "../native-turn.js"

const Record = z.object({
  type: z.string(), uuid: z.string().optional(), parentUuid: z.string().nullable().optional(),
  sessionId: z.string().optional(), isSidechain: z.boolean().optional(), explicit: z.boolean().optional(),
  isApiErrorMessage: z.boolean().optional(), supersedes: z.array(z.string()).optional(),
  message: z.object({ stop_reason: z.string().nullable().optional(), content: z.unknown() }).optional(),
})
const ToolResults = z.array(z.object({ type: z.literal("tool_result") }).loose()).min(1)

/** Claude's retained run ID is the UUID of the submitted user message. */
export const readClaudeTurn: NativeTurnReader = async ({ binding, runId }) => {
  if (!binding.nativeId || !binding.path) return { kind: "unavailable", reason: "The native turn has no source." }
  const descendants = new Set<string>()
  let session = false
  let found = false
  let completed = false
  let ambiguous = false
  const read = await readTurnFile(binding.path, Record, (record) => {
    if (record.isSidechain) return
    if (record.sessionId === binding.nativeId) session = true
    if (record.type === "last-prompt" && record.explicit) ambiguous = true
    if (record.type !== "user" && record.type !== "assistant") return
    if (record.uuid === runId) {
      if (found || record.type !== "user" || record.sessionId !== binding.nativeId) ambiguous = true
      found = true
      descendants.add(runId)
      return
    }
    if (!found) return
    if (record.sessionId !== binding.nativeId || !record.uuid || !record.parentUuid || !descendants.has(record.parentUuid)) {
      ambiguous = true
      return
    }
    descendants.add(record.uuid)
    if (descendants.size > 100_000 || record.isApiErrorMessage || record.supersedes?.length) ambiguous = true
    if (record.type === "user" && !ToolResults.safeParse(record.message?.content).success) ambiguous = true
    if (record.type === "assistant") {
      const stop = record.message?.stop_reason
      if (stop !== "end_turn" && stop !== "tool_use") ambiguous = true
      completed = stop === "end_turn"
    }
  })
  if (read === "unavailable" || (read === "read" && !session)) return { kind: "unavailable", reason: "The native source could not be verified." }
  if (read === "unknown") return { kind: "unknown", reason: "The source was verified, but a bounded scan cannot prove this turn completed." }
  if (!found || ambiguous) return { kind: "unknown", reason: "The source was read, but the exact turn or its active branch has no unambiguous outcome." }
  return { kind: completed ? "completed" : "unfinished" }
}

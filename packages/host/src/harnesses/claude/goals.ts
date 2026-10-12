import { open } from "node:fs/promises"
import { z } from "zod"
import { GOAL_OBJECTIVE_LIMIT, type GoalObservation } from "../../contracts/live-goals.js"

const GoalStatusRecord = z.object({
  type: z.literal("attachment"),
  attachment: z.object({
    type: z.literal("goal_status"),
    met: z.boolean(),
    failed: z.boolean().optional(),
    /** Written when `/goal` sets the goal (`met: false`) or clears it (`met: true`). */
    sentinel: z.boolean().optional(),
    condition: z.string(),
    reason: z.string().optional(),
    iterations: z.number().int().nonnegative().optional(),
    durationMs: z.number().nonnegative().optional(),
    tokens: z.number().nonnegative().optional(),
  }),
})
type GoalStatus = z.infer<typeof GoalStatusRecord>["attachment"]

const tailBytes = 4 * 1024 * 1024

/**
 * The goal Claude Code's newest `goal_status` record describes: null when it
 * cleared the goal or the transcript has none, undefined when the record may
 * lie before the part read or the file can't be read.
 */
export async function readClaudeGoal(path: string): Promise<GoalObservation | null | undefined> {
  const file = await open(path, "r").catch(() => undefined)
  if (!file) return undefined
  try {
    const { size } = await file.stat()
    const offset = Math.max(0, size - tailBytes)
    const buffer = Buffer.alloc(size - offset)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
    const lines = buffer.toString("utf8", 0, bytesRead).split("\n")
    if (offset) lines.shift()
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!
      if (!line.includes("\"goal_status\"")) continue
      const record = goalStatusRecord(line)
      if (record) return claudeGoal(record.attachment)
    }
    return offset ? undefined : null
  } catch {
    return undefined
  } finally {
    await file.close()
  }
}

function goalStatusRecord(line: string): z.infer<typeof GoalStatusRecord> | undefined {
  try {
    const record = GoalStatusRecord.safeParse(JSON.parse(line))
    return record.success ? record.data : undefined
  } catch {
    return undefined
  }
}

function claudeGoal(status: GoalStatus): GoalObservation | null {
  if (status.met && status.sentinel) return null
  const objective = status.condition.slice(0, GOAL_OBJECTIVE_LIMIT)
  if (!objective.trim()) return null
  const reason = status.reason?.slice(0, 4_000) || undefined
  const spent = {
    turns: status.iterations,
    tokensUsed: status.tokens,
    seconds: status.durationMs === undefined ? undefined : Math.round(status.durationMs / 1000),
  }
  if (status.failed) return { objective, status: "blocked", note: reason ?? "Claude found the goal can't be met.", ...spent }
  return { objective, status: status.met ? "complete" : "active", note: reason, ...spent }
}

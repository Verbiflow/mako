import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
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

/** A user message's words: its content as a string, or its first text block. */
const MessageText = z.string()
  .or(z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).transform((parts) => parts.find((part) => part.type === "text")?.text))

/** The words that make `/goal <word>` clear the goal (Claude Code 2.1.290). */
const CLEARING = new Set(["clear", "stop", "off", "reset", "none", "cancel"])

/** The condition a `/goal` line sets, null when it clears the goal, undefined when it only asks where the goal stands. */
export function claudeGoalLine(text: string): string | null | undefined {
  const condition = /^\/goal(?:\s+([\s\S]*))?$/.exec(text.trim())?.[1]?.trim()
  if (!condition) return undefined
  return CLEARING.has(condition.toLowerCase()) ? null : condition
}

/**
 * Claude's Stop hook finding the goal not yet met, as the turn streams it:
 * the synthetic message `Stop hook feedback:\n[<condition>]: <reason>` that
 * sends Claude back to work, one per hook. Claude writes the matching
 * `goal_status` record by the turn's result, so this is the only report
 * while the turn runs.
 */
export function claudeGoalFeedback(message: SDKMessage, condition: string): GoalObservation | undefined {
  if (message.type !== "user" || !message.isSynthetic) return undefined
  const text = MessageText.safeParse(message.message.content).data
  const prefix = `Stop hook feedback:\n[${condition}]: `
  if (!text?.startsWith(prefix)) return undefined
  return claudeGoal({ type: "goal_status", met: false, condition, reason: text.slice(prefix.length) }) ?? undefined
}

import { z } from "zod"
import type { JsonObject } from "../../codex-app-json.js"
import { fromInclusiveCounts, type UsageObservation } from "../../session-usage.js"

const count = z.number().nonnegative().optional().catch(undefined)

/**
 * Devin's `usage_update._meta`, recorded against Devin 2026.10: the call's
 * `cognition.ai/inputTokens` (cached input included), `outputTokens` and,
 * once the cache is warm, `cachedReadTokens`. Devin repeats the main agent's
 * reading with `cognition.ai/subagent_context` set; that copy, like a
 * subagent's own reading, stays out of the main session's meter.
 */
const DevinUsageMeta = z.object({
  "cognition.ai/inputTokens": count,
  "cognition.ai/outputTokens": count,
  "cognition.ai/cachedReadTokens": count,
  "cognition.ai/cacheWriteTokens": count,
  "cognition.ai/subagent_context": z.unknown().optional(),
})

export function devinUsageUpdate(meta: JsonObject | undefined): UsageObservation[] | null {
  const parsed = DevinUsageMeta.safeParse(meta ?? {})
  if (!parsed.success) return []
  const read = parsed.data
  if (read["cognition.ai/subagent_context"] !== undefined) return null
  const input = read["cognition.ai/inputTokens"]
  const output = read["cognition.ai/outputTokens"]
  if (input === undefined || output === undefined) return []
  return [{
    kind: "spent",
    tokens: fromInclusiveCounts({
      input,
      cacheRead: read["cognition.ai/cachedReadTokens"],
      cacheWrite: read["cognition.ai/cacheWriteTokens"],
      output,
    }),
  }]
}

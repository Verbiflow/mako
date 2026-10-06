import { z } from "zod"
import type { JsonObject } from "../../codex-app-json.js"
import { fromInclusiveCounts, type UsageObservation } from "../../session-usage.js"
import type { AcpUsageReading } from "../acp-source.js"

const count = z.number().nonnegative().optional().catch(undefined)

/**
 * Devin's `usage_update._meta`, recorded against Devin 2026.10: the call's
 * `cognition.ai/inputTokens` (cached input included), `outputTokens` and,
 * once the cache is warm, `cachedReadTokens` and `cachedWriteTokens` (spelled so
 * in Devin 3000.10.23's binary). Each main-agent reading comes
 * twice, the second with `cognition.ai/subagent_context.parentAgentId` set
 * to `root`; a subagent's own call comes once, with its own agent id there.
 */
const DevinUsageMeta = z.object({
  "cognition.ai/inputTokens": count,
  "cognition.ai/outputTokens": count,
  "cognition.ai/cachedReadTokens": count,
  "cognition.ai/cachedWriteTokens": count,
  "cognition.ai/subagent_context": z.object({ parentAgentId: z.string().min(1) }).optional().catch(undefined),
})

const ROOT_AGENT = "root"

export function devinUsageUpdate(meta: JsonObject | undefined): AcpUsageReading {
  const parsed = DevinUsageMeta.safeParse(meta ?? {})
  if (!parsed.success) return { of: "agent", observations: [] }
  const read = parsed.data
  const tagged = meta !== undefined && Object.hasOwn(meta, "cognition.ai/subagent_context")
  const parent = read["cognition.ai/subagent_context"]?.parentAgentId
  if (tagged && (parent === undefined || parent === ROOT_AGENT)) return { of: "repeat" }
  const input = read["cognition.ai/inputTokens"]
  const output = read["cognition.ai/outputTokens"]
  const observations: UsageObservation[] = input === undefined || output === undefined ? [] : [{
    kind: "spent",
    tokens: fromInclusiveCounts({
      input,
      cacheRead: read["cognition.ai/cachedReadTokens"],
      cacheWrite: read["cognition.ai/cachedWriteTokens"],
      output,
    }),
  }]
  return { of: parent === undefined ? "agent" : "subagent", observations }
}

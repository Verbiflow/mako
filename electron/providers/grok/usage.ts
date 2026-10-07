import { GrokCallUsage, grokCallTokens, grokCost, grokTokens, GrokTurnUsage, grokUnrecorded } from "@mako/sessions/harnesses"
import { z } from "zod"
import type { JsonObject } from "../../codex-app-json.js"
import type { UsageObservation } from "../../session-usage.js"

const count = z.number().nonnegative()
const ResponseCompleted = z.object({ usage: GrokCallUsage })
const TurnCompleted = z.object({ usage: GrokTurnUsage })
const CompactStarted = z.object({ tokens_used: count, context_window: count })
const CompactCompleted = z.object({ tokens_after: count })

/** What one of Grok's session updates says about usage; `undefined` for one that says nothing. */
export function grokUsage(sessionUpdate: string, update: JsonObject): UsageObservation[] | undefined {
  switch (sessionUpdate) {
    case "response_completed": {
      const usage = ResponseCompleted.safeParse(update).data?.usage
      return usage && [{ kind: "call", tokens: grokCallTokens(usage) }]
    }
    case "turn_completed": {
      const usage = TurnCompleted.safeParse(update).data?.usage
      if (!usage) return undefined
      const observations: UsageObservation[] = [{ kind: "spent", tokens: grokTokens(usage) }]
      const cost = grokCost(usage)
      if (cost) observations.push({ kind: "costSpent", amount: cost, currency: "USD" })
      const unrecorded = grokUnrecorded(usage)
      if (unrecorded) observations.push({ kind: "unrecorded", of: unrecorded })
      return observations
    }
    case "auto_compact_started": {
      const reading = CompactStarted.safeParse(update).data
      return reading && reading.context_window ? [{ kind: "context", used: reading.tokens_used, size: reading.context_window }] : undefined
    }
    case "auto_compact_completed": {
      const reading = CompactCompleted.safeParse(update).data
      return [{ kind: "compacted", after: reading?.tokens_after }]
    }
    default:
      return undefined
  }
}

const ModelsUpdate = z.object({
  currentModelId: z.string(),
  availableModels: z.array(z.object({
    modelId: z.string(),
    _meta: z.object({ totalContextTokens: z.number().positive() }).partial().nullish(),
  })),
})

/** `_x.ai/models/update`: the window of the model the session now answers with. */
export function grokModelWindow(params: JsonObject): number | undefined {
  const parsed = ModelsUpdate.safeParse(params).data
  return parsed?.availableModels.find((model) => model.modelId === parsed.currentModelId)?._meta?.totalContextTokens
}

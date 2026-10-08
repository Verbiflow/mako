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

const window = z.number().int().positive()
const ModelList = z.object({
  currentModelId: z.string(),
  availableModels: z.array(z.object({
    modelId: z.string(),
    _meta: z.object({ totalContextTokens: window, contextWindow: window, contextWindows: z.array(window) }).partial().nullish(),
  })),
})

/**
 * The current model's window in Grok's model list (`models` in the reply that
 * opens a session, and `_x.ai/models/update`): the window chosen for it when
 * it offers that one, else its default, as Grok's own client reads it
 * (`ModelState::get_context_window`).
 */
export function grokModelWindow(models: JsonObject): number | undefined {
  const parsed = ModelList.safeParse(models).data
  const meta = parsed?.availableModels.find((model) => model.modelId === parsed.currentModelId)?._meta
  if (!meta) return undefined
  const chosen = meta.contextWindow
  return chosen && (chosen === meta.totalContextTokens || meta.contextWindows?.includes(chosen)) ? chosen : meta.totalContextTokens
}

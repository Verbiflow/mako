import { z } from "zod"
import type { JsonObject } from "../../codex-app-json.js"
import { fromInclusiveCounts, type UsageObservation } from "../../session-usage.js"

/** Grok's cost unit: its own documentation says 1 USD is 10^10 ticks. */
export const GROK_TICKS_PER_USD = 10_000_000_000

const count = z.number().nonnegative()

/**
 * One model call, from `response_completed` (grok 1.0.44). Anthropic-style:
 * `input_tokens` leaves out what the cache supplied.
 */
const ResponseCompleted = z.object({
  usage: z.object({
    input_tokens: count,
    output_tokens: count,
    cache_read_input_tokens: count.optional(),
    cache_creation_input_tokens: count.optional(),
    reasoning_tokens: count.optional(),
  }),
})

/** One turn's spend, from `turn_completed`. OpenAI-style: `inputTokens` includes cached input. */
const TurnCompleted = z.object({
  usage: z.object({
    inputTokens: count,
    outputTokens: count,
    cachedReadTokens: count.optional(),
    cacheCreationTokens: count.optional(),
    reasoningTokens: count.optional(),
    costUsdTicks: count.optional(),
  }),
})

const CompactStarted = z.object({ tokens_used: count, context_window: count })
const CompactCompleted = z.object({ tokens_after: count })

/** What one of Grok's session updates says about usage; `undefined` for one that says nothing. */
export function grokUsage(sessionUpdate: string, update: JsonObject): UsageObservation[] | undefined {
  switch (sessionUpdate) {
    case "response_completed": {
      const usage = ResponseCompleted.safeParse(update).data?.usage
      if (!usage) return undefined
      const tokens = {
        input: usage.input_tokens,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
        output: usage.output_tokens,
      }
      return [{ kind: "call", tokens: usage.reasoning_tokens ? { ...tokens, reasoning: usage.reasoning_tokens } : tokens }]
    }
    case "turn_completed": {
      const usage = TurnCompleted.safeParse(update).data?.usage
      if (!usage) return undefined
      const observations: UsageObservation[] = [{
        kind: "spent",
        tokens: fromInclusiveCounts({
          input: usage.inputTokens,
          cacheRead: usage.cachedReadTokens,
          cacheWrite: usage.cacheCreationTokens,
          output: usage.outputTokens,
          reasoning: usage.reasoningTokens,
        }),
      }]
      if (usage.costUsdTicks) observations.push({ kind: "costSpent", amount: usage.costUsdTicks / GROK_TICKS_PER_USD, currency: "USD" })
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

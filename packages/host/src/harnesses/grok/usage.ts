import { GrokCallUsage, grokCallTokens, grokCost, grokTokens, GrokTurnUsage, grokUnrecorded, grokWakingChild, GrokWokenSpend } from "@mako/sessions/harnesses"
import { z } from "zod"
import { objectValue, stringValue } from "../../base/json-values.js"
import type { JsonObject } from "../../contracts/json.js"
import type { AcpChildSpend } from "../acp-source.js"
import type { UsageObservation } from "../session-usage.js"

/**
 * What of each notification's spend a Grok session counts, for one launch
 * (`GrokWokenSpend`). Grok sends a subagent's `turn_completed` on its
 * parent's connection under the subagent's own session, which it names as it
 * spawns it (`subagent_spawned`): that turn is held, the parent's own turn
 * ending drops what it ran beside (its count holds them), and a
 * `subagent_finished` that will wake the parent counts what was held with the
 * parent's next turn.
 */
export function grokChildSpend(): AcpChildSpend {
  const children = new Set<string>()
  const spend = new GrokWokenSpend<UsageObservation[]>()
  return {
    screen(params, usage) {
      const update = objectValue(params["update"])
      const child = stringValue(update?.["child_session_id"]) ?? stringValue(update?.["subagent_id"])
      switch (stringValue(update?.["sessionUpdate"])) {
        case "subagent_spawned":
          if (child) children.add(child)
          return usage
        case "subagent_finished":
          if (child) spend.finished(child, grokWakingChild(update) !== undefined)
          return usage
        case "turn_completed": {
          const session = stringValue(params["sessionId"])
          if (session && children.has(session)) {
            if (usage?.length) spend.childTurn(session, usage)
            return undefined
          }
          const woken = spend.parentTurn().flat()
          return woken.length ? [...usage ?? [], ...woken] : usage
        }
        default:
          return usage
      }
    },
  }
}

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

import type { UsageUpdate } from "@agentclientprotocol/sdk"
import { z } from "zod"
import type { JsonObject } from "./codex-app-json.js"
import type { AcpNotificationDecoding, AcpUsageReading, ProviderAcpSource } from "./providers/acp-source.js"
import type { UsageObservation } from "./session-usage.js"

/**
 * What an ACP agent's usage reports tell the session's meter, read the same
 * way by the live client and by a recorded session replayed through its
 * decoder: ACP's own `usage_update`, the spend a vendor notification carries,
 * and the window a model list names.
 */

/** A `usage_update`'s `_meta`, as the harness's own reader takes it. */
const UsageMetaSchema = z.record(z.string(), z.json())

/** Whose reading a `usage_update` is, with ACP's used, size and cost added to an agent's own. */
export function acpUsageReading(source: ProviderAcpSource | undefined, update: UsageUpdate): AcpUsageReading {
  const read = source?.usageUpdate?.(UsageMetaSchema.safeParse(update._meta).data) ?? { of: "agent", observations: [] }
  if (read.of !== "agent") return read
  const observations: UsageObservation[] = [{ kind: "context", used: update.used, size: update.size }, ...read.observations]
  if (update.cost) observations.push({ kind: "cost", amount: update.cost.amount, currency: update.cost.currency })
  return { of: "agent", observations }
}

/** A vendor notification's spend, with a compaction it reports resetting the context. */
export function acpNotificationUsage(decoded: AcpNotificationDecoding): UsageObservation[] {
  const compacted = decoded.notices?.flatMap((notice): UsageObservation[] =>
    notice.kind === "compacted" ? [{ kind: "compacted", after: notice.compaction?.tokensAfter }] : []) ?? []
  return [...compacted, ...decoded.usage ?? []]
}

const ModelListSchema = z.object({ models: z.record(z.string(), z.json()).nullish() })

/**
 * The session's model list and the window its current model has, for an
 * agent whose source reads windows from the list (`modelWindow`). The reply
 * that opens the session, a model switch and a new list each move it.
 */
export class AcpModelWindow {
  private models: JsonObject | undefined
  private readonly source: ProviderAcpSource | undefined
  constructor(source: ProviderAcpSource | undefined) {
    this.source = source
  }

  /** The reply to `session/new` or `session/load`. */
  opened(reply: JsonObject): UsageObservation[] {
    const models = ModelListSchema.safeParse(reply).data?.models
    if (!models) return []
    this.models = models
    return this.read()
  }

  /** A new list replaces the models on offer; its `currentModelId` is the default for new sessions, so this one keeps its own. */
  relisted(models: JsonObject): UsageObservation[] {
    const current = this.models?.["currentModelId"]
    this.models = current === undefined ? models : { ...models, currentModelId: current }
    return this.read()
  }

  switched(modelId: string): UsageObservation[] {
    if (!this.models) return []
    this.models = { ...this.models, currentModelId: modelId }
    return this.read()
  }

  private read(): UsageObservation[] {
    const size = this.models && this.source?.modelWindow?.(this.models)
    return size ? [{ kind: "window", size }] : []
  }
}

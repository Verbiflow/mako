import type { UsageUpdate } from "@agentclientprotocol/sdk"
import { z } from "zod"
import type { AcpNotificationDecoding, AcpUsageReading, ProviderAcpSource } from "./providers/acp-source.js"
import type { UsageObservation } from "./session-usage.js"

/**
 * What an ACP agent's usage reports tell the session's meter, read the same
 * way by the live client and by a recorded session replayed through its
 * decoder: ACP's own `usage_update`, and the spend a vendor notification carries.
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

import { z } from "zod"
import type { HostEvent } from "./host-events-boot.js"

/** Private socket only. A new stream starts full until its own generation opts in. */
export const LOCAL_CONTENT_HEADER = "x-mako-content-generation"
export const LOCAL_CONTENT_CHANNEL = "mako:local-content-watch"
export const LOCAL_CONTENT_LIMIT = 4096
export const LocalContentIdsSchema = z.array(z.string().min(1).max(256)).max(LOCAL_CONTENT_LIMIT).nullable()
export const LocalContentWatchSchema = z.object({
  generation: z.uuid(),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** null returns to the full stream, including when the union exceeds its bound. */
  conversations: LocalContentIdsSchema,
}).strict()
export type LocalContentWatch = z.infer<typeof LocalContentWatchSchema>
export const LocalContentReceiptSchema = z.object({ generation: z.uuid(), sequence: z.number().int().positive() })

/** Keep all ordered metadata. Only local opted-in recipients may receive this marker. */
export function withoutLiveContent(event: Extract<HostEvent, { type: "live-batch" }>): HostEvent {
  const strip = <T extends { updates: unknown[]; base?: unknown }>(batch: T) => {
    const metadata = { ...batch, updates: [], contentOmitted: true as const }
    delete metadata.base
    return metadata
  }
  return { ...event, batch: strip(event.batch),
    ...(event.compact && { compact: strip(event.compact) }),
    ...(event.rostered && { rostered: strip(event.rostered) }) }
}

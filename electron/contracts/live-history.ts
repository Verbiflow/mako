import { z } from "zod"
import type { ThreadPage } from "@mako/sessions"
import type { LiveBlock } from "./live-content.js"
import type { LiveSnapshot } from "./live-conversations.js"

export const LiveHistoryCursorSchema = z.object({
  blocks: z.number().int().nonnegative(),
  base: z.number().int().nonnegative(),
})
export type LiveHistoryCursor = z.infer<typeof LiveHistoryCursorSchema>

export const LiveHistoryAddressSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("live"), index: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("base"), entry: z.number().int().nonnegative(), block: z.number().int().nonnegative() }),
])
export type LiveHistoryAddress = z.infer<typeof LiveHistoryAddressSchema>

export const LiveHistoryReadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), from: LiveHistoryCursorSchema.optional(), epoch: z.string().optional(),
    ifCurrent: z.object({ token: z.string().uuid(), revision: z.number().int().nonnegative() }).optional() }),
  z.object({ kind: z.literal("earlier"), token: z.string().uuid(), before: LiveHistoryCursorSchema }),
  z.object({ kind: z.literal("detail"), token: z.string().uuid(), at: LiveHistoryAddressSchema }),
  z.object({ kind: z.literal("part"), record: z.string().uuid(), offset: z.number().int().nonnegative() }),
])
export type LiveHistoryRead = z.infer<typeof LiveHistoryReadSchema>
export type LiveHistorySnapshot = LiveSnapshot | { kind: "unchanged"; token: string; revision: number; epoch: string } | null

/** One immutable view of retained history. These coordinates are absolute;
 * renderer arrays are windows, never journal indexes. */
export interface LiveHistoryWindow {
  token: string
  blockStart: number
  blockEnd: number
  turnStart: number
  /** Requests whose user turn is retained before `blockStart`, whether the
   * native base now shows it or its page is not loaded. They are on screen
   * even though no delivered block carries their id. */
  earlierRequests: string[]
  before: LiveHistoryCursor | null
}

/** Earlier pages carry content only, never a second copy of old controls. */
export interface LiveHistoryPage {
  blocks: LiveBlock[]
  base: ThreadPage | null
  history: LiveHistoryWindow
}

/** Even one giant native block/control value travels in bounded frames.
 * Parts belong to a captured record; fetching them never repeats an operation. */
export interface LiveHistoryChunk {
  record: string
  offset: number
  /** Known once the final part is reached; no complete serialization is needed up front. */
  total?: number
  data: string
  next: number | null
}

// A JSON-escaped frame is at most ~1.6 MiB, including pathological strings.
export const LIVE_HISTORY_CHUNK_CHARS = 256 * 1024

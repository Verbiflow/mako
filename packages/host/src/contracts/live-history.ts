import { z } from "zod"
import type { ThreadPage } from "@mako/sessions"
import type { LiveSnapshot } from "./live-conversations.js"
import type { Entry } from "@mako/sessions/entries"

export const LiveHistoryCursorSchema = z.object({
  blocks: z.number().int().nonnegative(),
  base: z.number().int().nonnegative(),
})
export type LiveHistoryCursor = z.infer<typeof LiveHistoryCursorSchema>

export const LiveHistoryAddressSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("live"), index: z.number().int().nonnegative() }),
  /** A saved entry of the capture's native base, by its id. */
  z.object({ kind: z.literal("base"), id: z.string() }),
])
export type LiveHistoryAddress = z.infer<typeof LiveHistoryAddressSchema>

export const LiveHistoryReadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), from: LiveHistoryCursorSchema.optional(), epoch: z.string().optional(),
    ifCurrent: z.object({ token: z.string().uuid(), revision: z.number().int().nonnegative() }).optional() }),
  z.object({ kind: z.literal("earlier"), token: z.string().uuid(), before: LiveHistoryCursorSchema }),
  z.object({ kind: z.literal("range"), token: z.string().uuid(), from: LiveHistoryCursorSchema, to: LiveHistoryCursorSchema }),
  z.object({ kind: z.literal("detail"), token: z.string().uuid(), at: LiveHistoryAddressSchema }),
  /** The bytes an entry of the view was read from (`EntryOriginal`): its record's, and the stream lines it names. */
  z.object({ kind: z.literal("original"), token: z.string().uuid(), at: LiveHistoryAddressSchema }),
  z.object({ kind: z.literal("part"), record: z.string().uuid(), offset: z.number().int().nonnegative() }),
])
export type LiveHistoryRead = z.infer<typeof LiveHistoryReadSchema>
export type LiveHistorySnapshot = LiveSnapshot | { kind: "unchanged"; token: string; revision: number; epoch: string } | null

/** One immutable view of retained history. These coordinates are absolute;
 * renderer arrays are windows, never journal indexes. */
export interface LiveHistoryWindow {
  token: string
  /** Old hosts page earlier history but cannot reload arbitrary released turns. */
  ranges?: true
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
  blocks: Entry[]
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

/** What a read against a view the host let go says; a window reads the conversation again and retries against the new view. */
export const HISTORY_VIEW_EXPIRED = "This history view expired. Open the conversation again to refresh it."
/** A read against a view or a read the host let go, or against history the native session rewrote: reading again repairs it. */
export function isHistoryExpired(error: Error): boolean {
  return /history (?:view|read) expired|native history changed/.test(error.message)
}

import type { Entry } from "@mako/sessions/entries"
import type { LiveBatch } from "../contracts/live-conversations.js"

/** From this many characters an answer being written goes out at a reader's pace, not every frame. */
export const LONG_ANSWER_CHARS = 1_500
/** How long a long answer's words may wait for the next batch, unless a paragraph ends first. */
export const LONG_ANSWER_FLUSH_MS = 400

/**
 * How long after its last flush a conversation's pending changes go out. A frame (`frame`), as ever, unless all that
 * waits is the answer being written going on: text added to the last block, nothing else of the conversation changed,
 * no paragraph ended in it, and the answer already `LONG_ANSWER_CHARS` long. Then `LONG_ANSWER_FLUSH_MS`.
 *
 * Every batch carries the same envelope (the conversation, its revision and epoch, the update's frames) whatever it
 * says, so a long answer sent each 50 ms frame was mostly envelope: 156 bytes a token to a phone, 7 of them its words.
 * Nobody reads a long answer word by word as it lands, and a window draws one at this pace anyway; its first words, a
 * short answer, a paragraph's end and anything else still go each frame.
 */
export function flushFrameMs(frame: number, blocks: readonly Entry[], updates: LiveBatch["updates"], conversationChanged: boolean): number {
  if (conversationChanged || !updates.length) return frame
  const last = blocks.at(-1)
  if (last?.type !== "text") return frame
  let pending = ""
  for (const update of updates) {
    if (update.kind !== "text" || update.replace || (update.id !== undefined && update.id !== last.id)) return frame
    pending += update.text
  }
  if (`${last.text.slice(-1)}${pending}`.includes("\n\n")) return frame
  return last.text.length + pending.length >= LONG_ANSWER_CHARS ? LONG_ANSWER_FLUSH_MS : frame
}

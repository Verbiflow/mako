import { z } from "zod"

/**
 * One message's identity in its provider's store, taken when a transcript was
 * read so the same message can be found again after the store moved.
 *
 * A fork or rewind names a message, not a position: an index into a native
 * file is right only for the bytes it was read from, and a CLI that is still
 * running, Claude appending `cost-state` on exit, or Cursor Desktop writing
 * on every keystroke all move those bytes. The index stays as the hint the
 * unchanged case resolves at once; the entry's id, which a view always
 * gives and takes from the record (the harness's own item id, else the
 * record's place), finds it when the store grew or was rewritten, and the
 * timestamp does the same for an entry of an older capture without one. An
 * answer is anchored by its last entry, so what ends at it is the whole
 * answer.
 */
export const MessageAnchorSchema = z.object({
  /** The entry's index in the history when the anchor was taken. */
  index: z.number().int().nonnegative(),
  /** The entry's id. */
  id: z.string().optional(),
  /** The entry's time in epoch milliseconds, when its record gives one. */
  at: z.number().optional(),
})
export type MessageAnchor = z.infer<typeof MessageAnchorSchema>

interface Anchored {
  id?: string
  at?: number
}

/**
 * Find the anchored entry in a page of entries (`start` is the page's first
 * absolute index) and return its absolute index, or `undefined` when nothing
 * in the page is provably that entry. Only entries `matches` accepts count.
 *
 * The id is decisive. Without one, a timestamp identifies the entry unless
 * two share it, in which case the one at the remembered position wins and
 * the nearest otherwise. An entry with neither is only its position; that is
 * accepted while the entry there still matches, because a store without
 * identity is one Mako can only trust to append.
 */
export function resolveAnchor<Item extends Anchored>(
  entries: readonly Item[],
  start: number,
  anchor: MessageAnchor,
  matches: (entry: Item) => boolean = () => true
): number | undefined {
  if (anchor.id) {
    const found = entries.findIndex((entry) => entry.id === anchor.id && matches(entry))
    return found < 0 ? undefined : start + found
  }
  if (anchor.at) {
    const candidates: number[] = []
    entries.forEach((entry, offset) => {
      if (entry.at === anchor.at && matches(entry)) candidates.push(start + offset)
    })
    if (candidates.length === 0) return undefined
    if (candidates.length === 1) return candidates[0]
    return candidates.reduce((best, index) =>
      Math.abs(index - anchor.index) < Math.abs(best - anchor.index) ? index : best
    )
  }
  const positional = entries[anchor.index - start]
  return positional && matches(positional) ? anchor.index : undefined
}

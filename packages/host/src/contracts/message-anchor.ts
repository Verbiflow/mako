import { z } from "zod"

/**
 * One message's identity in its provider's store, taken when a transcript was
 * read so the same message can be found again after the store moved.
 *
 * A fork or rewind names a message, not a position: an index into a native
 * file is right only for the bytes it was read from, and a CLI that is still
 * running, Claude appending `cost-state` on exit, or Cursor Desktop writing
 * on every keystroke all move those bytes. The index stays as the hint the
 * unchanged case resolves at once; the provider's own message id (Claude's
 * uuid, Codex's response id, Cursor's exchange hash) finds the message when
 * the store grew or was rewritten, and the timestamp does the same for a
 * provider whose store gives no id.
 */
export const MessageAnchorSchema = z.object({
  /** The entry's index in the history when the anchor was taken. */
  index: z.number().int().nonnegative(),
  /** The provider's own id for the message, when its store records one. */
  id: z.string().optional(),
  /** The message's timestamp as the store wrote it, when it records one. */
  at: z.string().optional(),
})
export type MessageAnchor = z.infer<typeof MessageAnchorSchema>

interface Anchored {
  kind: string
  id?: string
  at?: string
}

/**
 * Find the anchored message in a page of entries (`start` is the page's first
 * absolute index) and return its absolute index, or `undefined` when nothing
 * in the page is provably that message.
 *
 * The id is decisive when the store gives one. Without an id, a timestamp
 * plus kind identifies the message unless two entries share the same
 * second, in which case the one at the remembered position wins and the
 * nearest otherwise. A message with neither is only its position; that is
 * accepted when the entry there is still the same kind, because a store
 * without message identity is one Mako can only trust to append.
 */
export function resolveAnchor(
  entries: readonly Anchored[],
  start: number,
  anchor: MessageAnchor,
  kind?: string
): number | undefined {
  const matchesKind = (entry: Anchored) => kind === undefined || entry.kind === kind
  if (anchor.id) {
    const found = entries.findIndex((entry) => entry.id === anchor.id && matchesKind(entry))
    return found < 0 ? undefined : start + found
  }
  if (anchor.at) {
    const candidates: number[] = []
    entries.forEach((entry, offset) => {
      if (entry.at === anchor.at && matchesKind(entry)) candidates.push(start + offset)
    })
    if (candidates.length === 0) return undefined
    if (candidates.length === 1) return candidates[0]
    return candidates.reduce((best, index) =>
      Math.abs(index - anchor.index) < Math.abs(best - anchor.index) ? index : best
    )
  }
  const positional = entries[anchor.index - start]
  return positional && matchesKind(positional) ? anchor.index : undefined
}

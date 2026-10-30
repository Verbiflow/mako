import { isDeepStrictEqual } from "node:util"
import type { ThreadPage } from "@mako/sessions"
import type { Entry } from "@mako/sessions/entries"

/** How long `sharedEntries` compares before it lets other work run. */
const COMPARE_SLICE_MS = 8

/**
 * `next` with each entry that says what `previous`'s entry at its index
 * says replaced by that entry's object; `next` itself when none is.
 *
 * A history read again is all new objects though it holds one turn more:
 * everything kept by identity (the journal's rows, the weights, the views
 * of the history reader) then took the whole of it as changed, and a
 * conversation of 150MB was written, weighed and held twice each turn.
 * Entries keep their place in a history read again, so they are matched
 * by index.
 */
export async function sharedEntries(previous: readonly Entry[], next: Entry[]): Promise<Entry[]> {
  let shared: Entry[] | undefined
  let until = performance.now() + COMPARE_SLICE_MS
  const length = Math.min(previous.length, next.length)
  for (let index = 0; index < length; index++) {
    const before = previous[index]!
    if (before !== next[index] && isDeepStrictEqual(before, next[index])) (shared ??= [...next])[index] = before
    if (performance.now() >= until) {
      await new Promise((resolve) => setImmediate(resolve))
      until = performance.now() + COMPARE_SLICE_MS
    }
  }
  return shared ?? next
}

/** `sharedEntries` at once, for a read that is synchronous anyway (`LiveJournal.read`). */
export function sharedBase(previous: ThreadPage, next: ThreadPage): ThreadPage {
  let shared: Entry[] | undefined
  const length = Math.min(previous.entries.length, next.entries.length)
  for (let index = 0; index < length; index++) {
    const before = previous.entries[index]!
    if (before !== next.entries[index] && isDeepStrictEqual(before, next.entries[index])) (shared ??= [...next.entries])[index] = before
  }
  return shared ? { ...next, entries: shared } : next
}

/** Whether two histories hold the same entries, once `sharedEntries` gave equal ones one object. */
export function sameEntries(left: readonly Entry[], right: readonly Entry[]): boolean {
  return left === right || (left.length === right.length && left.every((entry, index) => entry === right[index]))
}

/** Whether two pages are one reading of a history: the same entries (`sameEntries`) and the same page around them. */
export function samePage(left: ThreadPage, right: ThreadPage): boolean {
  return sameEntries(left.entries, right.entries) && isDeepStrictEqual({ ...left, entries: [] }, { ...right, entries: [] })
}

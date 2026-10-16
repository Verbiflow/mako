import type { Entry } from "@mako/sessions/entries"
import { streamDifferences } from "@mako/sessions/harnesses"
import type { ThreadPage } from "@mako/sessions"
import { mergeStream, type StreamMerge } from "@mako/sessions/stream-merge"

export interface MergedBase {
  base: ThreadPage
  /** The merge of the base's live part with the blocks it covers; absent when they weren't merged. */
  merge?: StreamMerge
}

/**
 * `base` with the part that holds the conversation's first `covered` live
 * blocks, from `liveStart` on, merged with them (`mergeStream`): the
 * record's entries, naming the stream frames they came from beside their
 * own bytes, and what the stream alone says, as `base`'s harness declares.
 * Every reading of a base goes through it, read again from its session or
 * kept by the journal, so the history Mako shows is one merge whichever
 * read it. A base whose live start isn't known, or lies before the page,
 * stays as its record says. `total` stays the record's count: it is only
 * compared with another reading of the same record.
 */
export function mergedBase(base: ThreadPage, blocks: readonly Entry[], covered: number, liveStart: number | undefined): MergedBase {
  if (covered <= 0 || liveStart === undefined || liveStart < base.start) return { base }
  const from = Math.min(liveStart - base.start, base.entries.length)
  const merge = mergeStream(base.entries.slice(from), blocks.slice(0, covered), streamDifferences(base.ref.harness))
  return {
    base: { ...base, entries: from ? [...base.entries.slice(0, from), ...merge.entries] : merge.entries },
    merge,
  }
}

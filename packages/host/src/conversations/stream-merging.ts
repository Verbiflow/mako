import type { Entry } from "@mako/sessions/entries"
import { streamDifferences } from "@mako/sessions/harnesses"
import type { ThreadPage } from "@mako/sessions"
import type { LiveRequest } from "../contracts/live-conversations.js"
import { mergeStream, recordSpan, type StreamMerge } from "@mako/sessions/stream-merge"

export interface MergedBase {
  base: ThreadPage
  /** The merge of the base's live part with the blocks it covers; absent when they weren't merged. */
  merge?: StreamMerge
  /** Where the live blocks begin in the merged base: `liveStart`, moved past what `inherited` added before it. */
  liveStart?: number
  /** How many entries `inherited` added before the live start. */
  supplied?: number
}

export interface MergeOptions {
  /** A native fork's inherited turns, as its parent shows them (below). */
  inherited?: readonly Entry[]
  /** The requests whose turns were cut off (`cutOffRequests`): what they streamed and the record lacks stays, where the harness declares it. */
  cutOff?: ReadonlySet<string>
}

/** The requests whose turns ended without their record keeping all they streamed: stopped, failed, or lost with the process, as Mako's log has them. */
export function cutOffRequests(requests: readonly Pick<LiveRequest, "id" | "status">[]): Set<string> {
  return new Set(requests.flatMap((request) => request.status === "interrupted" || request.status === "failed" || request.status === "uncertain" ? [request.id] : []))
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
 *
 * `inherited` is, for a native fork, the history it went on from as its
 * parent shows it (`forkHistory`). The fork's record holds those turns as
 * its harness copied them, so they merge with it the way the parent's
 * record merged with the parent's stream: the record's entries stand, and
 * the parent's setup notices and Mako's words for its prompts come back.
 * Then `base` must be a reading of the record, whole, with `liveStart`
 * counted in it; the result says where the live part begins once the
 * inherited turns have what the parent's stream supplied. Their
 * differences were the parent's, reported when its own turns landed.
 */
export function mergedBase(base: ThreadPage, blocks: readonly Entry[], covered: number, liveStart: number | undefined, options: MergeOptions = {}): MergedBase {
  const { inherited, cutOff } = options
  let entries = base.entries
  let start = liveStart
  let supplied: number | undefined
  if (inherited?.length && liveStart !== undefined && base.start === 0 && !base.hasEarlier) {
    const prefix = Math.min(liveStart, entries.length)
    const merge = mergeStream(entries.slice(0, prefix), inherited, streamDifferences(base.ref.harness))
    if (!merge.unaligned) {
      supplied = merge.entries.length - prefix
      entries = [...merge.entries, ...entries.slice(prefix)]
      start = liveStart + supplied
    }
  }
  const at = { ...supplied !== undefined && { liveStart: start, supplied } }
  if (covered <= 0 || start === undefined || start < base.start)
    return { base: entries === base.entries ? base : { ...base, entries }, ...at }
  const from = Math.min(start - base.start, entries.length)
  const merge = mergeStream(entries.slice(from), blocks.slice(0, covered), streamDifferences(base.ref.harness), cutOff)
  return {
    base: { ...base, entries: from ? [...entries.slice(0, from), ...merge.entries] : merge.entries },
    merge,
    ...at,
  }
}

/**
 * Where a conversation's live blocks begin in `record` when it first covers
 * `blocks`, `base` being the history they continue. A base that is this
 * record's own reading ends there. One copied from another session (a
 * fork's parent, the history a seed carries) is that session's merged
 * history, longer than this record by what the parent's stream supplied, so
 * the record is aligned with it (`recordSpan`). Undefined when they can't
 * be aligned, and the record then stands alone.
 */
export function firstLiveStart(base: ThreadPage | null, record: ThreadPage, blocks: readonly Entry[]): number | undefined {
  if (!base) return 0
  if (base.ref.harness === record.ref.harness && base.ref.nativeId === record.ref.nativeId) return base.start + base.entries.length
  const from = base.start - record.start
  if (from < 0) return undefined
  const span = recordSpan(record.entries.slice(from), base.entries, blocks)
  return span === undefined ? undefined : base.start + span
}

import type { ThreadPage, ThreadRef } from "@mako/sessions"
import { plainRecordPath } from "@mako/sessions/record-encoding"
import type { BaseSource, LiveSnapshot } from "../contracts/live-conversations.js"

/** What says where a base was read from; a page's header is enough. */
export type PageHeader = Pick<ThreadPage, "start" | "hasEarlier" | "preview"> & { ref: Pick<ThreadRef, "harness" | "nativeId" | "path"> }

/** What decides whether a journal keeps its own copy of the base. */
export type BaseFacts = Pick<LiveSnapshot, "baseSource" | "baseCoveredBlocks"> & {
  base: PageHeader | null
  blocks: ArrayLike<unknown>
  control?: Pick<NonNullable<LiveSnapshot["control"]>, "bindings">
}

/**
 * Why the journal keeps its own copy of `snapshot`'s base; null when the
 * base is read again from `baseSource` on open. That needs the base to be
 * that session's whole history and to meet every live block, so the session
 * read again (by a newer decoder, or with turns the harness recorded since)
 * is still what the conversation shows. A turn under way, a seeded store or
 * a second binding make the base the one exact reading the live blocks
 * continue, which only the journal's copy has.
 */
export function baseKeptBecause(snapshot: BaseFacts): string | null {
  const source = snapshot.baseSource
  if (!source) return "the record store doesn't hold its session"
  if (snapshot.base && !wholeHistoryOf(snapshot.base, source)) return "it is part of its session, not all of it"
  const covered = snapshot.baseCoveredBlocks ?? 0
  const blocks = snapshot.blocks.length
  const bindings = snapshot.control?.bindings ?? []
  if (bindings.some((binding) => binding.seeded)) return "Mako wrote its session (a seeded store), so the journal has the only exact copy"
  if (blocks === 0) return covered === 0 ? null : "its live blocks are gone but their coverage is counted"
  if (bindings.length !== 1) return `the conversation went on in ${bindings.length} sessions`
  const binding = bindings[0]!
  if (!binding.includesBase) return "the session Mako continued doesn't hold it"
  if (!binding.path || !samePlace(binding.path, source.path) || binding.nativeId !== source.nativeId) return "Mako continued it in another session"
  if (binding.coveredBlocks !== blocks || covered !== blocks) return "its session doesn't hold Mako's latest turns yet"
  return null
}

/**
 * `snapshot` as `LiveSources.refreshedSnapshot` leaves an idle one: its base
 * read again, whole, from the session its one binding holds every live block
 * of. Unchanged when the refresh wouldn't read it again.
 */
export function refreshedFacts(snapshot: BaseFacts): BaseFacts {
  const bindings = snapshot.control?.bindings ?? []
  const binding = bindings.length === 1 ? bindings[0] : undefined
  const blocks = snapshot.blocks.length
  if (!blocks || !binding?.includesBase || binding.coveredBlocks !== blocks || !binding.path || !binding.nativeId) return snapshot
  return {
    ...snapshot,
    baseCoveredBlocks: blocks,
    base: { start: 0, hasEarlier: false, preview: false, ref: { harness: binding.provider, nativeId: binding.nativeId, path: binding.path } },
  }
}

/** Why the journal would keep its copy even once the record store holds the base's session; null when holding it is all that's missing. */
export function baseKeptOnceHeld(snapshot: BaseFacts): string | null {
  if (snapshot.baseSource || !snapshot.base) return baseKeptBecause(snapshot)
  const source = sourceOfPage(snapshot.base)
  return source ? baseKeptBecause({ ...snapshot, baseSource: source }) : "it is part of its session, not all of it"
}

export function baseFromSource(snapshot: BaseFacts): boolean {
  return baseKeptBecause(snapshot) === null
}

/** A base to read from its source before anything relies on it. */
export function baseUnread(snapshot: LiveSnapshot): snapshot is LiveSnapshot & { baseSource: BaseSource } {
  return Boolean(snapshot.baseSource) && !snapshot.base
}

/** What the journal keeps of the base: none when it is read from its source on open. */
export function storedBase(snapshot: LiveSnapshot): ThreadPage | null {
  return baseFromSource(snapshot) ? null : snapshot.base
}

/** The session `page` was read from, when it is that session's whole history. */
export function sourceOfPage(page: PageHeader): BaseSource | undefined {
  const source = { harness: page.ref.harness, nativeId: page.ref.nativeId, path: page.ref.path }
  return wholeHistoryOf(page, source) ? source : undefined
}

/** One file under either encoding: Codex compresses a rollout it hasn't written for a week in place, as `.jsonl.zst`. */
export function samePlace(a: string, b: string): boolean {
  return plainRecordPath(a) === plainRecordPath(b)
}

function wholeHistoryOf(page: PageHeader, source: BaseSource): boolean {
  return page.start === 0 && !page.hasEarlier && !page.preview &&
    page.ref.harness === source.harness && page.ref.nativeId === source.nativeId && samePlace(page.ref.path, source.path)
}

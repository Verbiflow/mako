import { createHash } from "node:crypto"
import type { ThreadEntry, ThreadPage } from "@mako/sessions"
import type { ProviderBinding } from "../contracts/conversation-control.js"
import { nativeHistoryRevision } from "../contracts/native-history.js"
export { nativeHistoryRevision } from "../contracts/native-history.js"

type ReadPage = (path: string, before?: number) => Promise<ThreadPage | null>

/** Gather pages from one stable native snapshot, concatenating only once. */
export async function captureNativeHistory(
  path: string,
  read: ReadPage
): Promise<ThreadPage | null> {
  const latest = await read(path)
  if (!latest) return null
  const pages = [latest.entries]
  let page = latest
  while (page.hasEarlier) {
    const earlier = await read(path, page.start)
    if (
      !earlier ||
      nativeHistoryRevision(earlier) !== nativeHistoryRevision(latest) ||
      earlier.start >= page.start ||
      earlier.start + earlier.entries.length !== page.start
    )
      throw new Error(
        "Native history changed or a page was missing during capture. Retry from the current history."
      )
    pages.push(earlier.entries)
    page = earlier
  }
  return {
    ...latest,
    entries: pages.reverse().flat(),
    start: page.start,
    hasEarlier: false,
  }
}

/**
 * Entries by what they say, leaving out what a reader stamps on them (ids,
 * times, usage), so the same records read again give the same digest.
 */
export function historyDigest(entries: readonly ThreadEntry[]): string {
  const digest = createHash("sha256")
  for (const entry of entries) {
    digest.update(entry.kind).update("\0")
    if (entry.kind === "user") digest.update(entry.text)
    else if (entry.kind === "event") digest.update(entry.label)
    else
      for (const block of entry.blocks)
        digest.update(block.type).update("\0").update(
          block.type === "text" || block.type === "thinking" ? block.text
            : block.type === "tool" ? `${block.name}\0${block.input ?? ""}` : ""
        )
    digest.update("\0\0")
  }
  return digest.digest("hex")
}

/**
 * The native history of a store Mako seeded, read as the conversation: what
 * Mako wrote there, which the store keeps as text, is given back as `own`
 * (the conversation's entries from its start) has it, followed by what the
 * harness recorded since. Undefined when the store no longer begins with the
 * seed, as after the harness compacted it, and its own read is the record.
 */
export function withSeed(
  native: ThreadPage,
  own: readonly ThreadEntry[],
  seeded: NonNullable<ProviderBinding["seeded"]>
): ThreadPage | undefined {
  if (native.start !== 0 || native.hasEarlier || native.entries.length < seeded.native || own.length < seeded.entries)
    return undefined
  if (historyDigest(native.entries.slice(0, seeded.native)) !== seeded.digest) return undefined
  return { ...native, entries: [...own.slice(0, seeded.entries), ...native.entries.slice(seeded.native)] }
}

import { createHash } from "node:crypto"
import { messagesFromEntries, type DecodedEntry, type ThreadPage } from "@mako/sessions"
import type { Entry } from "@mako/sessions/entries"
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
export function historyDigest(entries: readonly Entry[]): string {
  const digest = createHash("sha256")
  for (const entry of entries) {
    digest.update(entry.type).update("\0")
    if (entry.type === "user" || entry.type === "text" || entry.type === "thinking") digest.update(entry.text)
    else if (entry.type === "event") digest.update(entry.label)
    else if (entry.type === "tool") digest.update(`${entry.name ?? ""}\0${entry.input ?? ""}`)
    digest.update("\0\0")
  }
  return digest.digest("hex")
}

/** `historyDigest` as a seed taken before 2026-10-15 has it: over messages, each prompt, marker or reply one. */
export function messageDigest(messages: readonly DecodedEntry[]): string {
  const digest = createHash("sha256")
  for (const entry of messages) {
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

/** How many entries the first `count` messages of `entries` hold, when there are that many; undefined otherwise. */
function entriesOfMessages(entries: readonly Entry[], count: number): { entries: number; digest: string } | undefined {
  const messages = messagesFromEntries(entries)
  if (messages.length < count) return undefined
  const head = messages.slice(0, count)
  return { entries: head.reduce((sum, message) => sum + (message.kind === "assistant" ? message.blocks.length : 1), 0), digest: messageDigest(head) }
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
  own: readonly Entry[],
  seeded: NonNullable<ProviderBinding["seeded"]>
): ThreadPage | undefined {
  if (native.start !== 0 || native.hasEarlier) return undefined
  const counts = seeded.unit === "entry" ? { native: seeded.native, entries: seeded.entries } : messageCounts(native.entries, own, seeded)
  if (!counts || native.entries.length < counts.native || own.length < counts.entries) return undefined
  if (seeded.unit === "entry" && historyDigest(native.entries.slice(0, counts.native)) !== seeded.digest) return undefined
  return { ...native, entries: [...own.slice(0, counts.entries), ...native.entries.slice(counts.native)] }
}

/** A seed that counted messages, in entries: the messages each side's entries group into, the native ones under the digest taken of them. */
function messageCounts(native: readonly Entry[], own: readonly Entry[], seeded: NonNullable<ProviderBinding["seeded"]>): { native: number; entries: number } | undefined {
  const read = entriesOfMessages(native, seeded.native)
  const mine = entriesOfMessages(own, seeded.entries)
  if (!read || !mine || read.digest !== seeded.digest) return undefined
  return { native: read.entries, entries: mine.entries }
}

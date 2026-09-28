import type { ThreadRef } from "@mako/sessions"

/** Rows the window's rail holds. Nobody scrolls ten years of history. */
export const THREAD_LIST_CAP = 600

type ListedRef = Pick<ThreadRef, "harness" | "nativeId" | "identity" | "archived" | "updatedAt" | "threadId">

/**
 * The rail's list: one row per session, newest first, capped. The host
 * answers a reload with it and the window applies it after every push, so a
 * reload never shows a different set of rows than the pushes built. A row
 * past the cap stays when a row within it shares its Thread: the cap counts
 * history, and a Thread is shown whole.
 */
export function threadList<Ref extends ListedRef>(list: readonly Ref[]): Ref[] {
  const byIdentity = new Map<string, Ref>()
  for (const ref of list) {
    // A provider may say one native id names two distinct stores (a Cursor
    // session continued by the CLI into chats/); those stay separate rows.
    const key = `${ref.harness}:${ref.identity ?? ref.nativeId}`
    const held = byIdentity.get(key)
    if (
      !held ||
      (held.archived && !ref.archived) ||
      (Boolean(held.archived) === Boolean(ref.archived) &&
        (ref.updatedAt ?? "") > (held.updatedAt ?? ""))
    )
      byIdentity.set(key, ref)
  }
  const sorted = [...byIdentity.values()]
    .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
  if (sorted.length <= THREAD_LIST_CAP) return sorted
  const kept = sorted.slice(0, THREAD_LIST_CAP)
  const threads = new Set(kept.flatMap((ref) => (ref.threadId ? [ref.threadId] : [])))
  return [...kept, ...sorted.slice(THREAD_LIST_CAP).filter((ref) => ref.threadId !== undefined && threads.has(ref.threadId))]
}

/**
 * The Sessions of listed Threads that have no listed row: the host places
 * the rows past the cap only to find these, since the cap is cut before
 * rows are placed.
 */
export function unlistedThreadSessions(
  listed: readonly Pick<ThreadRef, "threadId" | "sessionId">[],
  groups: readonly { id: string; sessions: readonly { id: string }[] }[]
): Set<string> {
  const threads = new Set(listed.flatMap((ref) => (ref.threadId ? [ref.threadId] : [])))
  const shown = new Set(listed.flatMap((ref) => (ref.sessionId ? [ref.sessionId] : [])))
  const missing = new Set<string>()
  for (const group of groups) {
    if (!threads.has(group.id)) continue
    for (const session of group.sessions) if (!shown.has(session.id)) missing.add(session.id)
  }
  return missing
}

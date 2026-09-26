import type { ThreadRef } from "@mako/sessions"

/** Rows the window's rail holds. Nobody scrolls ten years of history. */
export const THREAD_LIST_CAP = 600

type ListedRef = Pick<ThreadRef, "harness" | "nativeId" | "identity" | "archived" | "updatedAt">

/**
 * The rail's list: one row per session, newest first, capped. The host
 * answers a reload with it and the window applies it after every push, so a
 * reload never shows a different set of rows than the pushes built.
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
  return [...byIdentity.values()]
    .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
    .slice(0, THREAD_LIST_CAP)
}

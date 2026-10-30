import type { WebThread } from "./threads"

/** Renames asked from this browser, shown at once, before the owner's word reaches the list. */
const renamed = new Map<string, string>()

/** A rename asked of the Thread's owner (`undefined`: refused, so the listed title stands). */
export function askedRename(thread: string, title: string | undefined): void {
  if (title === undefined) renamed.delete(thread)
  else renamed.set(thread, title)
}

/** The title a row shows: the person's own rename while it's on its way, else the listed one. */
export function shownTitle(thread: WebThread): string {
  const asked = renamed.get(thread.id)
  if (asked === undefined) return thread.title
  if (asked === thread.title) renamed.delete(thread.id)
  return asked
}

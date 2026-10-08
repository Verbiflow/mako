import type { ThreadPage } from "@mako/sessions"
import { nativeHistoryRevision } from "./contracts/native-history.js"
export { nativeHistoryRevision } from "./contracts/native-history.js"

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

import type { ThreadPage } from "@mako/sessions"

type ReadPage = (path: string, before?: number) => Promise<ThreadPage | null>

export function nativeHistoryRevision(page: ThreadPage): string {
  return JSON.stringify([
    page.ref.path,
    page.ref.nativeId,
    page.checkpoint,
    page.ref.revision,
    page.ref.bytes,
    page.ref.updatedAt,
    page.total,
  ])
}

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

import type { Steps } from "@mako/sessions/slices"
import type { WorktreeSummary } from "../contracts/thread-worktrees.js"

/** Compare one complete row at a time: unknown fields and in-place changes still count, with work between slices. */
export function* summaryRows(summaries: readonly WorktreeSummary[], previous: readonly string[] | undefined): Steps<{ said: string[]; changed: boolean }> {
  const said: string[] = []
  let changed = previous === undefined || previous.length !== summaries.length
  for (const [index, summary] of summaries.entries()) {
    const row = JSON.stringify(summary)
    if (row !== previous?.[index]) changed = true
    said.push(row)
    yield
  }
  return { said, changed }
}

/** Ref output parsed a line per step, without allocating every line in one split. */
export function* summaryTips(refs: string): Steps<Map<string, string>> {
  const tips = new Map<string, string>()
  for (let from = 0; from < refs.length;) {
    const end = refs.indexOf("\n", from)
    const line = refs.slice(from, end < 0 ? refs.length : end)
    const space = line.indexOf(" ")
    if (space > 0) tips.set(line.slice(space + 1), line.slice(0, space))
    from = end < 0 ? refs.length : end + 1
    yield
  }
  return tips
}

/** The same count as split("\n").length for nonempty status, without one unbounded array allocation. */
export function* summaryChanges(status: string): Steps<number> {
  if (!status) return 0
  let count = 1
  for (let at = status.indexOf("\n"); at >= 0; at = status.indexOf("\n", at + 1)) {
    count++
    yield
  }
  return count
}

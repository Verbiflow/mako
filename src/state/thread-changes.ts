import { useEffect, useState } from "react"
import type { ThreadChangeSummary } from "@mako/host/contracts/thread-changes"
import type { ChangeCounts } from "@mako/host/contracts/usage-ledger"
import type { LiveRequest } from "@mako/host/contracts/live-conversations"
import { countedChanges } from "@mako/host/contracts/turn-changes"
import { getMako, hasBridge } from "@/lib/bridge"

/** A Thread's "changes made" as the usage popover shows them; nothing before the journal has counted any. */
export function changeCounts(summary: ThreadChangeSummary): ChangeCounts | undefined {
  const { created, changed, deleted, renamed } = summary.files
  const files = created + changed + deleted + renamed
  if (!files && !summary.commands && !summary.maybe) return undefined
  return {
    files,
    added: summary.lines.added,
    removed: summary.lines.removed,
    scope: "thread",
    kinds: summary.files,
    commands: summary.commands,
    outside: summary.outside.named + summary.outside.maybe,
    maybe: summary.maybe,
  }
}

/**
 * What says the Thread's changes made moved: each of the conversation's
 * turns whose record the journal settled, and how far it counted. A string,
 * so the popover reads again exactly when a turn settles, not on a token.
 */
export function settledTurns(requests: readonly LiveRequest[] | undefined): string {
  let settled = 0
  let through = 0
  for (const request of requests ?? []) {
    const counted = countedChanges(request.changes)
    if (counted?.state !== "settled") continue
    settled++
    through += counted.through
  }
  return `${settled}:${through}`
}

/**
 * The Thread's changes made, read from the host's journal when the popover
 * opens and again as its turns settle (`revision`, `settledTurns`);
 * undefined until then, and for a Thread the journal hasn't seen change anything.
 */
export function useThreadChanges(thread: string | undefined, revision: string): ChangeCounts | undefined {
  const [counts, setCounts] = useState<{ thread: string; counts: ChangeCounts | undefined }>()
  useEffect(() => {
    if (!thread || !hasBridge()) return
    let current = true
    void getMako().threadChanges(thread).then(
      (summary) => { if (current) setCounts({ thread, counts: summary ? changeCounts(summary) : undefined }) },
      () => {},
    )
    return () => { current = false }
  }, [thread, revision])
  return counts && counts.thread === thread ? counts.counts : undefined
}

import { useEffect, useState } from "react"
import type { ThreadChangeSummary } from "@mako/host/contracts/thread-changes"
import type { ChangeCounts } from "@mako/host/contracts/usage-ledger"
import { getMako, hasBridge } from "@/lib/bridge"

/** A Thread's "changes made" as the usage popover shows them; nothing before the journal has counted any. */
export function changeCounts(summary: ThreadChangeSummary): ChangeCounts | undefined {
  const { created, changed, deleted, renamed } = summary.files
  const files = created + changed + deleted + renamed
  if (!files && !summary.commands) return undefined
  return {
    files,
    added: summary.lines.added,
    removed: summary.lines.removed,
    scope: "thread",
    kinds: summary.files,
    commands: summary.commands,
    outside: summary.outside.named + summary.outside.maybe,
  }
}

/**
 * The Thread's changes made, read from the host's journal when the popover
 * opens and again as its turns finish (`revision`); undefined until then,
 * and for a Thread the journal hasn't seen change anything.
 */
export function useThreadChanges(thread: string | undefined, revision: number): ChangeCounts | undefined {
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

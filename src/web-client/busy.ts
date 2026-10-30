import { acpStore } from "@/state/acp-state"

/**
 * What a reload would cut short: a message on its way, a Thread starting, an archive or a move. Reads (the list, a
 * transcript, a catalog) never count: they're asked again after a reload, and one hanging on a Mac that's off would
 * otherwise hold a newer build back for as long as it hangs.
 */
let held = 0

/** Runs `work` counted as in flight until it settles. */
export function whileBusy<Result>(work: Promise<Result>): Promise<Result> {
  held++
  return work.finally(() => {
    held--
  })
}

/** Whether something a reload would cut short is under way: one held here, or a conversation sending. */
export function busy(): boolean {
  if (held > 0) return true
  for (const conversation of Object.values(acpStore.get().conversations)) if (conversation.kind === "live" && conversation.sending) return true
  return false
}

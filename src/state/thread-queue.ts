import type { ThreadRef } from "@/lib/types"
import type { ViewedUserEntry } from "@/state/thread-state"
import { threadsStore } from "@/state/thread-store"
import { rememberThread } from "@/state/thread-viewing"

export function appendOptimisticReply(ref: ThreadRef, prompt: string): boolean {
  const { viewing } = threadsStore.get()
  if (!viewing || viewing.ref.path !== ref.path) return false
  const echo: ViewedUserEntry = {
    kind: "user",
    at: new Date().toISOString(),
    text: prompt,
    echo: true,
  }
  rememberThread({ ...viewing, entries: [...viewing.entries, echo] })
  return true
}

export function removeOptimisticReply(ref: ThreadRef, prompt: string): void {
  const viewing = threadsStore.get().viewing
  if (!viewing || viewing.ref.path !== ref.path) return
  rememberThread({
    ...viewing,
    entries: viewing.entries.filter(
      (entry) =>
        entry.kind !== "user" || entry.echo !== true || entry.text !== prompt
    ),
  })
}

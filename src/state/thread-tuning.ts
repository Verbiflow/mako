import { setPref } from "@/state/prefs"
import { rememberDraftHarness } from "@/state/thread-groups"
import { threadsStore } from "@/state/thread-store"

/** The composer's agent, remembered across launches. */
export function setComposerHarness(harness: string) {
  threadsStore.set({ composerHarness: harness })
  setPref("composerHarness", harness)
  rememberDraftHarness(harness)
}

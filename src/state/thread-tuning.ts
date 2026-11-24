import { setPref } from "@/state/prefs"
import { rememberDraftHarness } from "@/state/thread-groups"
import { threadsStore } from "@/state/thread-store"

/**
 * The composer's agent, remembered across launches. Saved first: until a pick is saved the composer follows the
 * first signed-in agent (`followFirstRunAgent`), which once took back a first pick of an agent not installed yet.
 */
export function setComposerHarness(harness: string) {
  setPref("composerHarness", harness)
  threadsStore.set({ composerHarness: harness })
  rememberDraftHarness(harness)
}

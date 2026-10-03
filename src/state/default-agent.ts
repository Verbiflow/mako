import type { HarnessDescriptor, HarnessProfile, ThreadRef } from "@/lib/types"
import { acpStore, activeAcp } from "@/state/acp-state"
import { prefsStore } from "@/state/prefs"
import { providerStore } from "@/state/providers"
import { threadsStore } from "@/state/thread-store"

/** Signed in, or still being asked: a slow start never skips an agent. */
export function isSignedIn(profile: HarnessProfile | undefined): boolean {
  return Boolean(profile && (profile.pending || profile.available))
}

/**
 * The agent new conversations start on before the person has picked one: the
 * signed-in agent this Mac used most recently, read from every agent's own
 * history; with no history, the first signed-in one.
 */
export function firstRunAgent(profiles: Record<string, HarnessProfile>, threads: readonly ThreadRef[], descriptors: readonly HarnessDescriptor[] = threadsStore.get().descriptors): string | undefined {
  let recent: ThreadRef | undefined
  for (const ref of threads) {
    if (!isSignedIn(profiles[ref.harness])) continue
    if (!recent || (ref.updatedAt ?? "") > (recent.updatedAt ?? "")) recent = ref
  }
  if (recent) return recent.harness
  // Profiles may arrive before identity metadata. Do not pick an arbitrary
  // first-run default while the declared preference order is still loading.
  if (descriptors.some((entry) => !entry.presentation)) return undefined
  return [...descriptors]
    .sort((left, right) => (left.presentation?.firstRunPriority ?? Infinity) - (right.presentation?.firstRunPriority ?? Infinity))
    .find(({ provider }) => isSignedIn(profiles[provider]))?.provider
}

/**
 * Until the person picks an agent, the composer follows `firstRunAgent` as
 * sign-ins and history arrive. Picking one saves it, and from then on the
 * pick stands.
 */
export function followFirstRunAgent(): () => void {
  const follow = () => {
    if (prefsStore.get().composerHarness) return
    const state = threadsStore.get()
    if (state.viewing || state.opening || activeAcp(acpStore.get())) return
    const harness = firstRunAgent(providerStore.get().profiles, state.threads)
    if (harness && harness !== state.composerHarness) threadsStore.set({ composerHarness: harness })
  }
  follow()
  const stops = [providerStore.subscribe(follow), threadsStore.subscribe(follow), prefsStore.subscribe(follow), acpStore.subscribe(follow)]
  return () => {
    for (const stop of stops) stop()
  }
}

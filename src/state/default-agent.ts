import { agentOrder, harnessesByRecency } from "../../electron/contracts/agent-order"
import type { HarnessProfile, ThreadRef } from "@/lib/types"
import { acpStore, activeAcp } from "@/state/acp-state"
import { currentHarnessOrder, loadHarnessOrder, subscribeHarnessOrder } from "@/state/harness-order"
import { prefsStore } from "@/state/prefs"
import { providerStore } from "@/state/providers"
import { threadsStore } from "@/state/thread-store"

/** Signed in, or still being asked: a slow start never skips an agent. */
export function isSignedIn(profile: HarnessProfile | undefined): boolean {
  return Boolean(profile && (profile.pending || profile.available))
}

/** The signed-in harnesses, in the person's harness order. */
export function signedInByOrder(profiles: Record<string, HarnessProfile>, order: readonly string[] = currentHarnessOrder(Object.keys(profiles))): string[] {
  return agentOrder({ signedIn: Object.keys(profiles).filter((harness) => isSignedIn(profiles[harness])), order })
}

/**
 * The agent new conversations start on before the person has picked one: the
 * signed-in agent this Mac used most recently, read from every agent's own
 * history; with no history, the first signed-in one in the harness order.
 */
export function firstRunAgent(profiles: Record<string, HarnessProfile>, threads: readonly ThreadRef[], order: readonly string[] = currentHarnessOrder(Object.keys(profiles))): string | undefined {
  return agentOrder({ signedIn: signedInByOrder(profiles, order), order, recent: harnessesByRecency(threads) })[0]
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
  void loadHarnessOrder()
  follow()
  const stops = [providerStore.subscribe(follow), threadsStore.subscribe(follow), prefsStore.subscribe(follow), acpStore.subscribe(follow), subscribeHarnessOrder(follow)]
  return () => {
    for (const stop of stops) stop()
  }
}

import { rollup, rosterChildren } from "@mako/host/contracts/children"
import { activeLiveAcp, useAcp } from "@/state/acp"
import type { AcpState } from "@/state/acp-state"
import { apexViewStore, threadRollup } from "@/state/apex-fins"

/**
 * The conversation on screen and how its Fins stand: the Thread's one rollup, or a Session's own roster. A Fin open in
 * place keeps its Apex's Fins here, as the Agents panel does.
 */
export function rosterOnScreen(state: AcpState) {
  const live = activeLiveAcp(state)
  const thread = apexViewStore.get().open?.apex ?? live?.threadId
  const counts = thread ? threadRollup(state, thread) : rollup(rosterChildren(live?.nativeAgents))
  return { live, counts }
}

/** Agents has its row while there is anyone to show: a quiet Session has no use for it, and the composer's chip says the same. */
export function useAgentsOffered(): boolean {
  return useAcp((state) => {
    const { live, counts } = rosterOnScreen(state)
    return counts.total > 0 || (live?.nativeAgents?.agents.length ?? 0) > 0
  })
}

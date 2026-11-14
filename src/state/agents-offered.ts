import { rollup, rosterChildren } from "@mako/host/contracts/children"
import { activeLiveAcp, useAcp } from "@/state/acp"
import type { AcpState } from "@/state/acp-state"
import { apexViewStore, threadRollup } from "@/state/apex-fins"

/**
 * The conversation whose Fins are read and how they stand: the Thread's one rollup, or a Session's own roster. It's the
 * one on screen unless one is named, and a Fin on screen in place reads its Apex's, as the Agents panel does; an open
 * Fin no longer on screen is no reason to read another Thread's.
 */
export function rosterOnScreen(state: AcpState, conversation?: string) {
  const named = conversation ? state.conversations[conversation] : undefined
  const live = named?.kind === "live" ? named : activeLiveAcp(state)
  const inPlace = apexViewStore.get().open
  const thread = inPlace && inPlace.child === live?.threadId ? inPlace.apex : live?.threadId
  const counts = thread ? threadRollup(state, thread) : rollup(rosterChildren(live?.nativeAgents))
  return { live, counts }
}

/** Agents has its row while there is anyone to show: a quiet Session has no use for it, and the composer's chip says the same. */
export function useAgentsOffered(conversation?: string): boolean {
  return useAcp((state) => {
    const { live, counts } = rosterOnScreen(state, conversation)
    // Its provider's own work, or its Thread's Fins, whichever of its Sessions is on screen (`conversationRoster`).
    return counts.total > 0 || Boolean(live?.nativeAgents?.agents.some((agent) => !agent.child))
  })
}

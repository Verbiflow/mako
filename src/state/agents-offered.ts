import { rollup, rosterChildren } from "@mako/host/contracts/children"
import { activeLiveAcp } from "@/state/acp"
import { useRailAcp, type AcpState } from "@/state/acp-state"
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
  return { live, counts, thread }
}

/**
 * The Apex on screen, by its Thread: the Thread shown when it has Fins, or the Apex of a Fin opened in place. Its right
 * rail opens on the Overview and its Agents row is named so; undefined for any other Thread.
 */
export function apexOnScreen(state: AcpState, conversation?: string): string | undefined {
  const { counts, thread } = rosterOnScreen(state, conversation)
  return counts.total > 0 ? thread : undefined
}

/** What the Agents surface is called now: an Apex's is its Overview, and a Session's own work stays Agents. */
export function useAgentsLabel(conversation?: string): string {
  return useRailAcp((state) => (apexOnScreen(state, conversation) ? OVERVIEW_LABEL : AGENTS_LABEL))
}
export const OVERVIEW_LABEL = "Overview"
export const AGENTS_LABEL = "Agents"

/** Agents has its row while there is anyone to show: a quiet Session has no use for it, and the composer's chip says the same. */
export function useAgentsOffered(conversation?: string): boolean {
  // The rail's store: a roster, a status and the conversation on screen are facts it says, and no token moves one.
  return useRailAcp((state) => {
    const { live, counts } = rosterOnScreen(state, conversation)
    // Its provider's own work, or its Thread's Fins, whichever of its Sessions is on screen (`conversationRoster`).
    return counts.total > 0 || Boolean(live?.nativeAgents?.agents.some((agent) => !agent.child))
  })
}

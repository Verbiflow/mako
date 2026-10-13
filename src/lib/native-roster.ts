import type { NativeAgent, NativeAgentRoster } from "@/lib/types"

/**
 * Keeps each roster entry's identity when a batch resends it unchanged.
 * The host resends the whole roster when any entry moves, and every object
 * arrives new over the wire; without this, a subagent's tool count wakes
 * every row in the Agents panel. The host stamps `observedAt` on each
 * observation, so a new stamp is a new entry at once; a same stamp is
 * compared whole, because two observations can land in one millisecond and
 * a lost connection rewrites an entry without observing it.
 */
export function reconcileRoster(
  previous: NativeAgentRoster | undefined,
  next: NativeAgentRoster | undefined
): NativeAgentRoster | undefined {
  if (!previous || !next || previous === next) return next
  const held = new Map<string, NativeAgent>()
  for (const agent of previous.agents) held.set(`${agent.bindingId}\0${agent.nativeId}`, agent)
  let same = previous.agents.length === next.agents.length && previous.limited === next.limited
  const agents = next.agents.map((agent, index) => {
    const kept = held.get(`${agent.bindingId}\0${agent.nativeId}`)
    const reused = kept && kept.observedAt === agent.observedAt && sameEntry(kept, agent) ? kept : agent
    if (reused !== previous.agents[index]) same = false
    return reused
  })
  return same ? previous : { ...next, agents }
}

function sameEntry(left: NativeAgent, right: NativeAgent): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

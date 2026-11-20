import { groupWords, rollupChip, rollupLabel } from "@mako/host/contracts/children"
import { isActiveNativeAgent } from "@mako/host/contracts/native-agents"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { rosterOnScreen } from "@/state/agents-offered"
import { useControlPreview } from "@/state/control-preview"
import { shallowEqual } from "@/state/store"
import { TabReading } from "@/components/stage/side-tab"

/*
 * What the right rail's rows read at their end. Each selects its one fact, so a token streaming or a Fin's step moving
 * repaints no row whose words stay the same.
 */

/** Whether the conversation on screen is driving a browser tab or a window right now; tight, only in the tab's name. */
export function ControlReading() {
  const live = useAcp((state) => activeLiveAcp(state)?.key)
  const active = useControlPreview((state) => Boolean(live && state.activities[live]))
  return active ? <TabReading words="Live" /> : null
}

/** Who needs the person, in the attention hue, or how the Fins stand; a Session without any counts what still runs. */
export function AgentsReading({ conversation }: { conversation?: string }) {
  const reading = useAcp((state) => {
    const { live, counts } = rosterOnScreen(state, conversation)
    return {
      needs: counts.needs,
      chip: counts.total ? rollupChip(counts) : "",
      label: counts.total ? rollupLabel(counts) : "",
      running: (live?.nativeAgents?.agents ?? []).filter((agent) => isActiveNativeAgent(agent) && !agent.ambient && !agent.child).length,
    }
  }, shallowEqual)
  // Tight, who needs the person keeps its count in the attention hue; how the Fins stand keeps a count of what runs.
  if (reading.needs) return <TabReading words={`${reading.needs} ${groupWords("needs", reading.needs)}`} count={String(reading.needs)} attention title={reading.label} />
  const words = reading.chip || (reading.running ? `${reading.running} running` : "")
  return words ? <TabReading words={words} count={reading.running ? String(reading.running) : undefined} title={reading.label || undefined} /> : null
}

import { groupWords, rollupChip, rollupLabel } from "@mako/host/contracts/children"
import { isActiveNativeAgent } from "@mako/host/contracts/native-agents"
import { LineCounts } from "@/components/inspector/change-marks"
import { activeLiveAcp, useAcp } from "@/state/acp"
import { rosterOnScreen } from "@/state/agents-offered"
import { useControlPreview } from "@/state/control-preview"
import { useSession } from "@/state/session"
import { shallowEqual } from "@/state/store"

/*
 * What the right rail's rows read at their end. Each selects its one fact, so a token streaming or a Fin's step moving
 * repaints no row whose words stay the same.
 */

/** How much the working tree changed. A tree with unknown line totals says how many files, and a clean one nothing. */
export function ChangesReading() {
  const changed = useSession((state) => {
    const files = state.git?.files ?? []
    const counted = files.every((file) => file.insertions !== null && file.deletions !== null)
    return {
      files: files.length,
      counted,
      insertions: counted ? files.reduce((sum, file) => sum + (file.insertions ?? 0), 0) : 0,
      deletions: counted ? files.reduce((sum, file) => sum + (file.deletions ?? 0), 0) : 0,
    }
  }, shallowEqual)
  if (!changed.files) return null
  if (!changed.counted || (!changed.insertions && !changed.deletions)) return <span className="tabular shrink-0 text-label text-faint">{`${changed.files} ${changed.files === 1 ? "file" : "files"}`}</span>
  return <LineCounts insertions={changed.insertions} deletions={changed.deletions} />
}

/** Whether the conversation on screen is driving a browser tab or a window right now. */
export function ControlReading() {
  const live = useAcp((state) => activeLiveAcp(state)?.key)
  const active = useControlPreview((state) => Boolean(live && state.activities[live]))
  return active ? <span className="shrink-0 text-label text-faint">Live</span> : null
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
  if (reading.needs) return <span title={reading.label} className="tabular shrink-0 text-label font-medium text-attention">{`${reading.needs} ${groupWords("needs", reading.needs)}`}</span>
  const words = reading.chip || (reading.running ? `${reading.running} running` : "")
  return words ? <span title={reading.label || undefined} className="tabular min-w-0 truncate text-label text-faint">{words}</span> : null
}

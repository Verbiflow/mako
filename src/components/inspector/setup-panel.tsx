import { ThreadSetup } from "@/components/setup/setup-page"
import { activeAcp, useAcp } from "@/state/acp"
import { useSetup } from "@/state/setup"

/** The side panel's Setup tab: what the open Thread's own place has, and its asks. */
export function SetupPanel() {
  const cwd = useAcp((state) => activeAcp(state)?.cwd)
  const thread = useAcp((state) => activeAcp(state)?.threadId)
  const elsewhere = useAcp((state) => activeAcp(state)?.elsewhere)
  return <ThreadSetup folder={cwd} thread={thread} elsewhere={elsewhere} />
}

/** The rail's reading for Setup: how many of the open Thread's asks wait on the person, in the attention hue. */
export function SetupReading() {
  const cwd = useAcp((state) => activeAcp(state)?.cwd)
  const thread = useAcp((state) => activeAcp(state)?.threadId)
  const waiting = useSetup((state) => (cwd && thread ? (state.byFolder[cwd]?.places ?? []).flatMap((place) => place.asks).filter((ask) => ask.by.thread === thread).length : 0))
  return waiting ? <span className="tabular shrink-0 text-label font-medium text-attention">{`${waiting} need${waiting === 1 ? "s" : ""} you`}</span> : null
}


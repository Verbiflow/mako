import { useCallback, useEffect, useRef } from "react"
import { ConversationAgents } from "@/components/inspector/agents-panel"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { activeAcp, useAcp } from "@/state/acp"
import { agentsOpenStore, closeAgents, openDeskFin, useAgentsOpen, useDeskFin } from "./agents-open"
import { filesOpenStore, leftFiles } from "./files-open"
import { leftReview, reviewOpenStore } from "./review-open"
import { setupOpenStore } from "./setup-open"
import { WebSideRail } from "./side-rail"

/**
 * Agents in the right rail of a laptop's browser, as the desktop draws it: the roster, where Changes and Files go, the
 * three taking turns. It's about the Thread on screen: another Thread or screen takes it away.
 */
export function AgentsLayer({ place }: { place: string | undefined }) {
  const open = useAgentsOpen((state) => state.open)
  const onScreen = useAcp((state) => activeAcp(state)?.key)
  // The Apex's roster while one of its Fins stands in the pane, else that of what's on screen.
  const roster = useDeskFin((state) => state.fin?.apex) ?? onScreen
  const thread = useAcp((state) => (roster ? state.conversations[roster]?.threadId : undefined))
  const openFin = useCallback(
    (agent: NativeAgent) => {
      if (roster && thread) openDeskFin(agent, thread, roster)
    },
    [roster, thread]
  )
  useEffect(() => {
    if (open) {
      leftReview()
      leftFiles()
    }
  }, [open])
  useEffect(() => {
    const away = () => {
      if (agentsOpenStore.get().open && (reviewOpenStore.get().open || filesOpenStore.get().open || setupOpenStore.get().open)) closeAgents()
    }
    const stops = [reviewOpenStore.subscribe(away), filesOpenStore.subscribe(away), setupOpenStore.subscribe(away)]
    return () => stops.forEach((stop) => stop())
  }, [])
  const was = useRef(place)
  useEffect(() => {
    if (was.current !== place) closeAgents()
    was.current = place
  }, [place])
  if (!open || !onScreen || !roster) return null
  return (
    <div className="rv-layer" data-form="desk">
      <div className="rv-screen">
        <WebSideRail active="agents" conversation={onScreen} />
        <div className="flex min-h-0 flex-1 flex-col">
          <ConversationAgents key={roster} conversation={roster} transcripts={false} onOpenChild={openFin} />
        </div>
      </div>
    </div>
  )
}

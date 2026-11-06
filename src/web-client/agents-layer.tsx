import { useEffect, useRef } from "react"
import { ConversationAgents } from "@/components/inspector/agents-panel"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { agentsOpenStore, closeAgents, deskFinStore, useAgentsOpen } from "./agents-open"
import { filesOpenStore, leftFiles } from "./files-open"
import { leftReview, reviewOpenStore } from "./review-open"
import { WebSideRail } from "./side-rail"

const openFin = (agent: NativeAgent) => {
  if (agent.child?.conversation) deskFinStore.set({ ...deskFinStore.get(), agent })
}

/**
 * Agents in the right rail of a laptop's browser, as the desktop draws it: the roster, where Changes and Files go, the
 * three taking turns. It's about the Thread on screen: another Thread or screen takes it away.
 */
export function AgentsLayer({ place }: { place: string | undefined }) {
  const open = useAgentsOpen((state) => state.open)
  useEffect(() => {
    if (open) {
      leftReview()
      leftFiles()
    }
  }, [open])
  useEffect(() => {
    const away = () => {
      if (agentsOpenStore.get().open && (reviewOpenStore.get().open || filesOpenStore.get().open)) closeAgents()
    }
    const stopReview = reviewOpenStore.subscribe(away)
    const stopFiles = filesOpenStore.subscribe(away)
    return () => {
      stopReview()
      stopFiles()
    }
  }, [])
  const was = useRef(place)
  useEffect(() => {
    if (was.current !== place) closeAgents()
    was.current = place
  }, [place])
  if (!open) return null
  return (
    <div className="rv-layer" data-form="desk">
      <div className="rv-screen">
        <WebSideRail active="agents" conversation={open.conversation} />
        <div className="flex min-h-0 flex-1 flex-col">
          <ConversationAgents conversation={open.conversation} transcripts={false} onOpenChild={openFin} />
        </div>
      </div>
    </div>
  )
}

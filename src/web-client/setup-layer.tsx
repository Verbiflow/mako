import { useEffect, useRef } from "react"
import { ThreadSetup } from "@/components/setup/setup-page"
import { activeAcp, useAcp } from "@/state/acp"
import { setSetupSource } from "@/state/setup"
import { accountListStore } from "./account-list"
import { agentsOpenStore, closeAgents } from "./agents-open"
import { useWebClient } from "./client"
import { filesOpenStore, leftFiles } from "./files-open"
import { leftReview, reviewOpenStore } from "./review-open"
import { listedAsker, webSetup } from "./setup-source"
import { closeSetup, setupOpenStore, useSetupOpen } from "./setup-open"
import { useThreadSetupPlace } from "./setup-thread"
import { WebSideRail } from "./side-rail"

/**
 * Setup in the right rail of a laptop's browser, as the desktop's side panel draws it: the Thread on screen's place, its
 * asks first, read from the account broker. It takes turns with Changes, Files and Agents, and another Thread or screen
 * takes it away. "All of" opens the project's whole page in the pane (`onAll`).
 */
export function SetupLayer({ place, onAll }: { place: string | undefined; onAll: (project: string) => void }) {
  const open = useSetupOpen((state) => state.open)
  const onScreen = useAcp((state) => activeAcp(state)?.key)
  const thread = useAcp((state) => activeAcp(state)?.threadId)
  const { project, elsewhere } = useThreadSetupPlace(onScreen)
  const client = useWebClient()
  useEffect(() => {
    if (!open) return
    leftReview()
    leftFiles()
    closeAgents()
    setSetupSource(webSetup(client.gateway, client.account.id, () => [...accountListStore.get().devices.values()], Date.now, (thread) => listedAsker(accountListStore.get().rows, thread)))
    return () => setSetupSource(undefined)
  }, [open, client])
  useEffect(() => {
    const away = () => {
      if (setupOpenStore.get().open && (reviewOpenStore.get().open || filesOpenStore.get().open || agentsOpenStore.get().open)) closeSetup()
    }
    const stops = [reviewOpenStore.subscribe(away), filesOpenStore.subscribe(away), agentsOpenStore.subscribe(away)]
    return () => stops.forEach((stop) => stop())
  }, [])
  const was = useRef(place)
  useEffect(() => {
    if (was.current !== place) closeSetup()
    was.current = place
  }, [place])
  if (!open || !onScreen) return null
  return (
    <div className="rv-layer" data-form="desk" data-setup-layer>
      <div className="rv-screen">
        <WebSideRail active="setup" conversation={onScreen} />
        <div className="flex min-h-0 flex-1 flex-col">
          <ThreadSetup folder={project} thread={thread} elsewhere={elsewhere} onAll={onAll} />
        </div>
      </div>
    </div>
  )
}

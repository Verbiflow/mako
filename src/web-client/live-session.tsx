import { useEffect, useRef } from "react"
import { AcpPanel } from "@/components/viewer/acp-panel"
import { PromptQueue } from "@/components/composer/prompt-queue"
import { acp, activeLiveAcp, useAcp } from "@/state/acp"
import { useWebClient } from "./client"
import { Composer } from "./composer"
import { noteAnswered } from "./install"
import { webHarnessLabel } from "./labels"
import { reducedMotion } from "./motion"
import type { WebSession } from "./threads"

/**
 * A Session live: opened on its owner through the gateway, drawn by the renderer's own conversation (`AcpPanel`: the
 * transcript, approvals and questions, exactly as on a Mac), with the queue and the phone's composer under it.
 */
export default function LiveSession({ session }: { session: WebSession }) {
  const client = useWebClient()
  const conversation = session.row.conversation
  const panel = useRef<HTMLDivElement>(null)
  // Opened once per conversation: the row it was opened from changes as the list does, and its batches say more.
  const opening = useRef(session)
  useEffect(() => {
    let close: (() => void) | undefined
    let left = false
    void client.conversations().then((conversations) => {
      if (!left) close = conversations.open(opening.current)
    })
    return () => {
      left = true
      close?.()
    }
  }, [client, conversation])
  useAnsweredLeaves(panel)
  const active = useAcp((state) => state.activeKey === conversation)
  const running = useAcp((state) => {
    const live = activeLiveAcp(state)
    return live?.session.status === "running" || live?.session.status === "starting"
  })
  const canceling = useAcp((state) => activeLiveAcp(state)?.canceling === true)
  const harness = webHarnessLabel(session.row.harness)
  return (
    <div ref={panel} className="web-live flex min-h-0 flex-1 flex-col" data-conversation={conversation}>
      {active ? <AcpPanel /> : <div className="flex-1" />}
      <div className="web-dock shrink-0">
        <div className="mx-auto w-full max-w-content px-3">
          <PromptQueue />
        </div>
        <Composer
          placeholder={running ? `Queue a message for ${harness}` : `Message ${harness}`}
          running={running}
          stopping={canceling}
          onStop={() => void acp.cancel()}
          onSend={(text, attachments) => acp.send(text, attachments)}
        />
      </div>
    </div>
  )
}

/**
 * An approval answered leaves the way it came. The desk's card is put away the moment its answer is sent (it waits on
 * its receipt hidden), so the phone draws its last frame in its place, the chosen answer marked, and lets that sink and
 * fade over 180 ms while the transcript takes the room. It's a picture of the card only: nothing in it can be pressed.
 */
function useAnsweredLeaves(panel: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const root = panel.current
    if (!root) return
    const answered = (event: Event) => {
      const option = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-permission-option]") : null
      const card = option?.closest<HTMLElement>("[data-permission]")
      if (!option || !card) return
      noteAnswered()
      if (reducedMotion()) return
      const bounds = card.getBoundingClientRect()
      // SAFETY: a deep clone of an element is an element of the same kind.
      const ghost = card.cloneNode(true) as HTMLElement
      ghost.removeAttribute("data-permission")
      ghost.setAttribute("aria-hidden", "true")
      ghost.inert = true
      ghost.classList.add("web-approval-ghost")
      ghost.querySelector(`[data-permission-option="${option.dataset["permissionOption"]}"]`)?.setAttribute("data-chosen", "")
      Object.assign(ghost.style, { position: "fixed", left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, margin: "0" })
      document.querySelector(".web-app")?.append(ghost)
      void ghost
        .animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translate3d(0, 16px, 0) scale(0.98)" }], { duration: 180, delay: 90, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "forwards" })
        .finished.finally(() => ghost.remove())
    }
    // Before the desk's own handler: the card is still drawn as the person saw it.
    root.addEventListener("click", answered, { capture: true })
    return () => root.removeEventListener("click", answered, { capture: true })
  }, [panel])
}

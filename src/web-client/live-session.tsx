import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { SquareIcon } from "lucide-react"
import { AcpPanel } from "@/components/viewer/acp-panel"
import { PromptQueue } from "@/components/composer/prompt-queue"
import { acp, activeLiveAcp, useAcp } from "@/state/acp"
import { cn } from "@/lib/utils"
import { useWebClient } from "./client"
import { webHarnessLabel } from "./labels"
import { SendGlyph } from "./glyphs"
import type { WebSession } from "./threads"

/**
 * A Session live: opened on its owner through the gateway, drawn by the renderer's own conversation (`AcpPanel`: the
 * transcript, approvals and questions, exactly as on a Mac), with the queue and the phone's composer under it.
 */
export default function LiveSession({ session }: { session: WebSession }) {
  const client = useWebClient()
  const conversation = session.row.conversation
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
  const active = useAcp((state) => state.activeKey === conversation)
  return (
    <div className="web-live flex min-h-0 flex-1 flex-col" data-conversation={conversation}>
      {active ? <AcpPanel /> : <div className="flex-1" />}
      <div className="web-dock shrink-0">
        <div className="mx-auto w-full max-w-content px-3">
          <PromptQueue />
        </div>
        <Composer harness={session.row.harness} />
      </div>
    </div>
  )
}

/**
 * The phone's composer: a message to an idle Session runs, one to a working Session queues behind its turn (or steers
 * it, from the queue), as the desktop's composer does; Stop stops the turn. Return makes a new line; the button sends.
 */
function Composer({ harness }: { harness: string }) {
  const [text, setText] = useState("")
  const input = useRef<HTMLTextAreaElement>(null)
  const running = useAcp((state) => {
    const live = activeLiveAcp(state)
    return live?.session.status === "running" || live?.session.status === "starting"
  })
  const canceling = useAcp((state) => activeLiveAcp(state)?.canceling === true)
  useLayoutEffect(() => {
    const node = input.current
    if (!node) return
    node.style.height = "auto"
    node.style.height = `${Math.min(node.scrollHeight, 180)}px`
  }, [text])
  const send = async () => {
    const message = text.trim()
    if (!message) return
    setText("")
    const sent = await acp.send(message)
    if (!sent) setText((current) => current || message)
  }
  return (
    <form
      className="web-composer"
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      <textarea
        ref={input}
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={1}
        enterKeyHint="send"
        placeholder={running ? `Queue a message for ${webHarnessLabel(harness)}` : `Message ${webHarnessLabel(harness)}`}
        aria-label="Message"
        className="web-composer-input"
        onKeyDown={(event) => {
          // A hardware keyboard sends with ⌘↩, as on a Mac; ↩ alone is a new line, as phones expect.
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void send()
          }
        }}
      />
      {running && !text.trim() ? (
        <button type="button" onClick={() => void acp.cancel()} disabled={canceling} className={cn("web-send web-stop")} aria-label="Stop the turn">
          <SquareIcon className="size-3.5 fill-current" />
        </button>
      ) : (
        <button type="submit" disabled={!text.trim()} className="web-send" aria-label={running ? "Queue message" : "Send"}>
          <SendGlyph />
        </button>
      )}
    </form>
  )
}

import { useState } from "react"
import { CheckIcon, CircleIcon, HourglassIcon } from "lucide-react"
import { useAcp } from "@/state/acp"
import { scopedLiveAcp, useConversationScope } from "@/state/conversation-scope"
import { stopWaiting, waitLineWords } from "@/state/turn-wait-line"
import type { TurnWaitLine } from "@mako/host/contracts/turn-waits"

/**
 * The end of the transcript while the conversation's agent waits for its turn's wait (`wait` on the `mako` server):
 * what it waits for and until when, each thing it named ticked off as it's met. It clears by itself when the wait ends
 * (fired, ended by a move, a Stop or the agent), and Stop waiting is its only action: the wait ends, waking no one.
 * Quiet, as the background work line is: an hourglass and words in the event lines' faint ink.
 */
export function TurnWaitLineView() {
  const scope = useConversationScope()
  const held = useAcp((state) => {
    const live = scopedLiveAcp(state, scope)
    return live?.turnWait ? { key: live.key, line: live.turnWait } : null
  }, (left, right) => left === right || (left?.key === right?.key && left?.line === right?.line))
  if (!held) return null
  return <WaitLine key={held.line.wait} conversation={held.key} line={held.line} />
}

export function WaitLine({ conversation, line }: { conversation: string; line: TurnWaitLine }) {
  const [stopping, setStopping] = useState(false)
  // Which day its time falls on, as the line first drew: a wait outlives few midnights, and its words don't tick.
  const [shownAt] = useState(Date.now)
  const several = line.items.length > 1
  return (
    <div role="status" data-turn-wait-line className="flex min-w-0 flex-col gap-1 py-1 text-ui text-muted-foreground animate-in fade-in-0 duration-200 ease-[var(--ease-out)]">
      <div className="flex min-h-8 min-w-0 items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center">
          <HourglassIcon aria-hidden className="size-3.5" />
        </span>
        <span className="min-w-0 text-pretty" data-turn-wait-words>{waitLineWords(line, shownAt)}</span>
        <button
          type="button"
          disabled={stopping}
          data-turn-wait-stop
          onClick={() => {
            setStopping(true)
            void stopWaiting(conversation, line.wait).then((ended) => { if (!ended) setStopping(false) })
          }}
          className="pressable ml-auto shrink-0 px-1.5 py-0.5 text-label text-faint hover:bg-fill-hover hover:text-foreground disabled:opacity-40"
        >
          {stopping ? "Stopping" : "Stop waiting"}
        </button>
      </div>
      {line.items.length ? (
        <ul className="flex min-w-0 flex-col gap-0.5 pl-7 text-label">
          {line.items.map((item, index) => (
            <li key={`${index}:${item.words}`} data-turn-wait-item={item.met ? "met" : "pending"} className="flex min-w-0 items-center gap-1.5">
              {item.met
                ? <CheckIcon aria-label="met" className="size-3 shrink-0 text-foreground" />
                : <CircleIcon aria-label="pending" className="size-2.5 shrink-0 text-faint" />}
              <span className={item.met ? "min-w-0 truncate text-foreground" : "min-w-0 truncate"}>{item.words}</span>
            </li>
          ))}
          {several ? <li className="text-faint">{line.returnWhen === "all" ? "Wakes when all are met" : "Wakes on the first met"}</li> : null}
        </ul>
      ) : null}
    </div>
  )
}

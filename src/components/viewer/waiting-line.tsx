import { use, useContext, useEffect, useState } from "react"
import { HourglassIcon } from "lucide-react"
import { childLine, childStateOf, readableStep } from "@mako/host/contracts/children"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { Elapsed } from "@/components/inspector/elapsed"
import { WorkGlyph } from "@/components/inspector/work-glyph"
import { FinMark } from "@/components/stage/child-tabs"
import { RoutedOpenContext } from "@/components/transcript/routed-open"
import { formatTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useAcp } from "@/state/acp"
import { useAcpConversation } from "@/state/acp-state"
import { openFinInApex } from "@/state/apex-fins"
import { scopedLiveAcp, useConversationScope } from "@/state/conversation-scope"
import { stage } from "@/state/stage"
import { QUEUED_AFTER_MS, queuedAt, useConversationAtWork, useConversationWaiting, waitingWords } from "@/state/waiting"
import { ShowAgentsContext } from "./show-agents"

/** Opens what the conversation waits on: a Fin in place, anything else in the Agents panel. */
function useOpenWork(key: string | undefined): (agent: NativeAgent) => void {
  const thread = useAcpConversation(key, (conversation) => conversation?.threadId)
  const title = useAcpConversation(key, (conversation) => conversation?.title)
  const routed = use(RoutedOpenContext)
  const showAgents = useContext(ShowAgentsContext)
  return (agent) => {
    if (!agent.child) return showAgents ? showAgents() : stage.open("agents")
    if (routed) routed(agent)
    else if (thread) openFinInApex(thread, title ?? "Apex", agent)
  }
}

function useLiveKey(): string | undefined {
  const scope = useConversationScope()
  return useAcp((state) => scopedLiveAcp(state, scope)?.key)
}

/** When the oldest message still waiting to be sent was written, once it has waited `QUEUED_AFTER_MS`. */
function useQueuedSince(key: string | undefined): number | undefined {
  const since = useAcpConversation(key, (conversation) => (conversation?.kind === "live" ? queuedAt(conversation) : undefined))
  const [due, setDue] = useState<number>()
  // One timer to the minute's end, never a tick: the line appears once and says a time that doesn't move.
  useEffect(() => {
    if (since === undefined) return
    const timer = setTimeout(() => setDue(since), Math.max(0, since + QUEUED_AFTER_MS - Date.now()))
    return () => clearTimeout(timer)
  }, [since])
  return since !== undefined && due === since ? since : undefined
}

/**
 * The end of an Apex's transcript once its turn has ended and it waits on its Fins: "Waiting on Docs pass, Token
 * sweep, and 4 other Fins", each name opening its Fin. Past three it names the first two and counts the rest. A
 * message held in the queue for a minute reads "Queued since 3:42 PM" instead. Quiet, as the lines beside it are (a
 * turn's wait, background work): an hourglass and words in the event lines' ink. Read from the roster the window
 * holds (`waitingOf`); a Thread with no Fins says its background work on `BackgroundWorkLine`.
 */
export function WaitingLine() {
  const key = useLiveKey()
  const waiting = useConversationWaiting(key)
  const queued = useQueuedSince(key)
  const open = useOpenWork(key)
  if (queued === undefined && !waiting.fins) return null
  const { named, rest } = waitingWords(waiting)
  return (
    <div role="status" data-waiting-line={queued === undefined ? "waiting" : "queued"} className="flex min-h-8 min-w-0 items-center gap-2 py-1 text-ui text-muted-foreground">
      <span className="flex size-5 shrink-0 items-center justify-center">
        <HourglassIcon aria-hidden className="size-3.5" />
      </span>
      {queued !== undefined ? (
        <span>Queued since {formatTime(queued)}</span>
      ) : (
        <span className="min-w-0 truncate">
          Waiting on{" "}
          {named.map((agent, index) => (
            <span key={`${agent.bindingId}:${agent.nativeId}`}>
              {index ? (index === named.length - 1 && !rest ? (named.length > 2 ? ", and " : " and ") : ", ") : null}
              <button type="button" data-waiting-on={agent.nativeId} onClick={() => open(agent)} title={`Open ${agent.title}`} className="pressable text-foreground hover:underline">
                {agent.title || agent.detail}
              </button>
            </span>
          ))}
          {rest ? `${named.length ? (named.length > 1 ? ", and " : " and ") : ""}${rest}` : null}
        </span>
      )}
    </div>
  )
}

/**
 * Beside "Jump to latest", for a reader away from the end: how many things are at work (Fins, background commands,
 * subagents), opening in place onto one row each with its state and how long it has stood, each a way to it.
 */
export function ActivityPill() {
  const key = useLiveKey()
  const work = useConversationAtWork(key)
  const [open, setOpen] = useState(false)
  const openWork = useOpenWork(key)
  const count = work.items.length
  if (!count) return null
  return (
    <div data-activity-pill={count} className="relative flex">
      {open ? (
        <ul data-activity-rows className="absolute bottom-full left-1/2 mb-2 flex max-h-64 w-80 -translate-x-1/2 flex-col overflow-y-auto bg-raised py-1 ring-1 ring-hairline">
          {work.items.map((agent) => (
            <li key={`${agent.bindingId}:${agent.nativeId}`}>
              <button type="button" onClick={() => openWork(agent)} className="pressable flex h-7 w-full min-w-0 items-center gap-2 px-2.5 text-left text-label text-faint hover:bg-fill-hover">
                {agent.child ? <FinMark agent={agent} state={childStateOf(agent)} read cut="var(--raised)" size={16} /> : <WorkGlyph work={agent.work} provider={agent.provider} className="size-3.5 shrink-0" />}
                <span className="min-w-0 shrink-0 max-w-[55%] truncate text-ui text-foreground">{agent.title || agent.detail}</span>
                <span className="min-w-0 flex-1 truncate">{stateWords(agent)}</span>
                <Elapsed agent={agent} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn("pressable flex h-7 items-center gap-1.5 rounded-full bg-raised px-3 text-ui ring-1 ring-hairline", open ? "text-foreground" : "text-muted-foreground")}
      >
        <span aria-hidden className="animate-live size-1.5 rounded-full bg-sea" />
        {count} at work
      </button>
    </div>
  )
}

/** What a row says of its work: a Fin's line as its Shiver row says it, anything else its last step. */
function stateWords(agent: NativeAgent): string {
  if (agent.child) return childLine(childStateOf(agent)) ?? ""
  return (agent.state.kind === "working" ? readableStep(agent.state.activity) : undefined) ?? ""
}

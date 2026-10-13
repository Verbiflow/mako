import { memo } from "react"
import { HourglassIcon } from "lucide-react"
import { acp, useAcp } from "@/state/acp"
import { stage } from "@/state/stage"
import { scopedLiveAcp, useConversationScope } from "@/state/conversation-scope"
import { backgroundWork, backgroundWorkText } from "@mako/host/contracts/background-work"
import { Elapsed, WorkGlyph } from "@/components/inspector/agents-panel"
import type { NativeAgent } from "@/lib/types"

interface Waiting {
  key: string
  text: string
  named: readonly NativeAgent[]
  unnamed: number
  stopping: boolean
}

/** Entries compare by identity, which `reconcileRoster` keeps while unchanged, so another conversation's batch wakes nothing here. */
function sameWork(left: Waiting | null, right: Waiting | null): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return left.key === right.key && left.text === right.text && left.unnamed === right.unnamed && left.stopping === right.stopping &&
    left.named.length === right.named.length && left.named.every((agent, index) => agent === right.named[index])
}

/** Named entries the line lists before it counts the rest. */
const SHOWN = 3

/**
 * The end of the transcript while the turn has ended and the provider still
 * runs work it will wake on: what runs, for how long, and what it last did.
 * It is quiet on purpose, an hourglass and plain words in the faint ink of
 * the event lines it turns into: when a piece of work settles and the
 * provider wakes, the provider's turn draws its own event line and this
 * line loses that entry. Nothing here animates; only the elapsed times move.
 */
export function BackgroundWorkLine() {
  const scope = useConversationScope()
  const work = useAcp((state): Waiting | null => {
    const live = scopedLiveAcp(state, scope)
    const found = live ? backgroundWork(live.session, live.nativeAgents) : null
    return found && live
      ? { key: live.key, text: backgroundWorkText(found), named: found.named, unnamed: found.unnamed, stopping: live.canceling }
      : null
  }, sameWork)
  if (!work) return null
  const shown = work.named.slice(0, SHOWN)
  const more = work.named.length - shown.length + work.unnamed
  return (
    <div role="status" data-background-work className="flex min-w-0 flex-col gap-1 py-1 text-ui text-muted-foreground animate-in fade-in-0 duration-200 ease-[var(--ease-out)]">
      <div className="flex min-h-8 min-w-0 items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center">
          <HourglassIcon aria-hidden className="size-3.5" />
        </span>
        <span className="min-w-0 truncate">Waiting on {work.text}</span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => stage.open("agents")}
            className="pressable rounded-md px-1.5 py-0.5 text-label text-faint hover:bg-fill-hover hover:text-foreground"
          >
            Show in Agents
          </button>
          <button
            type="button"
            disabled={work.stopping}
            title="Stop ends every background task of this session"
            onClick={() => void acp.stopBackground(work.key)}
            className="pressable rounded-md px-1.5 py-0.5 text-label text-faint hover:bg-fill-hover hover:text-foreground disabled:opacity-40"
          >
            {work.stopping ? "Stopping" : "Stop all"}
          </button>
        </span>
      </div>
      {shown.map((agent) => <WorkItem key={`${agent.bindingId}:${agent.nativeId}`} agent={agent} />)}
      {more > 0 ? <p className="pl-7 text-label text-faint">and {more} more</p> : null}
    </div>
  )
}

const WorkItem = memo(function WorkItem({ agent }: { agent: NativeAgent }) {
  const said = agent.state.kind === "working" ? agent.state.activity : undefined
  const uses = agent.usage?.toolUses
  return (
    <div data-native-work={agent.work ?? "agent"} className="flex min-w-0 items-center gap-2 pl-7 text-label text-faint">
      <WorkGlyph work={agent.work} className="size-3 shrink-0" />
      <span className="min-w-0 shrink truncate text-muted-foreground">{agent.title || agent.detail}</span>
      {said ? <span className="min-w-0 flex-1 truncate">· {said}</span> : <span className="flex-1" />}
      {uses ? <span className="tabular shrink-0">{uses} {uses === 1 ? "tool use" : "tool uses"}</span> : null}
      <Elapsed agent={agent} />
    </div>
  )
})

import { memo, useContext } from "react"
import { HourglassIcon } from "lucide-react"
import { acp, useAcp } from "@/state/acp"
import { stage } from "@/state/stage"
import { scopedLiveAcp, useConversationScope } from "@/state/conversation-scope"
import { backgroundWorkText } from "@mako/host/contracts/background-work"
import { conversationWork } from "@/state/acp-state"
import { readableStep } from "@mako/host/contracts/children"
import { WorkGlyph } from "@/components/inspector/work-glyph"
import { Elapsed } from "@/components/inspector/elapsed"
import { Shimmer } from "@/components/ui/shimmer"
import { ShowAgentsContext } from "./show-agents"
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

/**
 * The end of the transcript while the turn has ended and the provider still
 * runs work it will wake on: what runs, for how long, and what it last did.
 * It is quiet on purpose, an hourglass and words in the faint ink of the
 * event lines it turns into: when a piece of work settles and the provider
 * wakes, the provider's turn draws its own event line and this line loses
 * that entry. Its words sweep while the work runs, as every running step's
 * do; the elapsed times count.
 */
export function BackgroundWorkLine() {
  const scope = useConversationScope()
  const showAgents = useContext(ShowAgentsContext)
  const work = useAcp((state): Waiting | null => {
    const live = scopedLiveAcp(state, scope)
    const found = live ? conversationWork(state, live) : null
    return found && live
      ? { key: live.key, text: backgroundWorkText(found), named: found.named, unnamed: found.unnamed, stopping: live.canceling }
      : null
  }, sameWork)
  if (!work) return null
  return (
    <div role="status" data-background-work className="flex min-w-0 flex-col gap-1 py-1 text-ui text-muted-foreground animate-in fade-in-0 duration-200 ease-[var(--ease-out)]">
      <div className="flex min-h-8 min-w-0 items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center">
          <HourglassIcon aria-hidden className="size-3.5" />
        </span>
        <Shimmer text={`Waiting on ${work.text}`} className="min-w-0 truncate" />
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => (showAgents ? showAgents() : stage.open("agents"))}
            className="pressable px-1.5 py-0.5 text-label text-faint hover:bg-fill-hover hover:text-foreground"
          >
            Show in Agents
          </button>
          <button
            type="button"
            disabled={work.stopping}
            title="Stop ends every background task of this session"
            onClick={() => void acp.stopBackground(work.key)}
            className="pressable px-1.5 py-0.5 text-label text-faint hover:bg-fill-hover hover:text-foreground disabled:opacity-40"
          >
            {work.stopping ? "Stopping" : "Stop all"}
          </button>
        </span>
      </div>
      {/* Every named entry is listed; a long list scrolls in place rather than folding into "and N more". */}
      <div className="flex max-h-52 min-w-0 flex-col gap-1 overflow-y-auto">
        {work.named.map((agent) => <WorkItem key={`${agent.bindingId}:${agent.nativeId}`} agent={agent} />)}
      </div>
      {work.unnamed > 0 ? (
        <p className="pl-7 text-label text-faint">
          {work.unnamed === 1 ? "1 more the provider counts without naming it" : `${work.unnamed} more the provider counts without naming them`}
        </p>
      ) : null}
    </div>
  )
}

const WorkItem = memo(function WorkItem({ agent }: { agent: NativeAgent }) {
  const said = agent.state.kind === "working" ? readableStep(agent.state.activity) : undefined
  const uses = agent.usage?.toolUses
  return (
    <div data-native-work={agent.work ?? "agent"} className="flex min-w-0 items-center gap-2 pl-7 text-label text-faint">
      <WorkGlyph work={agent.work} provider={agent.provider} className="size-3 shrink-0" />
      <span className="min-w-0 shrink truncate text-muted-foreground">{agent.title || agent.detail}</span>
      {said ? <span className="min-w-0 flex-1 truncate">· {said}</span> : <span className="flex-1" />}
      {uses ? <span className="tabular shrink-0">{uses} {uses === 1 ? "tool use" : "tool uses"}</span> : null}
      <Elapsed agent={agent} />
    </div>
  )
})

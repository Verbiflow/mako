import { memo, use, useState } from "react"
import { toast } from "sonner"
import { CornerDownRightIcon, MoveRightIcon } from "lucide-react"
import { childStateOf, type Routed, type RoutedAnswer } from "@mako/host/contracts/children"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useTranscriptSource } from "@/components/transcript/source-context"
import { RoutedOpenContext } from "@/components/transcript/routed-open"
import { useAcp } from "@/state/acp"
import { openChildInLead, redirectRouted, useThreadChildren } from "@/state/lead-children"

const DELIVERY = {
  turn: "",
  steer: "at its next step",
  queued: "after its current turn",
} satisfies Record<RoutedAnswer["delivery"], string>

/** A stopped Thread's delegation is over: nothing is moved to it. */
function stopped(agent: NativeAgent): boolean {
  const state = childStateOf(agent)
  return state.kind === "ended" && state.outcome === "stopped"
}

/**
 * Where the lead sent a message, as one line where its call returned: the
 * Thread by name, opened with a press, and while the lead's conversation is
 * here, a way to move it to another of its Threads. Read from the call and
 * its answer, so a saved turn draws the same line.
 */
export const RoutedLine = memo(function RoutedLine({ routed, landed }: { routed: Routed; landed?: RoutedAnswer }) {
  const source = useTranscriptSource()
  const leadThread = useAcp((state) => (source.liveId ? state.conversations[source.liveId]?.threadId : undefined))
  const leadTitle = useAcp((state) => (source.liveId ? state.conversations[source.liveId]?.title : undefined))
  const children = useThreadChildren(leadThread)
  const open = use(RoutedOpenContext)
  const [moved, setMoved] = useState<string>()
  const target = children.find((agent) => (landed ? agent.child?.thread === landed.child : agent.title === routed.to))
  const others = children.filter((agent) => agent !== target && agent.child?.thread && !stopped(agent))
  const name = target?.title ?? routed.to
  const when = moved ? "" : landed ? DELIVERY[landed.delivery] : ""
  const openTarget = (agent: NativeAgent) => {
    if (open) return open(agent)
    if (leadThread) openChildInLead(leadThread, leadTitle ?? "Lead", agent)
  }
  const redirect = async (agent: NativeAgent) => {
    if (!source.liveId || !landed || !agent.child?.thread) return
    const answer = await redirectRouted(source.liveId, { from: landed.child, request: landed.request, to: agent.child.thread })
    if (!answer) return
    setMoved(agent.title)
    if (!answer.withdrawn) toast(`${name} had already started on it`, { description: `${agent.title} has it now too.` })
  }
  return (
    <div data-routed={routed.to} className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-label text-faint">
      <CornerDownRightIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="shrink-0">{routed.forward ? "Passed your message to" : "Sent a message to"}</span>
      <button
        type="button"
        disabled={!target}
        onClick={() => target && openTarget(target)}
        title={target ? `Open ${name}` : undefined}
        className="pressable flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-ui text-foreground hover:bg-fill-hover disabled:pointer-events-none"
      >
        {target ? <HarnessIcon harness={target.provider} className="size-3.5 shrink-0" /> : null}
        <span className="min-w-0 truncate">{name}</span>
      </button>
      {when ? <span className="shrink-0">{when}</span> : null}
      {moved ? (
        <span data-routed-moved className="flex min-w-0 items-center gap-1 text-muted-foreground">
          <MoveRightIcon aria-hidden className="size-3 shrink-0" />
          <span className="truncate">moved to {moved}</span>
        </span>
      ) : others.length && landed && source.liveId && routed.forward ? (
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" data-routed-elsewhere className="pressable flex h-6 shrink-0 items-center rounded-md px-1.5 text-label text-faint hover:bg-fill-hover hover:text-foreground">
              Send elsewhere
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 gap-0.5 p-1">
            <p className="px-2 pt-1 pb-1.5 text-label text-faint">Move your message to</p>
            {others.map((agent) => (
              <button
                key={agent.nativeId}
                type="button"
                onClick={() => void redirect(agent)}
                className="pressable flex h-8 items-center gap-2 rounded-md px-2 text-left text-ui text-foreground hover:bg-fill-hover"
              >
                <HarnessIcon harness={agent.provider} className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">{agent.title}</span>
              </button>
            ))}
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  )
})

import { memo, use, useState } from "react"
import { toast } from "sonner"
import { CornerDownRightIcon, MoveRightIcon, ReplyIcon } from "lucide-react"
import type { Routed, RoutedAnswer } from "@mako/host/contracts/children"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { childStateOf } from "@mako/host/contracts/children"
import { FinMark } from "@/components/stage/child-tabs"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useTranscriptSource } from "@/components/transcript/source-context"
import { RoutedOpenContext } from "@/components/transcript/routed-open"
import { useAcp } from "@/state/acp"
import { address, addresseeOf, openFinInApex, redirectRouted, useThreadChildren } from "@/state/apex-fins"
import { FIN_WORD } from "@mako/host/contracts/agents"

const DELIVERY = {
  turn: "",
  steer: "at its next step",
  queued: "after its current turn",
  interrupt: "after stopping its turn",
} satisfies Record<RoutedAnswer["delivery"], string>

/**
 * Where a message went from an Apex's conversation, as one line: where the
 * Apex's call returned, or where the person wrote to a Fin straight
 * (`routed.direct`). The Fin by name, opened with a press, and while the
 * Apex's conversation is here, Reply, which writes the next message to that
 * Fin, and a way to move this one to another of its Fins. Read from the call
 * and its answer, or the direct message's record, so a saved turn draws the
 * same line.
 */
export const RoutedLine = memo(function RoutedLine({ routed, landed }: { routed: Routed; landed?: RoutedAnswer }) {
  const source = useTranscriptSource()
  const apexThread = useAcp((state) => (source.liveId ? state.conversations[source.liveId]?.threadId : undefined))
  const apexTitle = useAcp((state) => (source.liveId ? state.conversations[source.liveId]?.title : undefined))
  const children = useThreadChildren(apexThread)
  const open = use(RoutedOpenContext)
  const [moved, setMoved] = useState<string>()
  const target = children.find((agent) => (landed ? agent.child?.thread === landed.child : agent.title === routed.to))
  const others = children.filter((agent) => agent !== target && agent.child?.thread)
  const name = target?.title ?? routed.to
  const when = moved ? "" : landed ? DELIVERY[landed.delivery] : ""
  const openTarget = (agent: NativeAgent) => {
    if (open) return open(agent)
    if (apexThread) openFinInApex(apexThread, apexTitle ?? "Apex", agent)
  }
  const redirect = async (agent: NativeAgent) => {
    if (!source.liveId || !landed || !agent.child?.thread) return
    const answer = await redirectRouted(source.liveId, { from: landed.child, request: landed.request, to: agent.child.thread })
    if (!answer) return
    setMoved(agent.title)
    if (!answer.withdrawn) toast(`${name} had already started on it`, { description: `${agent.title} has it now too.` })
  }
  const replyTo = source.liveId && target ? addresseeOf(target) : undefined
  const reply = () => {
    if (!source.liveId || !replyTo) return
    address(source.liveId, replyTo)
    window.dispatchEvent(new Event("mako:focus-composer"))
  }
  return (
    <div data-routed={routed.to} data-routed-direct={routed.direct ? "" : undefined} className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-label text-faint">
      <CornerDownRightIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="shrink-0">{routed.direct ? `${FIN_WORD} ·` : routed.forward ? "Passed your message to" : "Sent a message to"}</span>
      <button
        type="button"
        disabled={!target}
        onClick={() => target && openTarget(target)}
        title={target ? `Open ${name}` : undefined}
        className="pressable flex h-6 max-w-full min-w-0 items-center gap-1.5 px-1.5 text-ui text-foreground hover:bg-fill-hover disabled:pointer-events-none"
      >
        {target ? <FinMark agent={target} state={childStateOf(target)} read cut="var(--surface)" size={16} /> : null}
        <span className="min-w-0 truncate">{name}</span>
      </button>
      {routed.direct ? <span className="shrink-0">· direct</span> : null}
      {when ? <span className="shrink-0">{routed.direct ? `· ${when}` : when}</span> : null}
      {replyTo && !moved ? (
        <button
          type="button"
          data-routed-reply
          onClick={reply}
          title={`Write your next message to ${replyTo.name}, with no turn of this Thread's`}
          className="pressable flex h-6 shrink-0 items-center gap-1 px-1.5 text-label text-faint hover:bg-fill-hover hover:text-foreground"
        >
          <ReplyIcon aria-hidden className="size-3" />
          Reply
        </button>
      ) : null}
      {moved ? (
        <span data-routed-moved className="flex min-w-0 items-center gap-1 text-muted-foreground">
          <MoveRightIcon aria-hidden className="size-3 shrink-0" />
          <span className="truncate">moved to {moved}</span>
        </span>
      ) : others.length && landed && source.liveId && routed.forward ? (
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" data-routed-elsewhere className="pressable flex h-6 shrink-0 items-center px-1.5 text-label text-faint hover:bg-fill-hover hover:text-foreground">
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
                className="pressable flex h-8 items-center gap-2 px-2 text-left text-ui text-foreground hover:bg-fill-hover"
              >
                <FinMark agent={agent} state={childStateOf(agent)} read cut="var(--popover)" size={16} />
                <span className="min-w-0 truncate">{agent.title}</span>
              </button>
            ))}
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  )
})

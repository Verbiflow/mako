import { use, useState } from "react"
import { childGroup, childLine, childStateOf, childWord } from "@mako/host/contracts/children"
import { APEX_WORD, FIN_WORD, finsWord } from "@mako/host/contracts/agents"
import { XIcon } from "lucide-react"
import { LiveMark } from "@/components/ui/live-mark"
import { finMarkState, motionOf } from "@/lib/live-mark-state"
import { ApexMark } from "@/components/ui/apex-mark"
import { useAcp } from "@/state/acp"
import { unaddress, useAddressee, useThreadChildren, useThreadRollup } from "@/state/apex-fins"
import { AgentsSheet } from "./agents"
import { FinOfApexContext, OpenChildContext } from "./fin-of-apex"
import { WebHarnessIcon } from "./harness-icon"
import { finTuningLine } from "@mako/host/contracts/fin-tuning"

/**
 * Over the phone's composer in an Apex's Thread: who a message goes to. In the Apex's own view, the Apex, which passes
 * it on, or the Fin a routing line's Reply chose, straight; in one of its Fins, that Fin directly, its Apex told of it.
 */
export function FinOfApexNote({ conversation }: { conversation: string }) {
  const apex = use(FinOfApexContext)
  const thread = useAcp((state) => state.conversations[conversation]?.threadId)
  const title = useAcp((state) => state.conversations[conversation]?.title)
  const isApex = useThreadRollup(apex ? undefined : thread).total > 0
  const addressee = useAddressee((state) => (apex ? undefined : state.to[conversation]))
  if (!apex && !isApex) return null
  if (addressee)
    return (
      <div data-child-note="direct" data-addressee={addressee.name} className="mx-auto flex w-full max-w-content min-w-0 items-center gap-1.5 px-4 pt-2 text-label text-faint">
        <span className="flex h-7 min-w-0 shrink items-center gap-1.5 bg-raised pr-0.5 pl-2.5 text-label text-foreground">
          <LiveMark kind="fin" state="idle" size={16} cut="var(--raised)" className="live-mark-still">
            <WebHarnessIcon harness={addressee.provider} />
          </LiveMark>
          <span className="min-w-0 truncate">To {addressee.title}</span>
          <button type="button" aria-label={`Write to ${title ?? `the ${APEX_WORD}`} instead`} onClick={() => unaddress(conversation)} className="pressable flex size-6 shrink-0 items-center justify-center text-faint">
            <XIcon className="size-3" />
          </button>
        </span>
        <span className="min-w-0 truncate">{title ?? `Its ${APEX_WORD}`} sees what you said</span>
      </div>
    )
  return (
    <div data-child-note={apex ? "fin" : "apex"} className="mx-auto flex w-full max-w-content items-center gap-1.5 px-4 pt-2 text-label text-faint">
      <ApexMark className="size-3" />
      {apex ? <>Straight to this {FIN_WORD} · {apex} sees what you said</> : <>To the {APEX_WORD} · it passes it on to the right {FIN_WORD}</>}
    </div>
  )
}

/**
 * Under an Apex's bar on the phone: a chip for each of its Fins that needs the person or is at work, what needs
 * them first. A chip opens that Fin, its back button naming the Apex.
 */
export function PhoneChildChips({ thread, conversation }: { thread: string; conversation: string }) {
  const children = useThreadChildren(thread)
  const onOpen = use(OpenChildContext)
  const [roster, setRoster] = useState(false)
  if (!children.length) return null
  const shown = children.filter((agent) => {
    const group = childGroup(childStateOf(agent))
    return group === "needs" || group === "working"
  })
  return (
    <div data-child-chips className="web-scroll flex shrink-0 gap-1.5 overflow-x-auto px-3 pt-1 pb-2">
      <button
        type="button"
        data-apex-count={children.length}
        aria-label={`${finsWord(children.length)}, in Agents`}
        onClick={() => setRoster(true)}
        className="pressable flex h-8 shrink-0 items-center gap-1 bg-raised px-2.5 text-label text-muted-foreground"
      >
        <ApexMark className="size-3.5" />
        <span className="tabular">{children.length}</span>
      </button>
      <AgentsSheet conversation={conversation} open={roster} onDismiss={() => setRoster(false)} />
      {shown.map((agent) => (
        <button
          key={agent.nativeId}
          type="button"
          data-child-chip={agent.child?.thread}
          disabled={!agent.child?.conversation}
          title={agent.runsOn ? finTuningLine(agent.runsOn) : agent.model}
          onClick={() => onOpen?.(agent)}
          className="pressable flex h-8 max-w-56 shrink-0 items-center gap-1.5 bg-raised pr-2 pl-2 text-label text-foreground disabled:opacity-60"
        >
          <LiveMark kind="fin" state={finMarkState(childStateOf(agent))} motion={motionOf(childLine(childStateOf(agent)))} cut="var(--raised)" label={childWord(childStateOf(agent))}>
            <WebHarnessIcon harness={agent.provider} />
          </LiveMark>
          <span className="min-w-0 truncate">{agent.title}</span>
        </button>
      ))}
    </div>
  )
}

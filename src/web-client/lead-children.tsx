import { use, useState } from "react"
import { childGroup, childStateOf, threadsWord } from "@mako/host/contracts/children"
import { ChildStatusMark } from "@/components/stage/child-tabs"
import { LeadMark } from "@/components/ui/lead-mark"
import { useThreadChildren } from "@/state/lead-children"
import { AgentsSheet } from "./agents"
import { ChildOfLeadContext, OpenChildContext } from "./child-of-lead"
import { WebHarnessIcon } from "./harness-icon"

/** Over a child's composer on the phone: what's said there, its lead hears too. */
export function ChildOfLeadNote() {
  const lead = use(ChildOfLeadContext)
  if (!lead) return null
  return (
    <div data-child-note className="mx-auto flex w-full max-w-content items-center gap-1.5 px-4 pt-2 text-label text-faint">
      <LeadMark className="size-3" />
      {lead} hears what you say here
    </div>
  )
}

/**
 * Under a lead's bar on the phone: a chip for each of its Threads that needs the person or is at work, what needs
 * them first. A chip opens that Thread, its back button naming the lead.
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
        data-lead-count={children.length}
        aria-label={`${threadsWord(children.length)}, in Agents`}
        onClick={() => setRoster(true)}
        className="pressable flex h-8 shrink-0 items-center gap-1 rounded-full bg-raised px-2.5 text-label text-muted-foreground"
      >
        <LeadMark className="size-3.5" />
        <span className="tabular">{children.length}</span>
      </button>
      <AgentsSheet conversation={conversation} open={roster} onDismiss={() => setRoster(false)} />
      {shown.map((agent) => (
        <button
          key={agent.nativeId}
          type="button"
          data-child-chip={agent.child?.thread}
          disabled={!agent.child?.conversation}
          onClick={() => onOpen?.(agent)}
          className="pressable flex h-8 max-w-56 shrink-0 items-center gap-1.5 rounded-full bg-raised pr-2 pl-2.5 text-label text-foreground disabled:opacity-60"
        >
          <WebHarnessIcon harness={agent.provider} className="size-3.5" />
          <span className="min-w-0 truncate">{agent.title}</span>
          <ChildStatusMark state={childStateOf(agent)} read />
        </button>
      ))}
    </div>
  )
}

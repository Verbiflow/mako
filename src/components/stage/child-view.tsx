import { useEffect } from "react"
import { ChevronLeftIcon, CircleStopIcon } from "lucide-react"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { Action } from "@/components/ui/kit"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { LeadMark } from "@/components/ui/lead-mark"
import { acp, acpStore, useAcp } from "@/state/acp"
import { followCheckouts, useCheckoutHead } from "@/state/checkout-heads"
import { backToLead, childConversation, leadConversation, threadChildren, useLeadView, useThreadRollup, type ChildInLead } from "@/state/lead-children"
import { useOnScreen } from "@/state/thread-sessions"

/** The child open in place on screen, with its entry in its lead's roster: nothing while anything else is shown. */
function useChildInLead(): { open: ChildInLead; agent: NativeAgent | undefined } | null {
  const here = useOnScreen().thread
  const open = useLeadView((state) => (state.open && state.open.child === here ? state.open : null))
  const agent = useAcp((state) => (open ? threadChildren(state, open.lead).find((entry) => entry.child?.thread === open.child) : undefined))
  return open ? { open, agent } : null
}

/**
 * Over a child opened in its lead's Thread: back to the lead, then the child's
 * harness, name, where it runs and its branch, and Stop while it works.
 */
export function ChildBreadcrumb() {
  const shown = useChildInLead()
  const child = shown?.open.child
  const cwd = useAcp((state) => (child ? childConversation(state, child)?.cwd : undefined))
  const elsewhere = useAcp((state) => (child ? childConversation(state, child)?.elsewhere : undefined))
  useEffect(() => {
    if (cwd) followCheckouts([cwd])
  }, [cwd])
  const head = useCheckoutHead(cwd)
  if (!shown) return null
  const { open, agent } = shown
  const branch = head && head.kind !== "detached" ? head.name : undefined
  const working = agent?.stoppable === true
  const stop = () => {
    const lead = leadConversation(acpStore.get(), open.lead)
    if (lead && agent) void acp.stopAgent(lead.key, agent.nativeId)
  }
  return (
    <nav aria-label="Thread" data-child-breadcrumb className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline px-3 text-label whitespace-nowrap text-faint">
      <button
        type="button"
        onClick={backToLead}
        title={`Back to ${open.leadTitle}`}
        className="pressable flex h-6 shrink-0 items-center gap-1 rounded-md pr-1.5 pl-0.5 text-muted-foreground hover:bg-fill-hover hover:text-foreground"
      >
        <ChevronLeftIcon className="size-3.5" />
        <LeadMark className="size-3" />
        {open.leadTitle}
      </button>
      <span aria-hidden className="shrink-0 text-faint/70">/</span>
      {agent ? <HarnessIcon harness={agent.provider} className="size-3.5 shrink-0" /> : null}
      <span className="min-w-0 truncate text-ui font-medium text-foreground">{agent?.title ?? "Thread"}</span>
      <span className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden pl-1">
        <span className="truncate">{elsewhere ? capitalized(elsewhere) : "This Mac"}</span>
        {branch ? <span className="truncate font-mono text-label">· {branch}</span> : null}
      </span>
      {working ? (
        <Action size="xs" className="ml-auto shrink-0" onClick={stop}>
          <CircleStopIcon />
          Stop
        </Action>
      ) : null}
    </nav>
  )
}

function capitalized(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * Over the composer in a lead's Thread: who a message goes to. On the lead,
 * the lead, which passes it on; in one of its Threads open in place, that
 * Thread directly, its lead told of it in its next note.
 */
export function ChildComposerNote() {
  const shown = useChildInLead()
  const here = useOnScreen().thread
  const leads = useThreadRollup(shown ? undefined : here).total > 0
  if (!shown && !leads) return null
  return (
    <div data-child-note={shown ? "child" : "lead"} className="flex items-center gap-1.5 px-4 pt-2.5 text-label text-faint">
      <LeadMark className="size-3" />
      {shown ? <>Straight to {shown.agent?.title ?? "this Thread"} · {shown.open.leadTitle} sees what you said</> : <>To the lead · it passes it on to the right Thread</>}
    </div>
  )
}

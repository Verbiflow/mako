import { childLine, childStateOf, childWord } from "@mako/host/contracts/children"
import type { ChildState } from "@mako/host/contracts/agents"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { XIcon } from "lucide-react"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { LiveMark } from "@/components/ui/live-mark"
import { finMarkState, motionOf } from "@/lib/live-mark-state"
import { useHarnessIdentity, harnessLabel } from "@/lib/harness-label"
import { backToApex, useApexView, useThreadChildren } from "@/state/apex-fins"
import { inboxView } from "@/state/inbox-view"

/**
 * A Fin's live mark: the plain fin doing what the Fin does, its harness a corner badge. A Fin that finished and
 * hasn't been read wears the unread dot.
 */
export function FinMark({ agent, state, read, lit, cut, size }: { agent: NativeAgent; state: ChildState; read?: boolean; lit?: boolean; cut?: string; size?: number }) {
  const line = childLine(state)
  const unread = state.kind === "ended" && state.outcome === "done" && state.decision?.on !== "person" && !read
  return (
    <LiveMark kind="fin" state={unread ? "unread" : finMarkState(state)} motion={motionOf(line)} lit={lit} cut={cut} size={size} label={line ? `${childWord(state)}: ${line}` : childWord(state)}>
      <HarnessIcon harness={agent.provider} />
    </LiveMark>
  )
}

/**
 * The Fin opened in place, the one tab a Fin gets. A tab is something opened on purpose, so a Fin earns one only by
 * being opened (from the crew card, the rail or the Inbox) and gives it up on close; the rest of an Apex's Fins live in
 * those places, never here as they spawn.
 */
export function OpenFinTab({ thread }: { thread: string }) {
  const open = useApexView((state) => (state.open?.apex === thread ? state.open.child : undefined))
  const agent = useThreadChildren(open ? thread : undefined).find((entry) => entry.child?.thread === open)
  return agent ? <FinTab agent={agent} onClose={backToApex} /> : null
}

/** A Fin's tab, selected as it's the one shown, its close going back to its Apex. */
export function FinTab({ agent, onClose }: { agent: NativeAgent; onClose: () => void }) {
  useHarnessIdentity()
  const state = childStateOf(agent)
  return (
    <div className="session-tab group relative flex h-7 max-w-56 min-w-24 shrink items-center gap-0.5 overflow-hidden bg-raised text-foreground">
      <button
        type="button"
        role="tab"
        aria-selected
        tabIndex={0}
        data-child-tab={agent.child?.thread}
        onClick={inboxView.close}
        title={[`${agent.title} · ${harnessLabel(agent.provider)} · ${childWord(state)}`, childLine(state)].filter(Boolean).join("\n")}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-1.5 text-left text-ui font-medium"
      >
        <FinMark agent={agent} state={state} read lit cut="var(--raised)" />
        <span className="min-w-0 flex-1 truncate">{agent.title}</span>
      </button>
      <button
        type="button"
        aria-label={`Close ${agent.title}`}
        onClick={onClose}
        className="pressable flex size-5 shrink-0 items-center justify-center text-faint opacity-80 hover:bg-fill-hover hover:text-foreground"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  )
}

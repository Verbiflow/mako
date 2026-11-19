import { memo, useState, type ReactNode } from "react"
import { CheckIcon, XIcon } from "lucide-react"
import type { AutomationProposal } from "@mako/host/contracts/automations"
import { AutomationDiff } from "@/components/automations/automation-diff"
import { harnessLabel } from "@/components/rail/harness-meta"
import { LiveMark } from "@/components/ui/live-mark"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { formatUntil } from "@/lib/format"
import { APPROVE_WORDS, PROPOSAL_CHANGE_WORDS, PROPOSAL_STATUS_WORDS, whenAgo } from "@/lib/automation-words"
import { cn } from "@/lib/utils"
import { openRunThread } from "@/state/automations"
import { showAutomation } from "@/state/automations-view"

const SHORT = ["name", "prompt", "triggers"] as const

const BUTTON = "pressable flex h-7 items-center gap-1.5 px-2.5 text-label transition-colors disabled:opacity-50 [&_svg]:size-3"
const PRIMARY = "bg-foreground text-background hover:opacity-90"
const QUIET = "bg-fill-hover text-foreground hover:bg-fill-selected"

/**
 * An agent's proposal: who proposed it (its Thread, a link), why in its words, what changes, and Approve or Decline
 * while it waits; once decided, how it ended and why. The Inbox's card and the Automations view both draw this, and
 * each decides in its own way: the Inbox answers the ask that carries it, Automations the proposal itself.
 */
export const ProposalBlock = memo(function ProposalBlock({
  proposal,
  onDecide,
  compact = false,
  inThread = false,
  actions,
  className,
}: {
  /** More of the surface's own, at the end of the buttons' line (the Inbox's Open). */
  actions?: ReactNode
  /** Drawn where its proposing Thread is already named (the Inbox's card): no "by", and a way to its automation. */
  inThread?: boolean
  proposal: AutomationProposal
  /** True once the decision landed; false frees the buttons again. */
  onDecide: (approve: boolean) => Promise<boolean>
  /** In a row: no header of its own, the row names the automation. */
  compact?: boolean
  className?: string
}) {
  const [sending, setSending] = useState<"approve" | "decline" | null>(null)
  // A whole new definition is long: its prompt and triggers first, the rest a press away.
  const [whole, setWhole] = useState(proposal.change !== "create" && proposal.change !== "delete")
  const pending = proposal.status === "pending"
  const decide = async (approve: boolean) => {
    setSending(approve ? "approve" : "decline")
    const landed = await onDecide(approve).catch(() => false)
    if (!landed) setSending(null)
  }
  return (
    <div data-proposal={proposal.id} data-proposal-status={proposal.status} data-proposal-change={proposal.change} className={cn("flex flex-col gap-2.5", className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-label text-faint">
        <span className={cn("font-medium", pending ? "text-attention" : "text-muted-foreground")}>{compact ? PROPOSAL_CHANGE_WORDS[proposal.change] : PROPOSAL_STATUS_WORDS[proposal.status]}</span>
        {inThread ? null : <span aria-hidden>·</span>}
        {inThread ? null : <span>by</span>}
        {inThread ? null : <button
          type="button"
          data-proposal-by={proposal.by.conversation}
          title="Open the Thread that proposed it"
          onClick={() => void openRunThread({ thread: { conversation: proposal.by.conversation, request: "" } })}
          className="pressable inline-flex min-w-0 max-w-[22rem] items-center gap-1 px-0.5 text-muted-foreground hover:bg-fill-hover hover:text-foreground"
        >
          <LiveMark state="idle" size={14} label={proposal.by.harness ? `A Thread in ${harnessLabel(proposal.by.harness)}` : "A Thread"}>
            {proposal.by.harness ? <HarnessIcon harness={proposal.by.harness} /> : null}
          </LiveMark>
          <span className="truncate">{proposal.by.title ?? "its Thread"}</span>
        </button>}
        <span aria-hidden>·</span>
        <span className="tabular" title={new Date(proposal.at).toLocaleString()}>{whenAgo(proposal.at)}</span>
        {pending ? (
          <>
            <span aria-hidden>·</span>
            <span className="tabular" title={new Date(proposal.expiresAt).toLocaleString()}>expires {formatUntil(proposal.expiresAt)}</span>
          </>
        ) : null}
      </div>
      {proposal.why ? <p data-proposal-why className="text-ui text-foreground">“{proposal.why}”</p> : null}
      <AutomationDiff proposal={proposal} {...(!whole && { only: SHORT })} />
      {!whole ? (
        <button type="button" data-proposal-whole onClick={() => setWhole(true)} className="pressable -mt-1 w-fit px-1 text-label text-muted-foreground underline decoration-hairline underline-offset-2 hover:text-foreground">
          Show what it starts with, its limits and result
        </button>
      ) : null}
      {pending ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" data-proposal-answer="approve" disabled={sending !== null} onClick={() => void decide(true)} className={cn(BUTTON, PRIMARY)}>
            <CheckIcon />
            {APPROVE_WORDS[proposal.change]}
          </button>
          <button type="button" data-proposal-answer="decline" disabled={sending !== null} onClick={() => void decide(false)} className={cn(BUTTON, QUIET)}>
            <XIcon />
            Decline
          </button>
          {inThread && proposal.change !== "create" ? (
            <button type="button" data-proposal-show onClick={() => showAutomation(proposal.project, proposal.automation)} className="pressable flex h-7 items-center px-1.5 text-label text-muted-foreground hover:bg-fill-hover hover:text-foreground">
              Open in Automations
            </button>
          ) : null}
          {actions ? (
            <>
              <span className="flex-1" />
              {actions}
            </>
          ) : null}
        </div>
      ) : null}
      {pending ? (
        <p data-proposal-note className="-mt-1 text-label text-faint">{proposal.change === "delete" ? "Removed from .mako/automations.json" : proposal.change === "enable" ? "It then runs on its own on this Mac" : proposal.change === "create" ? "Saved to .mako/automations.json, off until you turn it on" : "Saved to .mako/automations.json"}</p>
      ) : (
        <p data-proposal-ended className={cn("text-label", proposal.status === "approved" ? "text-positive" : proposal.status === "stale" ? "text-caution" : "text-muted-foreground")}>
          {PROPOSAL_STATUS_WORDS[proposal.status]}
          {proposal.decidedAt ? ` ${whenAgo(proposal.decidedAt)}` : proposal.status === "expired" ? ` ${whenAgo(proposal.expiresAt)}` : ""}
          {proposal.note ? `: ${proposal.note}` : proposal.status === "stale" ? ": the automation changed after it was proposed, so approving it would have undone that. Nothing was applied." : proposal.status === "expired" ? ": no one decided within three days. Its agent can propose it again." : ""}
          {proposal.told === false && proposal.status !== "expired" ? " Its agent hasn't heard yet." : ""}
        </p>
      )}
    </div>
  )
})

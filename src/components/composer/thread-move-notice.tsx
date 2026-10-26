import { CheckIcon } from "lucide-react"
import type { ThreadMoveStep, ThreadReturnStep } from "@mako/host/contracts/cloud-threads"
import type { OutdatedRestore } from "@mako/host/contracts/restore-plan"
import { Notice, NoticeAction } from "@/components/ui/notice"
import { harnessLabel, useHarnessIdentity } from "@/lib/harness-label"
import { returnNotice } from "@/lib/restore-plan"
import { cn } from "@/lib/utils"
import { activeAcp, useAcp } from "@/state/acp"
import { application } from "@/state/application"
import { dismissOutdatedReturn, updateAndBringBack, useCloudMoves } from "@/state/cloud-moves"

/** A move's steps in the order they're taken, each in the words its step says. */
const STEPS = [
  { kind: "packing", words: "Sending its work ahead" },
  { kind: "handing-over", words: "Handing over" },
  { kind: "resuming", words: "Resuming in the cloud" },
] as const

/** A handoff's steps: its running turn is paused between sending ahead and the hand-over, and goes on in the cloud. */
const HANDOFF_STEPS = [
  { kind: "packing", words: "Sending ahead" },
  { kind: "pausing", words: "Pausing the turn" },
  { kind: "handing-over", words: "Handing over" },
  { kind: "resuming", words: "Continuing there" },
] as const

/** What each step means for the person, under the title. */
function detail(step: ThreadMoveStep, handOff: boolean): string {
  switch (step.kind) {
    case "packing":
      return handOff ? "Its worktree and sessions go ahead while its agent keeps working here." : "Its worktree and sessions go ahead while it still runs here."
    case "pausing":
      return "Its turn stops where it is. What it did so far is saved and goes with it."
    case "handing-over":
      return "This Mac let go of it; nothing runs it until a cloud machine takes it."
    case "resuming":
      return handOff ? "A cloud machine took it. Its turn goes on there from where it paused, at the same folder." : "A cloud machine took it. Its sessions pick up where they left off, at the same folder."
    case "unsettled":
      return step.reason
    default:
      return ""
  }
}

/** The way back's steps, in the order they're taken. */
const RETURN_STEPS = [
  { kind: "packing", words: "Packing in the cloud" },
  { kind: "bringing", words: "Bringing it here" },
] as const

function returnDetail(step: ThreadReturnStep): string {
  switch (step.kind) {
    case "packing":
      return "Its cloud machine takes no new work and sends back its worktree and sessions. Until they're sent, it's still the cloud's."
    case "bringing":
      return "The cloud let go of it. Its worktree and sessions are arriving here; nothing runs it until they have."
    case "unsettled":
      return step.reason
    default:
      return ""
  }
}

/**
 * Above the composer while the Thread on screen moves to the cloud or comes back: where it is, step by step, and what
 * that means for the Thread. One whose answer this Mac can't hear yet says so, in caution: the Thread runs nowhere
 * until it hears, and the host asks again.
 */
export function ThreadMoveNotice() {
  const key = useAcp((state) => activeAcp(state)?.key)
  const moving = useCloudMoves((state) => (key ? state.moving[key] : undefined))
  const returning = useCloudMoves((state) => (key ? state.returning[key] : undefined))
  const outdated = useCloudMoves((state) => (key ? state.outdated[key] : undefined))
  if (moving) {
    const unsettled = moving.step.kind === "unsettled"
    const handOff = moving.handOff === true
    const steps = handOff ? HANDOFF_STEPS : STEPS
    return (
      <Notice tone={unsettled ? "caution" : "progress"} title={unsettled ? "Waiting for the cloud's answer" : handOff ? "Handing off to the cloud" : "Moving to the cloud"} description={detail(moving.step, handOff)} data-thread-move={moving.step.kind} data-thread-handoff={handOff || undefined} className="mb-1.5">
        {!unsettled && <Steps steps={steps} at={steps.findIndex((each) => each.kind === moving.step.kind)} />}
      </Notice>
    )
  }
  if (!returning) return key && outdated ? <OutdatedReturn conversationId={key} entry={outdated} /> : null
  const unsettled = returning.step.kind === "unsettled"
  return (
    <Notice tone={unsettled ? "caution" : "progress"} title={unsettled ? "Waiting for the cloud's answer" : "Coming back to this Mac"} description={returnDetail(returning.step)} data-thread-return={returning.step.kind} className="mb-1.5">
      {!unsettled && <Steps steps={RETURN_STEPS} at={RETURN_STEPS.findIndex((each) => each.kind === returning.step.kind)} />}
    </Notice>
  )
}

function Steps({ steps, at }: { steps: ReadonlyArray<{ kind: string; words: string }>; at: number }) {
  return (
    <ol className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-label" aria-label="Steps">
      {steps.map((each, index) => (
        <li
          key={each.kind}
          aria-current={index === at ? "step" : undefined}
          className={cn("flex items-center gap-1 whitespace-nowrap", index < at ? "text-muted-foreground" : index === at ? "text-foreground" : "text-faint")}
        >
          {index < at ? <CheckIcon className="size-3" aria-hidden /> : <span aria-hidden className={cn("size-1.5 rounded-full", index === at ? "bg-foreground" : "bg-faint")} />}
          {each.words}
        </li>
      ))}
    </ol>
  )
}

/**
 * A way back that stayed because a harness here is older than the one that wrote the Thread's sessions in the cloud:
 * which versions, and the one choice that settles it, updating the harness and bringing the Thread back. It stays
 * until that's done or the person puts it away; the Thread goes on in the cloud meanwhile.
 */
function OutdatedReturn({ conversationId, entry }: { conversationId: string; entry: { outdated: OutdatedRestore; updating?: boolean; failed?: string } }) {
  useHarnessIdentity()
  const label = harnessLabel(entry.outdated.harness)
  const words = returnNotice(label, entry.outdated)
  const offer = entry.outdated.offer
  const actions =
    offer.kind === "update" ? (
      <NoticeAction disabled={entry.updating} onClick={() => void updateAndBringBack(conversationId)}>
        {entry.updating ? `Updating ${label}…` : entry.failed ? "Try again" : `Update ${label} and bring it back`}
      </NoticeAction>
    ) : offer.kind === "owner" && offer.owner === "Mako" ? (
      <NoticeAction onClick={() => application.openUpdates()}>Open Updates</NoticeAction>
    ) : offer.kind === "manual" && offer.command ? (
      <NoticeAction onClick={() => void navigator.clipboard.writeText(offer.command ?? "")}>Copy command</NoticeAction>
    ) : undefined
  return (
    <Notice
      tone={entry.failed ? "danger" : "caution"}
      title="It stayed in the cloud"
      description={entry.failed ? `${label} wasn't updated: ${entry.failed}` : `${words.line} ${words.detail}`}
      actions={actions}
      onDismiss={entry.updating ? undefined : () => dismissOutdatedReturn(conversationId)}
      data-thread-return="outdated"
      className="mb-1.5"
    />
  )
}

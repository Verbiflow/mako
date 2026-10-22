import { CheckIcon } from "lucide-react"
import type { ThreadMoveStep, ThreadReturnStep } from "@mako/host/contracts/cloud-threads"
import { Notice } from "@/components/ui/notice"
import { cn } from "@/lib/utils"
import { activeAcp, useAcp } from "@/state/acp"
import { useCloudMoves } from "@/state/cloud-moves"

/** A move's steps in the order they're taken, each in the words its step says. */
const STEPS = [
  { kind: "packing", words: "Sending its work ahead" },
  { kind: "handing-over", words: "Handing over" },
  { kind: "resuming", words: "Resuming in the cloud" },
] as const

/** What each step means for the person, under the title. */
function detail(step: ThreadMoveStep): string {
  switch (step.kind) {
    case "packing":
      return "Its worktree and sessions go ahead while it still runs here."
    case "handing-over":
      return "This Mac let go of it; nothing runs it until a cloud machine takes it."
    case "resuming":
      return "A cloud machine took it. Its sessions pick up where they left off, at the same folder."
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
  if (moving) {
    const unsettled = moving.step.kind === "unsettled"
    return (
      <Notice tone={unsettled ? "caution" : "progress"} title={unsettled ? "Waiting for the cloud's answer" : "Moving to the cloud"} description={detail(moving.step)} data-thread-move={moving.step.kind} className="mb-1.5">
        {!unsettled && <Steps steps={STEPS} at={STEPS.findIndex((each) => each.kind === moving.step.kind)} />}
      </Notice>
    )
  }
  if (!returning) return null
  const unsettled = returning.step.kind === "unsettled"
  return (
    <Notice tone={unsettled ? "caution" : "progress"} title={unsettled ? "Waiting for the cloud's answer" : "Coming back to this Mac"} description={returnDetail(returning.step)} data-thread-return={returning.step.kind} className="mb-1.5">
      {!unsettled && <Steps steps={RETURN_STEPS} at={RETURN_STEPS.findIndex((each) => each.kind === returning.step.kind)} />}
    </Notice>
  )
}

function Steps({ steps, at }: { steps: ReadonlyArray<{ kind: string; words: string }>; at: number }) {
  return (
    <ol className="mt-1 flex items-center gap-3 text-label" aria-label="Steps">
      {steps.map((each, index) => (
        <li
          key={each.kind}
          aria-current={index === at ? "step" : undefined}
          className={cn("flex items-center gap-1", index < at ? "text-muted-foreground" : index === at ? "text-foreground" : "text-faint")}
        >
          {index < at ? <CheckIcon className="size-3" aria-hidden /> : <span aria-hidden className={cn("size-1.5 rounded-full", index === at ? "bg-foreground" : "bg-faint")} />}
          {each.words}
        </li>
      ))}
    </ol>
  )
}

import { CheckIcon } from "lucide-react"
import type { ThreadMoveStep } from "@mako/host/contracts/cloud-threads"
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

/**
 * Above the composer while the Thread on screen moves to the cloud: where the move is, in three steps, and what that
 * means for the Thread. A move whose answer this Mac can't hear yet says so, in caution: the Thread runs nowhere
 * until it hears, and the host asks again.
 */
export function ThreadMoveNotice() {
  const key = useAcp((state) => activeAcp(state)?.key)
  const moving = useCloudMoves((state) => (key ? state.moving[key] : undefined))
  if (!moving) return null
  const { step } = moving
  const unsettled = step.kind === "unsettled"
  const at = STEPS.findIndex((each) => each.kind === step.kind)
  return (
    <Notice
      tone={unsettled ? "caution" : "progress"}
      title={unsettled ? "Waiting for the cloud's answer" : "Moving to the cloud"}
      description={detail(step)}
      data-thread-move={step.kind}
      className="mb-1.5"
    >
      {!unsettled && (
        <ol className="mt-1 flex items-center gap-3 text-label" aria-label="Steps">
          {STEPS.map((each, index) => (
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
      )}
    </Notice>
  )
}

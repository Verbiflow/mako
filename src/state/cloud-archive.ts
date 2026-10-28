import { toast } from "sonner"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import type { CloudArchiveOutcome, CloudArchiveStep } from "@mako/host/contracts/thread-lifecycle"

/**
 * A cloud Thread's archive or restore, as a window shows it: one toast per cloud Thread, from the host's first step to
 * the outcome. Archiving it in the cloud takes a few seconds (its machine wakes, packs its checkout and history, and
 * goes); each step says what's happening, and the outcome says what changed, or why nothing did.
 */

const STEP_WORDS = {
  packing: { title: "Archiving thread", description: "Saving its checkout and history in the cloud" },
  ending: { title: "Archiving thread", description: "Ending its cloud machine" },
  bringing: { title: "Restoring thread", description: "Bringing its checkout and history to this Mac" },
} satisfies Record<CloudArchiveStep["kind"], { title: string; description: string }>

const toastId = (thread: string) => `cloud-archive:${thread}`

/** A step the host said: the cloud Thread's toast shows it. */
export function cloudArchiveStepped(step: CloudArchiveStep): void {
  const words = STEP_WORDS[step.kind]
  toast.loading(words.title, { id: toastId(step.thread), description: words.description })
}

/**
 * The outcome, in the same toast. `archiving`: what the person asked, archiving or restoring. `anyway`: archive it once
 * more without its checkout, offered when its machine couldn't start.
 */
export function cloudArchiveSettled(outcome: CloudArchiveOutcome, archiving: boolean, anyway: () => void): void {
  const id = toastId(outcome.thread)
  if (outcome.kind === "archived") {
    toast.success("Thread archived", { id, description: "Its cloud machine is gone and its history is kept. Restore it from Archived." })
    return
  }
  if (outcome.kind === "restored") {
    toast.success("Thread restored", { id, description: "It runs on this Mac again." })
    return
  }
  if (outcome.anyway) {
    toast.error("The thread wasn't archived", {
      id,
      description: `${outcome.reason} Archived anyway, its history is kept but not its checkout's changes since it moved, and it can't be restored.`,
      duration: ACTION_TOAST_MS,
      action: { label: "Archive anyway", onClick: anyway },
    })
    return
  }
  toast.error(archiving ? "The thread wasn't archived" : "The thread wasn't restored", { id, description: outcome.reason })
}

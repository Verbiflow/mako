import { useId, useState } from "react"
import { AutomationDiff } from "@/components/automations/automation-diff"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { useAutomations } from "@/state/automations"

const answer = "pressable inline-flex h-7 min-w-18 items-center justify-center border px-3 text-ui font-medium transition-colors duration-100 focus-visible:outline focus-visible:outline-offset-2 focus-visible:outline-ring"

const CONFIRM = { on: "Approve and turn on", run: "Approve and run", save: "Approve and save" } as const

/**
 * The review `reviewChange` opens: what turning on, Run now or a save would approve, against what the person approved
 * before, part by part; never approved, the whole definition. Mounted once in Automations, where every such press is.
 */
export function AutomationReviewHost() {
  const live = useAutomations((state) => state.review)
  const bodyId = useId()
  // Answering clears the request at once; the closing dialog keeps showing what was asked.
  const [shown, setShown] = useState(live)
  if (live && live !== shown) setShown(live)
  const review = live ?? shown
  const first = review?.before === undefined
  return (
    <Dialog open={Boolean(live)} onOpenChange={(open) => { if (!open) live?.answer(false) }}>
      <DialogContent className="flex max-h-[min(80vh,720px)] w-[calc(100vw-32px)] max-w-[640px] flex-col overflow-hidden" aria-describedby={bodyId} data-automation-review={review?.action} data-corners="square">
        <div className="px-5 pt-4.5">
          <DialogTitle className="text-title leading-6">{first ? `Approve ${review?.name ?? "it"} before it runs` : `${review?.name ?? "It"} changed since you approved it`}</DialogTitle>
          <p id={bodyId} className="mt-0.5 text-ui leading-relaxed text-muted-foreground">
            {first
              ? "Nothing runs until you approve what it says. This is all of it."
              : "Its file says something else now than what you approved (a pull, an agent's edit, or an edit outside Mako). Approving runs what it says now:"}
          </p>
        </div>
        <div className="mx-5 mt-3.5 min-h-0 flex-1 overflow-y-auto border border-hairline px-3.5 py-3">
          {review ? <AutomationDiff proposal={{ change: "update", ...(review.before !== undefined && { before: review.before }), after: review.after }} /> : null}
        </div>
        <div className="mt-4.5 flex justify-end gap-2 border-t border-hairline px-5 py-3">
          <button type="button" data-review-cancel="" onClick={() => live?.answer(false)} className={cn(answer, "border-hairline text-foreground/85 hover:bg-fill-hover hover:text-foreground")}>
            Cancel
          </button>
          <button type="button" data-review-approve="" onClick={() => live?.answer(true)} className={cn(answer, "border-transparent bg-primary text-primary-foreground hover:opacity-90")}>
            {review ? CONFIRM[review.action] : "Approve"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

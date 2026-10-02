import type { ProposedPlan } from "@mako/sessions/content"
import { FileTextIcon, Maximize2Icon, XIcon } from "lucide-react"
import { openPlanTab } from "@/components/transcript/plan-state"
import { Action } from "@/components/ui/kit"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Prose } from "@/components/transcript/markdown"
import { proposedPlanTitle } from "@/lib/proposed-plan"

export function PlanContextChips({
  plans,
  onRemove,
}: {
  plans: ProposedPlan[]
  onRemove?: (plan: ProposedPlan) => void
}) {
  if (!plans.length) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-3 py-2">
      {plans.map((plan, index) => (
        <div
          key={`${plan.id}:${index}`}
          className="flex max-w-full min-w-0 items-center rounded-md border border-hairline text-label text-faint"
        >
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="pressable flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 hover:bg-fill-hover hover:text-foreground"
              >
                <FileTextIcon className="size-3 shrink-0" />
                <span className="truncate">
                  Plan: {proposedPlanTitle(plan.text)}
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="start"
              className="max-h-[60vh] w-[min(100vw_-_32px,520px)] overflow-y-auto p-0"
            >
              <div className="sticky top-0 z-10 flex items-center justify-end border-b border-hairline bg-popover px-2 py-1">
                <Action size="xs" onClick={() => openPlanTab({}, plan)}>
                  <Maximize2Icon />
                  Open in a tab
                </Action>
              </div>
              <Prose text={plan.text} className="p-4" />
            </PopoverContent>
          </Popover>
          {onRemove ? (
            <button
              type="button"
              aria-label={`Remove plan: ${proposedPlanTitle(plan.text)}`}
              className="pressable shrink-0 rounded-md p-1 hover:bg-fill-hover hover:text-foreground"
              onClick={() => onRemove(plan)}
            >
              <XIcon className="size-3" />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  )
}

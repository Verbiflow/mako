import { useEffect, useImperativeHandle, type Ref } from "react"
import { XIcon } from "lucide-react"
import { toast } from "sonner"
import { Keys } from "@/components/ui/kit"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { usePlanContext } from "@/state/plan-mode"
import { flipPlan, PLAN_KEYS, planDetail } from "./plan-actions"
import type { ComposerSettingsView } from "./use-composer-settings"

/** What the composer asks of its plan control: Shift+Tab, and whether the next turn plans. */
export interface PlanHandle {
  /** Flip plan mode; false when this harness has none, so the key keeps its usual meaning. */
  toggle(): boolean
}

/**
 * Plan mode for the session the composer answers. The chip appears only
 * while plan mode is on; Shift+Tab, the palette and the model menu turn it
 * on. The harness's own mechanism is resolved by `planControl`.
 */
export function PlanToggle({
  view,
  handle,
  onPlanning,
}: {
  view: ComposerSettingsView
  handle?: Ref<PlanHandle>
  onPlanning?: (planning: boolean) => void
}) {
  const context = usePlanContext(view)
  const { control } = context
  const active = control.kind !== "none" && control.active
  useImperativeHandle(handle, () => ({
    toggle: () => {
      if (control.kind === "none") return false
      if (control.locked) toast(control.locked)
      else flipPlan(context)
      return true
    },
  }), [context, control])
  useEffect(() => onPlanning?.(active), [active, onPlanning])
  if (control.kind === "none" || !active) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={control.locked ? "Plan mode is on" : "Leave plan mode"}
          aria-disabled={control.locked ? true : undefined}
          data-plan-toggle
          onClick={() => {
            if (!control.locked) flipPlan(context)
          }}
          className={cn(
            "pressable group/plan flex h-6 shrink-0 items-center gap-1 rounded-full bg-fill-selected pr-1.5 pl-2.5 text-ui text-foreground",
            "[transition:background-color_120ms_ease] hover:bg-fill-hover",
            control.locked && "cursor-default pr-2.5 hover:bg-fill-selected"
          )}
        >
          Plan
          {control.locked ? null : (
            <XIcon className="size-3 text-faint [transition:color_120ms_ease] group-hover/plan:text-foreground" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 flex-col items-start gap-1 py-2">
        <span className="flex w-full items-center justify-between gap-3 font-medium">
          Plan mode is on
          <Keys keys={PLAN_KEYS} inverted />
        </span>
        <span className="text-background/70">{planDetail(context)}</span>
      </TooltipContent>
    </Tooltip>
  )
}

import { useEffect, useImperativeHandle, type Ref } from "react"
import { ClipboardListIcon } from "lucide-react"
import { toast } from "sonner"
import { Keys } from "@/components/ui/kit"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { harnessLabel } from "@/lib/harness-label"
import { cn } from "@/lib/utils"
import { setPlanMode, usePlanContext, type PlanContext } from "@/state/plan-mode"
import type { ComposerSettingsView } from "./use-composer-settings"

const PLAN_KEYS = ["⇧", "Tab"]

/** What the composer asks of its plan control: Shift+Tab, and whether the next turn plans. */
export interface PlanHandle {
  /** Flip plan mode; false when this harness has none, so the key keeps its usual meaning. */
  toggle(): boolean
}

function planDetail(context: PlanContext): string {
  const { control, phase, target } = context
  if (control.kind === "none") return ""
  if (control.locked) return control.locked
  const scope = phase === "new" ? " For the next session only." : ""
  if (control.kind === "setting")
    return `${harnessLabel(target.harness)} plans before changing anything, then you build from its plan. Access stays as you set it.${scope}`
  return `${harnessLabel(target.harness)} plans in its ${control.mode.name} mode, then you build from its plan. Leaving it returns to the access you had.${scope}`
}

function flip(context: PlanContext): void {
  if (context.control.kind === "none") return
  void setPlanMode(context, !context.control.active).catch((error) =>
    toast.error("Plan mode did not change", { description: error instanceof Error ? error.message : String(error) })
  )
}

/**
 * Plan mode for the session the composer answers, beside the model and
 * access it works with. It is the same control for every harness that can
 * plan; the harness's own mechanism is resolved by `planControl`.
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
      else flip(context)
      return true
    },
  }), [context, control])
  useEffect(() => onPlanning?.(active), [active, onPlanning])
  if (control.kind === "none") return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-pressed={active}
          aria-label="Plan mode"
          aria-disabled={control.locked ? true : undefined}
          data-plan-toggle
          onClick={() => {
            if (!control.locked) flip(context)
          }}
          className={cn(
            "pressable flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-ui",
            "[transition:background-color_120ms_ease,color_120ms_ease]",
            active
              ? "bg-fill-selected text-foreground hover:bg-fill-hover"
              : "text-faint hover:bg-fill-hover hover:text-foreground",
            control.locked && "cursor-default opacity-50 hover:bg-transparent"
          )}
        >
          <ClipboardListIcon className="size-3.5 shrink-0" />
          {/* Gives way with the access label when the routing row is short of room. */}
          <span data-collapse="1">Plan</span>
          <span className="sr-only" aria-live="polite">
            {active ? "Plan mode on" : "Plan mode off"}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 flex-col items-start gap-1 py-2">
        <span className="flex w-full items-center justify-between gap-3 font-medium">
          {active ? "Plan mode is on" : "Plan mode"}
          <Keys keys={PLAN_KEYS} inverted />
        </span>
        <span className="text-background/70">{planDetail(context)}</span>
      </TooltipContent>
    </Tooltip>
  )
}

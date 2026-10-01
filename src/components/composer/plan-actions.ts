import { toast } from "sonner"
import { harnessLabel } from "@/lib/harness-label"
import { setPlanMode, type PlanContext } from "@/state/plan-mode"

export const PLAN_KEYS = ["⇧", "Tab"]

export function planDetail(context: PlanContext): string {
  const { control, phase, target } = context
  if (control.kind === "none") return ""
  if (control.locked) return control.locked
  const scope = phase === "new" ? " For the next session only." : ""
  if (control.kind === "setting")
    return `${harnessLabel(target.harness)} plans before changing anything, then you build from its plan. Access stays as you set it.${scope}`
  return `${harnessLabel(target.harness)} plans in its ${control.mode.name} mode, then you build from its plan. Leaving it returns to the access you had.${scope}`
}

export function flipPlan(context: PlanContext): void {
  if (context.control.kind === "none") return
  void setPlanMode(context, !context.control.active).catch((error) =>
    toast.error("Plan mode did not change", { description: error instanceof Error ? error.message : String(error) })
  )
}

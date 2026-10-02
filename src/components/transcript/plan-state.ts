import { useCallback, useRef, useState } from "react"
import type { ProposedPlan } from "@mako/sessions/content"
import { toast } from "sonner"
import { proposedPlanTitle } from "@/lib/proposed-plan"
import { useAcp } from "@/state/acp"
import { PlanBuiltElsewhereError, usePlanBuild } from "@/state/plan-builds"
import {
  buildPlan,
  buildPlanInNewSession,
  useLatestPlan,
  usePlanAwaitingApproval,
  type PlanSource,
} from "@/state/plan-mode"
import { viewer } from "@/state/viewer"

/** Where a plan stands, as its card, its tab and the composer show it. */
export interface PlanState {
  title: string
  complete: boolean
  superseded: boolean
  awaiting: boolean
  built: boolean
  builtHere: boolean
  /** The session the plan was built in, when that is another one still open here. */
  openBuild?: string
  /** It can be built or revised now. */
  ready: boolean
  label: string
}

export function usePlanState(source: PlanSource, plan: ProposedPlan, streaming = false): PlanState {
  const latest = useLatestPlan(source)
  const superseded = latest !== undefined && latest !== plan.id
  const awaiting = usePlanAwaitingApproval(source, plan)
  const build = usePlanBuild(plan)
  const builtHere = Boolean(build && (
    (build.conversation && build.conversation === source.liveId) ||
    (build.thread && build.thread === source.threadPath)))
  const elsewhere = build && !builtHere ? build.conversation : undefined
  const openBuild = useAcp((state) => (elsewhere && state.conversations[elsewhere] ? elsewhere : undefined))
  const complete = plan.status === "proposed"
  // A turn waiting on its plan approval is still running, but its plan is complete.
  const ready = complete && (!streaming || awaiting) && !plan.truncated && Boolean(source.liveId || source.threadPath)
  const label = !complete
    ? streaming ? "Writing plan…" : "Incomplete plan"
    : build
      ? builtHere ? "Built in this session" : "Built in another session"
      : superseded
        ? "Earlier revision"
        : awaiting
          ? "Waiting for your approval"
          : "Proposed plan"
  return {
    title: proposedPlanTitle(plan.text),
    complete,
    superseded,
    awaiting,
    built: Boolean(build),
    builtHere,
    openBuild,
    ready,
    label,
  }
}

/** Build a plan here or in a new session, saying so when it doesn't happen. */
export async function startPlanBuild(source: PlanSource, plan: ProposedPlan, where: "here" | "new"): Promise<void> {
  try {
    await (where === "here" ? buildPlan(source, plan) : buildPlanInNewSession(source, plan))
  } catch (failure) {
    if (failure instanceof PlanBuiltElsewhereError) toast("Already built", { description: failure.message })
    else toast.error("The plan was not built", { description: failure instanceof Error ? failure.message : String(failure) })
  }
}

/** One build at a time from a given surface, with which one is under way. */
export function usePlanBuilding(source: PlanSource, plan: ProposedPlan) {
  const [building, setBuilding] = useState<"here" | "new" | null>(null)
  const busy = useRef(false)
  const { liveId, threadPath } = source
  const start = useCallback((where: "here" | "new") => {
    if (busy.current) return
    busy.current = true
    setBuilding(where)
    void startPlanBuild({ liveId, threadPath }, plan, where).finally(() => {
      busy.current = false
      setBuilding(null)
    })
  }, [liveId, threadPath, plan])
  return { building, start }
}

export function openPlanTab(source: PlanSource, plan: ProposedPlan): void {
  viewer.openPlan(plan, source, proposedPlanTitle(plan.text))
}

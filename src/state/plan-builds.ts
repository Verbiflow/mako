import { z } from "zod"
import type { ProposedPlan } from "@mako/sessions/content"
import { createHook, createStore } from "@/state/store"

/**
 * Plans the user built, by plan id, so a plan card says it was built and
 * where. A plan counts as built when its implementation request was sent or
 * its native plan approval was answered with the approval's own choice; a
 * new session opened with the plan in its draft is not built until that
 * draft is sent. Kept on this machine, newest `MAX_BUILDS`.
 */
const STORAGE_KEY = "mako.plan-builds.v1"
const MAX_BUILDS = 200

const PlanBuildSchema = z.object({
  at: z.number(),
  /** The live conversation the implementation went to. */
  conversation: z.string().optional(),
  /** The thread it went to, when it was not a live conversation. */
  thread: z.string().optional(),
})
export type PlanBuild = z.infer<typeof PlanBuildSchema>
const BuildsSchema = z.record(z.string(), PlanBuildSchema)

interface PlanBuildsState {
  builds: z.infer<typeof BuildsSchema>
}

function load(): PlanBuildsState["builds"] {
  try {
    return BuildsSchema.catch({}).parse(JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? "{}"))
  } catch {
    return {}
  }
}

export const planBuildsStore = createStore<PlanBuildsState>({ builds: load() })
export const usePlanBuilds = createHook(planBuildsStore)

/** Where a plan's implementation went. */
export interface PlanBuildTarget {
  conversation?: string
  thread?: string
}

export function recordPlanBuild(plan: Pick<ProposedPlan, "id">, target: PlanBuildTarget, at = Date.now()): void {
  const build: PlanBuild = { at }
  if (target.conversation) build.conversation = target.conversation
  if (target.thread) build.thread = target.thread
  const kept = Object.entries(planBuildsStore.get().builds)
    .filter(([id]) => id !== plan.id)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_BUILDS - 1)
  const builds = Object.fromEntries([[plan.id, build], ...kept])
  planBuildsStore.set({ builds })
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(builds))
  } catch {
    // The card still shows it for this run; only the record across restarts is lost.
  }
}

/** The build recorded for a plan, if any. */
export function usePlanBuild(plan: Pick<ProposedPlan, "id">): PlanBuild | undefined {
  return usePlanBuilds((state) => state.builds[plan.id])
}

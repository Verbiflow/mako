import type { ProposedPlan } from "@mako/sessions/content"
import { PlanBuildsSchema, type PlanBuild, type PlanBuilds } from "../../electron/contracts/plan-builds.ts"
import { getMako, hasBridge } from "@/lib/bridge"
import { createHook, createStore } from "@/state/store"

export type { PlanBuild }

/** Where builds were kept before the host kept them: one window origin on one computer. */
const LEGACY_STORAGE_KEY = "mako.plan-builds.v1"

interface PlanBuildsState {
  builds: PlanBuilds
}

/** The host's record of built plans (`electron/contracts/plan-builds.ts`). */
export const planBuildsStore = createStore<PlanBuildsState>({ builds: {} })
export const usePlanBuilds = createHook(planBuildsStore)

export function applyPlanBuilds(builds: PlanBuilds): void {
  planBuildsStore.set({ builds })
}

/** Reads the host's record, after handing it what this window kept on its own. */
export async function loadPlanBuilds(): Promise<void> {
  if (!hasBridge()) return
  await handOverLegacyBuilds()
  applyPlanBuilds(await getMako().planBuilds())
}

async function handOverLegacyBuilds(): Promise<void> {
  const raw = globalThis.localStorage?.getItem(LEGACY_STORAGE_KEY)
  if (raw == null) return
  let legacy: PlanBuilds = {}
  try {
    legacy = PlanBuildsSchema.catch({}).parse(JSON.parse(raw))
  } catch {
    // Unreadable: nothing to hand over.
  }
  for (const [planId, build] of Object.entries(legacy)) await getMako().recordPlanBuild(planId, build)
  globalThis.localStorage?.removeItem(LEGACY_STORAGE_KEY)
}

/** Where a plan's implementation went. */
export interface PlanBuildTarget {
  conversation?: string
  thread?: string
}

/** Shows the build at once; the host keeps it and tells every window. */
export function recordPlanBuild(plan: Pick<ProposedPlan, "id">, target: PlanBuildTarget, at = Date.now()): void {
  const build: PlanBuild = { at }
  if (target.conversation) build.conversation = target.conversation
  if (target.thread) build.thread = target.thread
  planBuildsStore.set({ builds: { ...planBuildsStore.get().builds, [plan.id]: build } })
  if (hasBridge()) void getMako().recordPlanBuild(plan.id, build).catch(() => {
    // The card still shows it in this window; only the shared record misses it.
  })
}

/** The build recorded for a plan, if any. */
export function usePlanBuild(plan: Pick<ProposedPlan, "id">): PlanBuild | undefined {
  return usePlanBuilds((state) => state.builds[plan.id])
}

import { registerIpc } from "./register.js"
import type { PlanBuilds } from "../plan-builds.js"
import type { PlanBuild, PlanBuildClaim, PlanBuildTarget, PlanBuilds as PlanBuildsState } from "../contracts/plan-builds.js"

export function installPlanBuildsIpc(builds: PlanBuilds) {
  registerIpc("mako:plan-builds", (): PlanBuildsState => builds.state())
  registerIpc("mako:plan-build-record", (_event, planId: string, build: PlanBuild) => builds.record(planId, build))
  registerIpc("mako:plan-build-claim", (_event, claimId: string, planId: string, target: PlanBuildTarget, seen: number | null): PlanBuildClaim =>
    builds.claim(claimId, planId, target, seen))
  registerIpc("mako:plan-build-release", (_event, claimId: string) => builds.release(claimId))
}

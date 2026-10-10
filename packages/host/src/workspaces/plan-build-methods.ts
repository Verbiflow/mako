import type { MethodTable } from "../base/methods.js"
import type { PlanBuilds } from "./plan-builds.js"
import type { PlanBuild, PlanBuildClaim, PlanBuildTarget, PlanBuilds as PlanBuildsState } from "../contracts/plan-builds.js"

export function declarePlanBuildMethods(methods: MethodTable, builds: PlanBuilds) {
  methods.handle("mako:plan-builds", (): PlanBuildsState => builds.state())
  methods.handle("mako:plan-build-record", (planId: string, build: PlanBuild) => builds.record(planId, build))
  methods.handle("mako:plan-build-claim", (claimId: string, planId: string, target: PlanBuildTarget, seen: number | null): PlanBuildClaim =>
    builds.claim(claimId, planId, target, seen))
  methods.handle("mako:plan-build-release", (claimId: string) => builds.release(claimId))
}

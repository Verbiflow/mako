import { registerIpc } from "./register.js"
import type { PlanBuilds } from "../plan-builds.js"
import type { PlanBuild, PlanBuilds as PlanBuildsState } from "../contracts/plan-builds.js"

export function installPlanBuildsIpc(builds: PlanBuilds) {
  registerIpc("mako:plan-builds", (): PlanBuildsState => builds.state())
  registerIpc("mako:plan-build-record", (_event, planId: string, build: PlanBuild) => builds.record(planId, build))
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { MAX_PLAN_BUILDS, PlanBuildsSchema, type PlanBuild, type PlanBuildClaim, type PlanBuildTarget, type PlanBuilds as PlanBuildsState } from "./contracts/plan-builds.js"

interface Deps {
  file: string
  announce(builds: PlanBuildsState): void
}

function stored(file: string): PlanBuildsState {
  try {
    return PlanBuildsSchema.parse(JSON.parse(readFileSync(file, "utf8")))
  } catch {
    return {}
  }
}

/** The host's record of built plans, newest `MAX_PLAN_BUILDS`, announced to every window on change. */
export class PlanBuilds {
  private builds: PlanBuildsState
  private readonly deps: Deps
  /** Claims this host made, oldest first, so a replayed claim or a release finds its own. */
  private readonly claims = new Map<string, { planId: string; build: PlanBuild; previous: PlanBuild | undefined }>()

  constructor(deps: Deps) {
    this.deps = deps
    this.builds = stored(deps.file)
  }

  state(): PlanBuildsState {
    return { ...this.builds }
  }

  /** Records where a plan was built; a plan built again keeps its latest build. */
  record(planId: string, build: PlanBuild): void {
    const current = this.builds[planId]
    if (current && current.at >= build.at) return
    const kept = Object.entries(this.builds)
      .filter(([id]) => id !== planId)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, MAX_PLAN_BUILDS - 1)
    this.builds = Object.fromEntries([[planId, build], ...kept])
    this.save()
    this.deps.announce(this.state())
  }

  /**
   * Records a build only if the plan's build is still the one the caller saw
   * (`seen`, by its `at`; null for none), so two Build clicks can't both send
   * an implementation. The host's clock stamps the claim; a repeat of the
   * same claim id gets the first answer.
   */
  claim(claimId: string, planId: string, target: PlanBuildTarget, seen: number | null): PlanBuildClaim {
    const repeated = this.claims.get(claimId)
    if (repeated) return { claimed: true, build: repeated.build }
    const current = this.builds[planId]
    if ((current?.at ?? null) !== seen) return { claimed: false, current }
    const build: PlanBuild = { ...target, at: Math.max(Date.now(), (current?.at ?? 0) + 1) }
    this.record(planId, build)
    this.claims.set(claimId, { planId, build, previous: current })
    if (this.claims.size > MAX_PLAN_BUILDS) this.claims.delete(this.claims.keys().next().value!)
    return { claimed: true, build }
  }

  /** Undoes a claim whose implementation was not sent, unless the plan was built again since. */
  release(claimId: string): void {
    const claim = this.claims.get(claimId)
    this.claims.delete(claimId)
    if (!claim || this.builds[claim.planId]?.at !== claim.build.at) return
    const rest = Object.entries(this.builds).filter(([id]) => id !== claim.planId)
    this.builds = Object.fromEntries(claim.previous ? [...rest, [claim.planId, claim.previous]] : rest)
    this.save()
    this.deps.announce(this.state())
  }

  private save(): void {
    const temporary = `${this.deps.file}.${process.pid}.tmp`
    mkdirSync(dirname(this.deps.file), { recursive: true })
    writeFileSync(temporary, JSON.stringify(this.builds))
    renameSync(temporary, this.deps.file)
  }
}

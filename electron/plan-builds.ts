import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { MAX_PLAN_BUILDS, PlanBuildsSchema, type PlanBuild, type PlanBuilds as PlanBuildsState } from "./contracts/plan-builds.js"

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

  private save(): void {
    const temporary = `${this.deps.file}.${process.pid}.tmp`
    mkdirSync(dirname(this.deps.file), { recursive: true })
    writeFileSync(temporary, JSON.stringify(this.builds))
    renameSync(temporary, this.deps.file)
  }
}

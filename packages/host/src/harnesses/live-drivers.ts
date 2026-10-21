import { unwatchedWork, type HostWork } from "../base/event-loop.js"
import type { AdmittedLiveDriver, ProviderLiveDriver } from "./live-driver.js"
import { validateLiveDriver } from "./live-driver.js"
import { withNativeExclusion } from "./native-exclusion.js"
import { withExecutionAdmission, type AccountAdmission } from "./execution-admission.js"
import { ProviderRegistry } from "./registry.js"
import type { RuntimeFloor } from "./runtime-floor.js"
import { runPrefetch, type PrefetchOutcome } from "./start-prefetch.js"

/**
 * Every harness's live driver, each validated as it registers and handed out behind native exclusion and admission;
 * and each harness's start run ahead (`startPrefetch`), which a start of that harness stops where it still runs.
 */
export class LiveDrivers {
  private readonly drivers = new ProviderRegistry<AdmittedLiveDriver>()
  /** Each harness's run ahead still running, by what stops it. */
  private readonly ahead = new Map<string, AbortController>()
  private readonly admission: AccountAdmission
  private readonly work: HostWork
  private readonly floor: RuntimeFloor | undefined

  constructor(admission: AccountAdmission, work: HostWork = unwatchedWork, floor?: RuntimeFloor) {
    this.admission = admission
    this.work = work
    this.floor = floor
  }

  register(driver: ProviderLiveDriver): () => void {
    validateLiveDriver(driver)
    const admitted = withExecutionAdmission(withNativeExclusion(driver), this.admission, this.work, this.floor)
    return this.drivers.register({
      ...admitted,
      start: (cwd, options) => {
        this.ahead.get(driver.provider)?.abort(new Error("A start of the harness began"))
        return admitted.start(cwd, options)
      },
    })
  }

  /**
   * What `provider`'s start runs first, run ahead in `cwd` (a cloud machine's, as it boots): its files read and its
   * first steps run, which its next start stops where they still run. Undefined for a harness without it.
   */
  async runAhead(provider: string, env: NodeJS.ProcessEnv, cwd: string): Promise<PrefetchOutcome | undefined> {
    const prefetch = this.get(provider)?.startPrefetch
    if (!prefetch) return undefined
    this.ahead.get(provider)?.abort(new Error("Run ahead again"))
    const stop = new AbortController()
    this.ahead.set(provider, stop)
    try {
      return await runPrefetch(prefetch, env, cwd, `prefetch:${provider}`, stop.signal)
    } finally {
      if (this.ahead.get(provider) === stop) this.ahead.delete(provider)
    }
  }

  /** Then, once its sign-in is installed: what its start asks its service first (`startPrefetch.signedIn`). */
  async signedInAhead(provider: string, env: NodeJS.ProcessEnv): Promise<{ ms: number } | undefined> {
    const signedIn = this.get(provider)?.startPrefetch?.signedIn
    if (!signedIn) return undefined
    const began = performance.now()
    await signedIn(env)
    return { ms: Math.round(performance.now() - began) }
  }

  get(provider: string): AdmittedLiveDriver | undefined {
    return this.drivers.get(provider)
  }

  list(): AdmittedLiveDriver[] {
    return this.drivers.list()
  }
}

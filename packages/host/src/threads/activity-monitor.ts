import type { JobDemand } from "../base/host-jobs.js"
import type { ProviderActivitySession, ProviderProcessProbe } from "./harnesses.js"
import { ProviderActivityEngine } from "./activity-engine.js"

export interface ActivityMonitorDeps {
  probes(): readonly ProviderProcessProbe[]
  /** What a probe says changed; `sessions` holds it already. */
  changed(): void
  /** Hears a harness process Mako starts or sees end, so every probe looks now rather than at its idle interval. */
  nudges?(listener: () => void): () => void
}

/**
 * The harnesses' process probes, run only while a demand it watches is on (a window, the CLI, another host, a run
 * followed here) and paused while none is: an idle host reads no process table and lists no open files on a timer.
 * What the probes last said stands through a pause (`sessions`), and the next engine is told against it, so a session
 * that ended while nothing watched reads ended once something does.
 */
export class ProviderActivityMonitor {
  /** What each harness's probe last said, by provider. */
  readonly sessions = new Map<string, ProviderActivitySession[]>()
  readonly #deps: ActivityMonitorDeps
  readonly #watchers = new Set<JobDemand>()
  #engine: ProviderActivityEngine | null = null
  #stopNudges: (() => void) | undefined
  #always = false
  #stopped = true

  constructor(deps: ActivityMonitorDeps) {
    this.#deps = deps
  }

  /** Whether the probes run now. */
  get running(): boolean {
    return this.#engine !== null
  }

  /** Starts following its demands, or, with `always`, runs the probes whatever watches. */
  start({ always = false }: { always?: boolean } = {}): void {
    this.#stopped = false
    this.#always = always
    this.#refresh()
  }

  /** The probes also run while `demand` is on. Returns the release. */
  watch(demand: JobDemand): () => void {
    this.#watchers.add(demand)
    const stop = demand.onChange(() => this.#refresh())
    this.#refresh()
    return () => {
      stop()
      this.#watchers.delete(demand)
      this.#refresh()
    }
  }

  /** Stops the probes and forgets what they said; the demands it watches stay, for a start after. */
  stop(): void {
    this.#stopped = true
    this.#pause()
    this.sessions.clear()
  }

  #refresh(): void {
    if (this.#stopped) return
    if (this.#always || [...this.#watchers].some((watcher) => watcher.on)) this.#run()
    else this.#pause()
  }

  #run(): void {
    if (this.#engine) return
    const engine = new ProviderActivityEngine(this.#deps.probes(), this.sessions)
    engine.onChange((snapshot) => {
      this.sessions.set(snapshot.provider, snapshot.sessions)
      this.#deps.changed()
    })
    this.#engine = engine
    engine.start()
    this.#stopNudges = this.#deps.nudges?.(() => this.#engine?.nudge())
  }

  #pause(): void {
    this.#stopNudges?.()
    this.#stopNudges = undefined
    this.#engine?.stop()
    this.#engine = null
  }
}

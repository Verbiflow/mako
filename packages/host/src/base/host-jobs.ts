import type { HostJob } from "../contracts/runtime.js"
import { unwatchedWork, type HostWork } from "./event-loop.js"
import type { Foreground } from "./foreground.js"
import { hostWarn } from "./host-log.js"

export interface JobOptions {
  /** Wait before the first run, when it differs from `everyMs`. */
  firstAfterMs?: number
  /** Runs only while one of these is on; the job holds no timer, and so never wakes the host, while none is. */
  needs?: readonly JobDemand[]
  /**
   * Runs while the foreground is held too: a job too small to slow a start, whose point is when it runs (the wake
   * watch's tick, which would otherwise read a long start as the machine having slept).
   */
  runsWhileHeld?: boolean
}

/** A reason some recurring work is needed, such as an open window; whoever knows sets it on and off. */
export interface JobDemand {
  readonly name: string
  readonly on: boolean
  set(on: boolean): void
}

interface Job {
  state: HostJob
  run: () => void | Promise<void>
  firstAfterMs: number
  needs: readonly JobDemand[]
  runsWhileHeld: boolean
  timer: NodeJS.Timeout | undefined
  running: boolean
}

/**
 * The host's recurring work, by name. Each job runs on an unreferenced timer,
 * so none of them keeps the process alive; its interval varies by a tenth
 * either way, so jobs started together drift apart instead of waking the
 * machine at once; a run that's still going when the next is due is skipped;
 * and a failure is logged under the job's name. A job that needs a demand is
 * paused while none of its demands is on, and starts over, first run
 * included, when one comes back on. Each run is work by the job's name, so a
 * run that holds the event loop is named. A run that comes due while the
 * foreground is held (a harness starting) waits until it's free, unless the
 * job runs while it's held (`runsWhileHeld`).
 */
export class HostJobs {
  private readonly jobs = new Map<string, Job>()
  private readonly work: HostWork
  private readonly foreground: Foreground | undefined
  private stopped = false

  constructor(work: HostWork = unwatchedWork, foreground?: Foreground) {
    this.work = work
    this.foreground = foreground
  }

  /** Schedules `run` every `everyMs`; the returned function cancels it, after which its name is free again. */
  every(name: string, everyMs: number, run: () => void | Promise<void>, options: JobOptions = {}): () => void {
    if (this.stopped) throw new Error(`The host is stopping; ${name} was not scheduled`)
    if (this.jobs.has(name)) throw new Error(`${name} is scheduled twice`)
    const needs = options.needs ?? []
    const job: Job = {
      state: { name, everyMs, runs: 0, failures: 0, paused: false, ...(needs.length > 0 && { needs: needs.map((demand) => demand.name) }) },
      run,
      firstAfterMs: options.firstAfterMs ?? everyMs,
      needs,
      runsWhileHeld: options.runsWhileHeld ?? false,
      timer: undefined,
      running: false,
    }
    this.jobs.set(name, job)
    this.resume(job)
    return () => {
      if (this.jobs.get(name) !== job) return
      clearTimeout(job.timer)
      this.jobs.delete(name)
    }
  }

  /** A demand jobs can need, off until set on. */
  demand(name: string): JobDemand {
    let on = false
    const demand: JobDemand = {
      name,
      get on() {
        return on
      },
      set: (next) => {
        if (next === on) return
        on = next
        for (const job of this.jobs.values()) if (job.needs.includes(demand)) this.resume(job)
      },
    }
    return demand
  }

  list(): HostJob[] {
    return [...this.jobs.values()].map((job) => ({ ...job.state, ...(job.state.needs && { needs: [...job.state.needs] }) }))
  }

  stop(): void {
    this.stopped = true
    for (const job of this.jobs.values()) clearTimeout(job.timer)
  }

  /** Schedules a job that's needed and isn't scheduled yet, or unschedules one that isn't needed. */
  private resume(job: Job): void {
    const needed = !job.needs.length || job.needs.some((demand) => demand.on)
    job.state.paused = !needed
    if (!needed) {
      clearTimeout(job.timer)
      job.timer = undefined
    } else if (!job.timer && !this.stopped) {
      this.schedule(job, job.firstAfterMs)
    }
  }

  private schedule(job: Job, afterMs: number): void {
    job.timer = setTimeout(() => {
      if (this.stopped) return
      this.schedule(job, job.state.everyMs)
      if (job.running) return
      if (job.runsWhileHeld || !this.foreground?.busy) return void this.run(job)
      // Due while a person waits on the foreground: it runs once nothing holds it.
      job.running = true
      void this.foreground.idle().then(() => {
        job.running = false
        if (!this.stopped) void this.run(job)
      })
    }, afterMs * (0.9 + Math.random() * 0.2))
    job.timer.unref()
  }

  private async run(job: Job): Promise<void> {
    job.running = true
    job.state.runs += 1
    const done = this.work.begin(job.state.name)
    try {
      await job.run()
    } catch (error) {
      job.state.failures += 1
      job.state.lastError = error instanceof Error ? error.message : String(error)
      hostWarn("jobs", `${job.state.name} failed`, { error: job.state.lastError })
    } finally {
      done()
      job.running = false
    }
  }
}

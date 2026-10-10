import { hostWarn } from "./host-log.js"

/** How a recurring job has gone, for the host's state view and the log. */
export interface HostJobState {
  name: string
  everyMs: number
  runs: number
  failures: number
  lastError?: string
}

interface Job {
  state: HostJobState
  timer: NodeJS.Timeout | undefined
  running: boolean
}

/**
 * The host's recurring work, by name. Each job runs on an unreferenced timer,
 * so none of them keeps the process alive; its interval varies by a tenth
 * either way, so jobs started together drift apart instead of waking the
 * machine at once; a run that's still going when the next is due is skipped;
 * and a failure is logged under the job's name.
 */
export class HostJobs {
  private readonly jobs = new Map<string, Job>()
  private stopped = false

  every(name: string, everyMs: number, run: () => void | Promise<void>): void {
    if (this.stopped) throw new Error(`The host is stopping; ${name} was not scheduled`)
    if (this.jobs.has(name)) throw new Error(`${name} is scheduled twice`)
    const job: Job = { state: { name, everyMs, runs: 0, failures: 0 }, timer: undefined, running: false }
    this.jobs.set(name, job)
    this.schedule(job, run)
  }

  list(): HostJobState[] {
    return [...this.jobs.values()].map((job) => ({ ...job.state }))
  }

  stop(): void {
    this.stopped = true
    for (const job of this.jobs.values()) clearTimeout(job.timer)
  }

  private schedule(job: Job, run: () => void | Promise<void>): void {
    const delay = job.state.everyMs * (0.9 + Math.random() * 0.2)
    job.timer = setTimeout(() => {
      if (this.stopped) return
      this.schedule(job, run)
      if (!job.running) void this.run(job, run)
    }, delay)
    job.timer.unref()
  }

  private async run(job: Job, run: () => void | Promise<void>): Promise<void> {
    job.running = true
    job.state.runs += 1
    try {
      await run()
    } catch (error) {
      job.state.failures += 1
      job.state.lastError = error instanceof Error ? error.message : String(error)
      hostWarn("jobs", `${job.state.name} failed`, { error: job.state.lastError })
    } finally {
      job.running = false
    }
  }
}

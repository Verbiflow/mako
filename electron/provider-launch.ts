import { randomUUID } from "node:crypto"
import { hostLog } from "./host-log.js"

/** Observed boundaries, not guesses about work inside an opaque native request. */
export type ProviderLaunchPhase =
  | "launch" | "configuration" | "account" | "runtime-discovery"
  | "mcp-preparation" | "observation" | "spawn" | "handshake"
  | "authentication" | "human-sign-in" | "model-discovery"
  | "session-open" | "session-resume" | "session-fork" | "settings"
  | "sdk-initialization"

export type ProviderLaunchRecord = {
  provider: string
  conversation: string
  attempt: string
  step: number
  phase: ProviderLaunchPhase
  elapsedMs: number
} & (
  | { state: "started" | "waiting" }
  | { state: "done" | "failed"; durationMs: number }
)

/** One launch owns its identity and clock, including preparation before spawn.
 * Records contain no arguments, native payloads, errors or credentials. A phase
 * starts before its work is invoked, so a pending operation remains diagnosable.
 * This observes existing policy; it neither extends deadlines nor replays work.
 */
export class ProviderLaunchTrace {
  private readonly attempt = randomUUID()
  private readonly startedAt: number
  private nextStep = 0
  private readonly identity: { provider: string; conversation: string }
  private readonly now: () => number
  private readonly report: (record: ProviderLaunchRecord) => void

  constructor(
    identity: { provider: string; conversation: string },
    dependencies: {
      now?: () => number
      report?: (record: ProviderLaunchRecord) => void
    } = {}
  ) {
    this.identity = identity
    this.now = dependencies.now ?? (() => performance.now())
    this.report = dependencies.report ?? (record => hostLog("provider-startup", "phase", { ...record }))
    this.startedAt = this.now()
  }

  async step<T>(phase: ProviderLaunchPhase, work: () => T | Promise<T>): Promise<T> {
    const finish = this.begin(phase)
    try {
      const value = await work()
      finish("done")
      return value
    } catch (error) {
      finish("failed")
      throw error
    }
  }

  /** Spawning must not yield before the adapter installs child error handlers. */
  sync<T>(phase: ProviderLaunchPhase, work: () => T): T {
    const finish = this.begin(phase)
    try {
      const value = work()
      finish("done")
      return value
    } catch (error) {
      finish("failed")
      throw error
    }
  }

  private begin(phase: ProviderLaunchPhase): (state: "done" | "failed") => void {
    const startedAt = this.now()
    const identity = { ...this.identity, attempt: this.attempt, step: this.nextStep++, phase }
    this.report({ ...identity, elapsedMs: startedAt - this.startedAt,
      state: phase === "human-sign-in" ? "waiting" : "started" })
    return state => {
      const finishedAt = this.now()
      this.report({ ...identity, state, elapsedMs: finishedAt - this.startedAt,
        durationMs: finishedAt - startedAt })
    }
  }
}

export function traceProviderLaunch<T>(
  provider: string,
  conversation: string,
  work: (trace: ProviderLaunchTrace) => Promise<T>
): Promise<T> {
  const trace = new ProviderLaunchTrace({ provider, conversation })
  return trace.step("launch", () => work(trace))
}

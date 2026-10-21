import { randomUUID } from "node:crypto"
import { z } from "zod"
import { unwatchedWork, type HostWork } from "../base/event-loop.js"
import { hostLog } from "../base/host-log.js"

/** Observed boundaries, not guesses about work inside an opaque native request. */
export type ProviderLaunchPhase =
  | "launch" | "configuration" | "account" | "runtime-discovery"
  | "mcp-preparation" | "observation" | "spawn" | "handshake"
  | "authentication" | "human-sign-in" | "model-discovery"
  | "session-open" | "session-resume" | "session-fork" | "settings"
  | "sdk-load" | "sdk-initialization" | "identity"
  /** A process spawned ahead, taken as the session's (Cursor's SDK child). */
  | "adoption"

export type ProviderLaunchRecord = {
  provider: string
  conversation: string
  attempt: string
  step: number
  phase: ProviderLaunchPhase
  elapsedMs: number
} & (
  | { state: "started" | "waiting" }
  | { state: "done"; durationMs: number }
  | { state: "failed"; durationMs: number; error: string }
)

/** One launch owns its identity and clock, including preparation before spawn.
 * Records contain no arguments, native payloads, error messages or credentials;
 * a failed phase names only the error's kind (its code or class). A phase
 * starts before its work is invoked, so a pending operation remains diagnosable.
 * This observes existing policy; it neither extends deadlines nor replays work.
 * Each phase is also named to the host's event loop watch, so a held loop
 * says which launch was in which phase.
 */
export class ProviderLaunchTrace {
  private readonly attempt = randomUUID()
  private readonly startedAt: number
  private nextStep = 0
  private readonly identity: { provider: string; conversation: string }
  private readonly now: () => number
  private readonly report: (record: ProviderLaunchRecord) => void
  private readonly work: HostWork

  constructor(
    identity: { provider: string; conversation: string },
    dependencies: {
      now?: () => number
      report?: (record: ProviderLaunchRecord) => void
      work?: HostWork
    } = {}
  ) {
    this.identity = identity
    this.now = dependencies.now ?? (() => performance.now())
    this.report = dependencies.report ?? (record => hostLog("provider-startup", "phase", { ...record }))
    this.work = dependencies.work ?? unwatchedWork
    this.startedAt = this.now()
  }

  async step<T>(phase: ProviderLaunchPhase, work: () => T | Promise<T>): Promise<T> {
    const finish = this.begin(phase)
    try {
      const value = await work()
      finish()
      return value
    } catch (error) {
      finish({ error })
      throw error
    }
  }

  /** Spawning must not yield before the adapter installs child error handlers. */
  sync<T>(phase: ProviderLaunchPhase, work: () => T): T {
    const finish = this.begin(phase)
    try {
      const value = work()
      finish()
      return value
    } catch (error) {
      finish({ error })
      throw error
    }
  }

  /** Ends the phase, given the error when it failed. */
  private begin(phase: ProviderLaunchPhase): (failure?: { error: unknown }) => void {
    const startedAt = this.now()
    const identity = { ...this.identity, attempt: this.attempt, step: this.nextStep++, phase }
    this.report({ ...identity, elapsedMs: startedAt - this.startedAt,
      state: phase === "human-sign-in" ? "waiting" : "started" })
    // The whole launch spans its phases; naming it too would crowd them out of a hold's list.
    const done = phase === "launch" ? undefined : this.work.begin(`launch ${this.identity.provider} ${this.identity.conversation.slice(0, 8)}: ${phase}`)
    return failure => {
      done?.()
      const finishedAt = this.now()
      const timing = { elapsedMs: finishedAt - this.startedAt, durationMs: finishedAt - startedAt }
      this.report(failure
        ? { ...identity, ...timing, state: "failed", error: ErrorKind.parse(failure.error) }
        : { ...identity, ...timing, state: "done" })
    }
  }
}

/** What failed, without the message: a system code such as `ENOENT`, else the error's class or tag. */
const ErrorKind = z.union([
  z.object({ code: z.string().min(1) }).transform((error) => error.code),
  z.instanceof(Error).transform((error) => error.name),
  // OpenCode's client rejects with tagged values, not Errors.
  z.object({ _tag: z.string().min(1) }).transform((error) => error._tag),
]).catch("thrown value")

export function traceProviderLaunch<T>(
  provider: string,
  conversation: string,
  launch: (trace: ProviderLaunchTrace) => Promise<T>,
  work: HostWork = unwatchedWork
): Promise<T> {
  const trace = new ProviderLaunchTrace({ provider, conversation }, { work })
  return trace.step("launch", () => launch(trace))
}

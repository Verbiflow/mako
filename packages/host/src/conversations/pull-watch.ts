import { hostWarn } from "../base/host-log.js"
import { createHash } from "node:crypto"
import { errorMessage } from "../base/error-message.js"
import { PULL_READ_FAILED_MS, pullOutcome, pullWakeNote, type PullOutcome, type PullReading, type PullWaitUntil } from "../contracts/pull-waits.js"
import { GitHubRateLimitError, type PullTarget as ReadTarget } from "../git/index.js"

/** How often a watched pull request is read: the worktree summaries read a branch's pull requests no more often. */
export const PULL_WATCH_EVERY_MS = 60_000
/** The longest a pull request that keeps not changing goes unread: each unchanged reading doubles its wait up to this. */
export const PULL_WATCH_MAX_MS = 8 * 60_000
const READ_FAILURE_LOG_MS = 5 * 60_000

/** Where a watched pull request is read: by repository and number, or by number in its Fin's folder for a bare `#412`. */
export interface PullTarget extends ReadTarget {
  /** The watched set's key: its `pullKey`, or for a bare number, that and the folder it's read in. */
  key: string
}

/** One Fin's wait on one pull request, from the report that named it. */
export interface PullWait {
  /** The Fin, its retained dependency's first report and the pull request; the observation cursor completes a claim's identity. */
  key: string
  child: string
  /** First report in the uninterrupted dependency registration, and the pull request by `pullKey`. */
  report: string
  pullKey: string
  /** Report registration time: a cutoff for review events, never for the condition that current checks have settled. */
  since: number
  /** How its note names it: `acme/app#371`, or `#371`. */
  pull: string
  target: PullTarget
  until?: PullWaitUntil
  /** The head/check completion observation, independent of report narration. Filled by the reader before firing. */
  observation?: string
}

export interface PullWatchDeps {
  /** What waits now: every open Fin's latest report's retained pull request dependencies. */
  waits(): readonly PullWait[]
  read(target: PullTarget): Promise<PullReading | null>
  /** Wakes the Fin with `note`, once per retained wait and observation, across restarts. */
  fire(wait: PullWait, outcome: PullOutcome, note: string): Promise<void>
  /** Whether anything is watched, so the job that reads runs only then. */
  watching?(on: boolean): void
  now(): number
}

interface Watched {
  target: PullTarget
  dueAt: number
  everyMs: number
  /** The last reading, in a form two readings compare by. */
  seen?: string
  last?: PullReading
  failedSince?: number
  warnedAt?: number
}

/**
 * The pull requests Fins said they wait on (`waitingOn`), and only those. Each is read on its own cadence, from a
 * minute after it's first watched, doubling while nothing on it changes up to `PULL_WATCH_MAX_MS`, back to a minute
 * once something does. A reading that shows an outcome supplies its head/completion cursor to the durable claim; a pull request nothing
 * waits on any more is dropped. The set is never stored: it's what `waits` says, read from the reports on each tick,
 * so a restarted host watches what the last one did.
 */
export class PullWatch {
  private readonly deps: PullWatchDeps
  private readonly watched = new Map<string, Watched>()
  private ticking: Promise<void> | undefined
  /** When the watch first read each wait's current head (`wait key @ head`): a later push starts a no-checks clock again. */
  private readonly seenHeads = new Map<string, number>()
  /** Required checks already logged as never appearing, by pull request and name: said once, not every reading. */
  private readonly unseenRequired = new Set<string>()

  constructor(deps: PullWatchDeps) {
    this.deps = deps
  }

  /** The keys watched now, in the order they were first watched. */
  keys(): string[] {
    return [...this.watched.keys()]
  }

  /** When each watched pull request is read next. */
  due(key: string): number | undefined {
    return this.watched.get(key)?.dueAt
  }

  /** Takes in what waits now: new pull requests are read at the next tick, ones nothing waits on are dropped. */
  refresh(): readonly PullWait[] {
    const waits = this.deps.waits()
    const now = this.deps.now()
    const wanted = new Map(waits.map((wait) => [wait.target.key, wait.target]))
    for (const key of this.watched.keys()) if (!wanted.has(key)) this.watched.delete(key)
    const waiting = new Set(waits.map((wait) => wait.key))
    for (const key of this.seenHeads.keys()) if (!waiting.has(key.slice(0, key.lastIndexOf("@")))) this.seenHeads.delete(key)
    for (const [key, target] of wanted) if (!this.watched.has(key)) this.watched.set(key, { target, dueAt: now, everyMs: PULL_WATCH_EVERY_MS })
    this.deps.watching?.(this.watched.size > 0)
    return waits
  }

  /** Reads each pull request that's due, one at a time, and fires the waits its reading answers. */
  tick(): Promise<void> {
    this.ticking ??= this.run().finally(() => {
      this.ticking = undefined
    })
    return this.ticking
  }

  private async run(): Promise<void> {
    const waits = this.refresh()
    for (const [key, watched] of this.watched) {
      if (watched.dueAt > this.deps.now()) continue
      let reading: PullReading | null
      try {
        reading = await this.deps.read(watched.target)
      } catch (cause) {
        if (cause instanceof GitHubRateLimitError) {
          // An intentional reader pause breaks the continuous request-failure interval.
          watched.failedSince = undefined
          watched.dueAt = cause.retryAt
          continue
        }
        reading = null
      }
      const seen = reading ? JSON.stringify(reading) : undefined
      const changed = seen !== undefined && seen !== watched.seen
      if (seen !== undefined) watched.seen = seen
      watched.everyMs = changed ? PULL_WATCH_EVERY_MS : Math.min(watched.everyMs * 2, PULL_WATCH_MAX_MS)
      watched.dueAt = this.deps.now() + watched.everyMs
      if (!reading) {
        const now = this.deps.now()
        watched.failedSince ??= now
        if (watched.warnedAt === undefined || now - watched.warnedAt >= READ_FAILURE_LOG_MS) {
          watched.warnedAt = now
          // A custom reader may throw arbitrary output. Log only the failure, never its command, stderr or response.
          hostWarn("agents", "a watched pull request could not be read", { pull: key })
        }
        for (const wait of waits) if (wait.target.key === key && now - Math.max(wait.since, watched.failedSince) >= PULL_READ_FAILED_MS)
          await this.fire(wait, { kind: "unreadable", minutes: PULL_READ_FAILED_MS / 60_000 }, watched.last)
        continue
      }
      watched.failedSince = undefined
      watched.last = reading
      for (const wait of waits) {
        if (wait.target.key !== key) continue
        const head = `${wait.key}@${reading.head ?? ""}`
        if (!this.seenHeads.has(head)) this.seenHeads.set(head, this.deps.now())
        const outcome = pullOutcome(reading, wait.until, wait.since, this.deps.now(), this.seenHeads.get(head))
        if (!outcome) continue
        await this.fire(wait, outcome, reading)
      }
    }
    this.refresh()
  }

  /** Incomplete is once per head; unreadable is once per retained wait, even if its last-known head changes. */
  private async fire(wait: PullWait, outcome: PullOutcome, reading?: PullReading): Promise<void> {
    const note = pullWakeNote(wait.pull, reading?.url, outcome, reading?.head)
    // A required check is named by its context, which an app or code scanning can report under another name: one
    // that never appears may be a name that doesn't match, so the log says which, beside what did run.
    const unseen = reading && outcome.kind === "no-checks" ? (outcome.missing ?? []).filter((name) => !this.unseenRequired.has(`${wait.pullKey}:${name}`)) : []
    if (unseen.length) {
      for (const name of unseen) this.unseenRequired.add(`${wait.pullKey}:${name}`)
      hostWarn("agents", "a required check never appeared", { pull: wait.pullKey, head: reading?.head ?? "", missing: unseen.join(", "), ran: reading?.checks.map((check) => check.name).join(", ") })
    }
    try {
      const checks = (reading?.checks ?? []).filter((check) => outcome.kind !== "failed" || check.state === "failed")
        .map((check) => JSON.stringify([check.name, check.state, check.at ?? null])).sort()
      const observation = createHash("sha256").update(JSON.stringify([
        outcome.kind === "unreadable" ? null : reading?.head ?? null, outcome.kind,
        outcome.kind === "settled" || outcome.kind === "failed" ? checks : outcome.kind === "incomplete" || outcome.kind === "unreadable" ? null : outcome,
      ])).digest("hex")
      await this.deps.fire({ ...wait, observation }, outcome, note)
    } catch (error) {
      hostWarn("agents", "a pull request's outcome didn't reach its Fin", { wait: wait.key, error: errorMessage({ error }) })
    }
  }
}

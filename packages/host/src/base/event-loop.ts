import { AsyncLocalStorage } from "node:async_hooks"
import { createHistogram, performance } from "node:perf_hooks"
import type { EventLoop, LoopHold } from "../contracts/runtime.js"
import { hostWarn } from "./host-log.js"

/** Work the host does, named, so a held event loop can say what was running, and a load can say who asked. */
export interface HostWork {
  /** Marks named work begun; the returned function marks it done. */
  begin(label: string): () => void
  /**
   * Runs `fn` as named work: begun and ended around it, and `current()` names it inside, through every await, while it
   * runs, so what the work reads in (a conversation's journal) is counted to it. A call, a job and a domain load run so.
   */
  run<Result>(label: string, fn: () => Result): Result
  /**
   * The named work this code runs for, while that work is still running: a timer, a socket's listener or a child's
   * exit that the work set up and that fires after it ended is no longer its, and names the work around it instead,
   * or none.
   */
  current(): string | undefined
}

/** For a part built without a host around it, such as in a test. */
export const unwatchedWork: HostWork = { begin: () => () => {}, run: (_label, fn) => fn(), current: () => undefined }

/** Work named for a test: `run` names it to `current()`, and nothing watches the loop. */
export function namedWork(): HostWork {
  const names = new WorkNames()
  return { begin: () => () => {}, run: (label, fn) => names.run(label, fn, () => {}), current: () => names.current() }
}

/** One run of named work as the code it started sees it: open until the run ends, inside the run it began in. */
interface WorkScope {
  readonly label: string
  open: boolean
  readonly outer: WorkScope | undefined
}

/**
 * Names work to the code it runs, through every await, only while it runs. The name is carried by
 * `AsyncLocalStorage`, which also hands it to every timer, socket and child listener the work creates, long after the
 * work ended (a domain load starts a domain's timers; a call can spawn a process): so what's carried is the run itself,
 * closed when it ends, and a callback of a run that ended is named by the run around it that's still open, or by none.
 */
class WorkNames {
  readonly #context = new AsyncLocalStorage<WorkScope>()

  run<Result>(label: string, fn: () => Result, done: () => void): Result {
    const scope: WorkScope = { label, open: true, outer: this.#context.getStore() }
    const end = () => {
      scope.open = false
      done()
    }
    return this.#context.run(scope, () => {
      try {
        return ended(fn(), end)
      } catch (error) {
        end()
        throw error
      }
    })
  }

  current(): string | undefined {
    for (let scope = this.#context.getStore(); scope; scope = scope.outer) if (scope.open) return scope.label
    return undefined
  }
}

/** Ends `done` once `result` has: now for a value, once a promise settles either way. */
function ended<Result>(result: Result, done: () => void): Result {
  if (result instanceof Promise) void result.then(done, done)
  else done()
  return result
}

export interface EventLoopWatchOptions {
  /** How often the loop is checked while the host works. */
  resolutionMs?: number
  /** A check this late is a hold: logged, and kept in `/health`. */
  heldMs?: number
  /** How long the loop stays watched after an event goes out. */
  lingerMs?: number
}

interface Span {
  label: string
  since: number
  ended?: number
}

const RECENT_SPANS = 64
const RECENT_HOLDS = 8
const NAMED_PER_HOLD = 5
const LOG_EVERY_MS = 1000

/**
 * Watches the event loop while the host works, and only then: a timer checks
 * it every `resolutionMs` while a call, job or domain load is running, and
 * for `lingerMs` after an event goes out, which is when an agent's output is
 * being decoded. An idle host has no timer, so watching costs it nothing,
 * and with nothing running there is nothing to hold the loop.
 *
 * A check that runs `heldMs` or more late means something held the loop that
 * long. It's logged with the work that was running then, longest first, and
 * kept in `/health`; how late every check ran is kept as a histogram.
 */
export class EventLoopWatch implements HostWork {
  private readonly resolutionMs: number
  private readonly heldMs: number
  private readonly lingerMs: number
  private readonly delay = createHistogram()
  /** The work the running code runs for, while it's open (`run`). */
  private readonly names = new WorkNames()
  private readonly open = new Map<number, Span>()
  private readonly recent: Span[] = []
  private readonly holds: LoopHold[] = []
  private longest: LoopHold | undefined
  private count = 0
  private nextSpan = 0
  private timer: NodeJS.Timeout | undefined
  private lastCheck = 0
  private due = 0
  private lingerUntil = 0
  private loggedAt = -Infinity
  private unlogged = 0
  private stopped = false

  constructor({ resolutionMs = 20, heldMs = 100, lingerMs = 1000 }: EventLoopWatchOptions = {}) {
    this.resolutionMs = resolutionMs
    this.heldMs = heldMs
    this.lingerMs = lingerMs
  }

  begin(label: string): () => void {
    if (this.stopped) return () => {}
    const id = this.nextSpan++
    const span: Span = { label, since: performance.now() }
    this.open.set(id, span)
    this.watch()
    return () => {
      if (!this.open.delete(id)) return
      span.ended = performance.now()
      this.recent.push(span)
      if (this.recent.length > RECENT_SPANS) this.recent.shift()
    }
  }

  run<Result>(label: string, fn: () => Result): Result {
    return this.names.run(label, fn, this.begin(label))
  }

  current(): string | undefined {
    return this.names.current()
  }

  /** An event went out: the loop stays watched for `lingerMs`. */
  touch(): void {
    if (this.stopped) return
    this.lingerUntil = performance.now() + this.lingerMs
    this.watch()
  }

  snapshot(): EventLoop {
    const ms = (value: number) => Math.round(value / 10) / 100
    const checks = this.delay.count
    return {
      watching: this.timer !== undefined,
      resolutionMs: this.resolutionMs,
      heldMs: this.heldMs,
      delayMs: checks
        ? { checks, p50: ms(this.delay.percentile(50)), p99: ms(this.delay.percentile(99)), max: ms(this.delay.max) }
        : { checks, p50: 0, p99: 0, max: 0 },
      utilization: Math.round(performance.eventLoopUtilization().utilization * 1000) / 1000,
      holds: { count: this.count, ...(this.longest && { longest: this.longest }), recent: [...this.holds] },
    }
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private watch(): void {
    if (this.timer) return
    this.lastCheck = performance.now()
    this.schedule()
  }

  private schedule(): void {
    this.due = performance.now() + this.resolutionMs
    this.timer = setTimeout(() => this.check(), this.resolutionMs)
    this.timer.unref()
  }

  private check(): void {
    const now = performance.now()
    const late = Math.max(0, now - this.due)
    this.delay.record(Math.max(1, Math.round(late * 1000)))
    if (late >= this.heldMs) this.held(this.lastCheck, now, late)
    this.lastCheck = now
    if (this.open.size > 0 || now < this.lingerUntil) this.schedule()
    else this.timer = undefined
  }

  /** The loop was held `ms` somewhere between `from` and `to`: names the work running in that stretch, longest first. */
  private held(from: number, to: number, ms: number): void {
    const longestByLabel = new Map<string, number>()
    for (const span of [...this.open.values(), ...this.recent.filter((span) => (span.ended ?? to) >= from)]) {
      const spanMs = (span.ended ?? to) - span.since
      longestByLabel.set(span.label, Math.max(spanMs, longestByLabel.get(span.label) ?? 0))
    }
    const during = [...longestByLabel]
      .sort((a, b) => b[1] - a[1])
      .slice(0, NAMED_PER_HOLD)
      .map(([label, spanMs]) => `${label} (${Math.round(spanMs)} ms)`)
    const hold: LoopHold = { at: Date.now(), ms: Math.round(ms), during }
    this.count += 1
    if (!this.longest || hold.ms > this.longest.ms) this.longest = hold
    this.holds.push(hold)
    if (this.holds.length > RECENT_HOLDS) this.holds.shift()
    if (to - this.loggedAt < LOG_EVERY_MS) {
      this.unlogged += 1
      return
    }
    hostWarn("loop", "event loop held", {
      ms: hold.ms,
      during: during.join(", ") || "no named work",
      ...(this.unlogged > 0 && { alsoHeldSinceLastLine: this.unlogged }),
    })
    this.loggedAt = to
    this.unlogged = 0
  }
}

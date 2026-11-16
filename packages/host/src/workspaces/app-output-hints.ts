import type { AppKey } from "../contracts/thread-environments.js"
import type { WatchListener, WatchSubscription } from "./watch-backend.js"

const MAX_WATCHES = 128
interface Run {
  done: Promise<void>
  finished(): void
  subscription?: WatchSubscription
  ready: boolean
  muted: boolean
  late: boolean
  closing: boolean
}

/** Only visible outputs' app folders are watched, in the existing child. Sibling apps never send their events. */
export class AppOutputHints {
  private readonly runs = new Map<AppKey, Run>()
  private readonly retries = new Map<AppKey, { at: number; ms: number }>()
  private closed = false
  private pending?: NodeJS.Timeout
  private warned?: { message: string; at: number }
  private readonly deps: {
    wanted(): ReadonlySet<AppKey>
    watch(app: AppKey, listener: WatchListener): Promise<WatchSubscription>
    changed(fields: string[]): void
    warn(message: string): void
    now?(): number
  }
  constructor(deps: AppOutputHints["deps"]) { this.deps = deps }

  /** Also called by the existing sampler tick to notice a disconnected window or retry a failed watch. */
  reconcile = (confirm = false): void => {
    const wanted = this.closed ? new Set<AppKey>() : this.deps.wanted()
    if (!wanted.size) this.clearHint()
    for (const [app, run] of this.runs) if (!wanted.has(app)) this.release(app, run)
    for (const app of this.retries.keys()) if (!wanted.has(app)) this.retries.delete(app)
    for (const app of wanted) {
      if (this.runs.has(app) || this.runs.size >= MAX_WATCHES) continue
      if ((this.deps.now?.() ?? Date.now()) < (this.retries.get(app)?.at ?? 0)) continue
      this.open(app)
    }
    if (confirm && [...this.runs.values()].some(run => this.healthy(run))) this.deps.changed(["watch-ready"])
  }

  private open(app: AppKey) {
    let finished!: () => void
    const done = new Promise<void>(resolve => { finished = resolve })
    const run: Run = { done, finished, ready: false, muted: false, late: false, closing: false }
    this.runs.set(app, run)
    const current = () => this.runs.get(app) === run && !run.closing && !this.closed
    const health = () => {
      if (current()) this.deps.changed(this.healthy(run) ? ["watch-ready", "output"] : ["watch-unavailable"])
    }
    const failed = (message: string) => {
      if (!current()) return
      this.warn(message)
      this.retry(app)
      this.deps.changed(["watch-unavailable"])
      this.release(app, run)
    }
    // Keep a late opening owned. A replacement for this app cannot open until its old handle is released.
    void Promise.resolve().then(() => current() && this.deps.wanted().has(app) ? this.deps.watch(app, {
      events: (events) => {
        if (!current() || !this.healthy(run) || this.pending || !events.some(event => /\.log(?:\.1)?$/.test(event.path))) return
        this.pending = setTimeout(() => {
          this.pending = undefined
          if (!this.closed && this.deps.wanted().size) this.deps.changed(["output"])
        }, 2_000)
        this.pending.unref()
      },
      dropped: () => { if (current()) this.deps.changed(["output"]) },
      gone: () => failed("App output changes could no longer be followed"),
      muted: (muted) => { run.muted = muted; health() },
      late: (late) => { run.late = late; health() },
    }) : undefined).then(subscription => {
      if (!subscription) {
        if (this.runs.get(app) === run) this.runs.delete(app)
        run.finished()
        this.reconcile()
        return
      }
      run.subscription = subscription
      if (!current() || !this.deps.wanted().has(app)) { this.release(app, run); return }
      run.ready = true
      this.retries.delete(app)
      health() // Catch writes between the first read and the watch becoming ready.
    }).catch((error: Error) => {
      if (current()) {
        this.warn(error.message)
        this.retry(app)
        this.deps.changed(["watch-unavailable"])
      }
      if (run.subscription) this.release(app, run)
      else {
        if (this.runs.get(app) === run) this.runs.delete(app)
        run.finished()
      }
    })
  }
  private retry(app: AppKey) {
    const ms = this.retries.get(app)?.ms ?? 1_000
    this.retries.set(app, { at: (this.deps.now?.() ?? Date.now()) + ms, ms: Math.min(30_000, ms * 2) })
  }
  private warn(message: string) {
    const now = this.deps.now?.() ?? Date.now()
    if (this.warned?.message === message && now - this.warned.at < 60_000) return
    this.warned = { message, at: now }
    this.deps.warn(message)
  }
  ready(apps: readonly AppKey[] = [...this.deps.wanted()]): boolean {
    const wanted = this.deps.wanted()
    return !this.closed && apps.length > 0 && apps.every(app => {
      const run = this.runs.get(app)
      return wanted.has(app) && run !== undefined && this.healthy(run)
    })
  }
  private healthy(run: Run) { return run.ready && !run.muted && !run.late && !run.closing }
  private clearHint() { clearTimeout(this.pending); this.pending = undefined }
  private release(app: AppKey, run: Run) {
    run.closing = true
    const subscription = run.subscription
    if (!subscription) return
    run.subscription = undefined
    void subscription.unsubscribe().then(() => {
      if (this.runs.get(app) === run) this.runs.delete(app)
      run.finished()
      this.reconcile()
    }, (error: Error) => {
      // A failed release retires only this app's slot, rather than accumulating unowned handles.
      this.warn(error.message)
      run.finished()
    })
  }
  async close(): Promise<void> {
    this.closed = true
    this.clearHint()
    const runs = [...this.runs.entries()]
    for (const [app, run] of runs) this.release(app, run)
    if (!runs.length) return
    let timer: NodeJS.Timeout | undefined
    try { await Promise.race([Promise.all(runs.map(([, run]) => run.done)), new Promise<void>(resolve => { timer = setTimeout(resolve, 2_000); timer.unref() })]) }
    finally { clearTimeout(timer) }
  }
}

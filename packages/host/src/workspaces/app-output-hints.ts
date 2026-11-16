import type { WatchListener, WatchSubscription } from "./watch-backend.js"

interface Run {
  done: Promise<void>
  finished(): void
  subscription?: WatchSubscription
  ready: boolean
  muted: boolean
  late: boolean
  closing: boolean
}

/** One output tree watch, in the existing child, only while a connected visible window shows output. */
export class AppOutputHints {
  private run?: Run
  private closed = false
  private pending?: NodeJS.Timeout
  private retryAt = 0
  private retryMs = 1_000
  private warned?: { message: string; at: number }
  private readonly deps: {
    wanted(): boolean
    watch(listener: WatchListener): Promise<WatchSubscription>
    changed(fields: string[]): void
    warn(message: string): void
    now?(): number
  }
  constructor(deps: AppOutputHints["deps"]) { this.deps = deps }

  /** Also called by the existing sampler tick to notice a disconnected window or retry a failed watch. */
  reconcile = (confirm = false): void => {
    if (this.closed || !this.deps.wanted()) {
      if (this.run) this.release(this.run)
      return
    }
    if (this.run) {
      if (confirm && this.healthy(this.run)) this.deps.changed(["watch-ready"])
      return
    }
    if ((this.deps.now?.() ?? Date.now()) < this.retryAt) return
    let finished!: () => void
    const done = new Promise<void>(resolve => { finished = resolve })
    const run: Run = { done, finished, ready: false, muted: false, late: false, closing: false }
    this.run = run
    const current = () => this.run === run && !run.closing && !this.closed
    const health = () => {
      if (!current()) return
      this.clearHint()
      this.deps.changed(this.healthy(run) ? ["watch-ready", "output"] : ["watch-unavailable"])
    }
    const failed = (message: string) => {
      if (!current()) return
      this.warn(message)
      this.retryAt = (this.deps.now?.() ?? Date.now()) + this.retryMs
      this.retryMs = Math.min(30_000, this.retryMs * 2)
      this.deps.changed(["watch-unavailable"])
      this.release(run)
    }
    // Keep the opening owned even after hide/close; another watch cannot open until its late handle is released.
    void Promise.resolve().then(() => current() && this.deps.wanted() ? this.deps.watch({
      events: (events) => {
        if (!current() || !this.healthy(run) || this.pending || !events.some(event => /\.log(?:\.1)?$/.test(event.path))) return
        this.pending = setTimeout(() => {
          this.pending = undefined
          if (current() && this.healthy(run) && this.deps.wanted()) this.deps.changed(["output"])
        }, 2_000)
        this.pending.unref()
      },
      dropped: () => { if (current()) this.deps.changed(["output"]) },
      gone: () => failed("App output changes could no longer be followed"),
      muted: (muted) => { run.muted = muted; health() },
      late: (late) => { run.late = late; health() },
    }) : undefined).then(subscription => {
      if (!subscription) {
        if (this.run === run) this.run = undefined
        run.finished()
        return
      }
      run.subscription = subscription
      if (!current() || !this.deps.wanted()) { this.release(run); return }
      run.ready = true
      this.retryMs = 1_000; this.retryAt = 0
      health() // Catch writes between the first read and the watch becoming ready.
    }).catch((error: Error) => {
      if (current()) {
        this.warn(error.message)
        this.retryAt = (this.deps.now?.() ?? Date.now()) + this.retryMs
        this.retryMs = Math.min(30_000, this.retryMs * 2)
        this.deps.changed(["watch-unavailable"])
      }
      if (run.subscription) this.release(run)
      else {
        if (this.run === run) this.run = undefined
        run.finished()
      }
    })
  }

  private warn(message: string) {
    const now = this.deps.now?.() ?? Date.now()
    if (this.warned?.message === message && now - this.warned.at < 60_000) return
    this.warned = { message, at: now }
    this.deps.warn(message)
  }
  ready(): boolean { return !this.closed && this.deps.wanted() && this.run !== undefined && this.healthy(this.run) }
  private healthy(run: Run) { return run.ready && !run.muted && !run.late && !run.closing }
  private clearHint() { clearTimeout(this.pending); this.pending = undefined }
  private release(run: Run) {
    run.closing = true
    this.clearHint()
    // An opening finishes here when it returns. Serialize close/open rather than accumulating late subscriptions.
    const subscription = run.subscription
    if (!subscription) return
    run.subscription = undefined
    void subscription.unsubscribe().then(() => {
      if (this.run === run) this.run = undefined
      run.finished()
      this.reconcile()
    }, (error: Error) => {
      // Keep this slot retired on a failed release: polling is safer than accumulating unowned handles.
      this.warn(error.message)
      run.finished()
    })
  }
  async close(): Promise<void> {
    this.closed = true
    const run = this.run
    if (!run) return
    this.release(run)
    let timer: NodeJS.Timeout | undefined
    try { await Promise.race([run.done, new Promise<void>(resolve => { timer = setTimeout(resolve, 2_000); timer.unref() })]) }
    finally { clearTimeout(timer) }
  }
}

/** Coalesce live Git inventories, with a final pass after each command's measured delivery allowance. */
const COALESCE_MS = 50
const MAX_LAG_MS = 30_000
const MIN_INTERVAL_MS = 2_000

interface Request {
  due: number
  reached: Promise<void>
  done(): void
}
interface Root {
  id: string
  requests: Request[]
  immediate?: number
  timer?: ReturnType<typeof setTimeout>
  running?: Promise<void>
  startedAt?: number
  error?: Error
}

/** Inventory requests carry no writer claim: the tracker still classifies every version from its existing evidence. */
export class ShellReconciliations {
  private readonly roots = new Map<string, Root>()
  private readonly refresh: (root: string) => Promise<void>
  private readonly failed: (root: string, error: Error) => void
  private closed = false

  constructor(refresh: (root: string) => Promise<void>, failed: (root: string, error: Error) => void) {
    this.refresh = refresh
    this.failed = failed
  }

  schedule(id: string, lagMs: number): void {
    if (this.closed) return
    let root = this.roots.get(id)
    if (!root) { root = { id, requests: [] }; this.roots.set(id, root) }
    const now = Date.now()
    const due = Math.ceil((now + Math.max(COALESCE_MS, Math.min(MAX_LAG_MS, lagMs))) / COALESCE_MS) * COALESCE_MS
    // A burst shares one barrier per short delivery bucket, not one promise per tool update.
    if (!root.requests.some((request) => request.due === due)) {
      let done!: () => void
      const reached = new Promise<void>((resolve) => { done = resolve })
      root.requests.push({ due, reached, done })
    }
    root.immediate ??= now + COALESCE_MS
    this.arm(root)
  }

  private arm(root: Root): void {
    clearTimeout(root.timer)
    root.timer = undefined
    if (this.closed || root.running || !root.requests.length) return
    const due = Math.max((root.startedAt ?? -Infinity) + MIN_INTERVAL_MS, Math.min(root.immediate ?? Infinity, ...root.requests.map((request) => request.due)))
    root.timer = setTimeout(() => { root.timer = undefined; void this.perform(root) }, Math.max(0, due - Date.now()))
    root.timer.unref?.()
  }

  private perform(root: Root, final = false): Promise<void> {
    if (root.running) return root.running
    if (!final && Date.now() < (root.startedAt ?? -Infinity) + MIN_INTERVAL_MS) { this.arm(root); return Promise.resolve() }
    clearTimeout(root.timer)
    root.timer = undefined
    root.immediate = undefined
    root.startedAt = Date.now()
    // A request ends only after a scan that began after its allowance. New commands cannot postpone older waits.
    const reached = new Set(root.requests.filter((request) => final || request.due <= Date.now()))
    const pending = Promise.resolve().then(() => this.refresh(root.id)).then(() => {
      root.error = undefined
    }, (cause) => {
      root.error = cause instanceof Error ? cause : new Error("A shell's Git inventory could not be read", { cause })
      this.failed(root.id, root.error)
    }).then(() => {
      root.requests = root.requests.filter((request) => !reached.has(request))
      for (const request of reached) request.done()
      root.running = undefined
      // Keep the last start until untrack/close, so a newly arriving command still respects this root's spacing.
      this.arm(root)
    })
    root.running = pending
    return pending
  }

  /** Read what exists now, without making ordinary journal readers wait for future delivery. */
  async flush(): Promise<void> {
    await Promise.all([...this.roots.values()].filter((root) => root.immediate !== undefined || root.requests.some((request) => request.due <= Date.now())).map((root) => this.perform(root)))
  }

  /** A watermark: later commands may coalesce with these scans, but cannot extend this caller's wait indefinitely. */
  async heard(): Promise<void> {
    const roots = [...this.roots.values()]
    const requests = roots.flatMap((root) => root.requests.map((request) => request.reached))
    await Promise.all(roots.filter((root) => root.error && !root.requests.length).map((root) => this.perform(root)))
    await Promise.all(requests)
    const errors = roots.flatMap((root) => root.error ? [root.error] : [])
    if (errors.length) throw new AggregateError(errors, "Shell reconciliation is incomplete")
  }

  forget(id: string): void {
    const root = this.roots.get(id)
    if (!root) return
    clearTimeout(root.timer)
    root.requests.forEach((request) => request.done())
    root.requests = []
    this.roots.delete(id)
  }

  async close(): Promise<void> {
    this.closed = true
    const roots = [...this.roots.values()].filter((root) => root.running || root.requests.length || root.error)
    roots.forEach((root) => clearTimeout(root.timer))
    await Promise.all(roots.map(async (root) => { await root.running; await this.perform(root, true) }))
    this.roots.clear()
  }
}

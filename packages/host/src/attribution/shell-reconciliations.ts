/** Silent-watch recovery runs once at turn end, after the measured delivery allowance. */
const MAX_LAG_MS = 30_000
const MIN_INTERVAL_MS = 2_000
const HOST_INTERVAL_MS = 250
const HOST_CONCURRENCY = 2

interface Request {
  due: number
  reached: Promise<void>
  done(): void
}
interface Root {
  id: string
  requests: Request[]
  running?: Promise<void>
  startedAt?: number
}

/** One owner in the journal writer: root spacing plus a host-wide start rate and concurrency bound. */
export class ShellReconciliations {
  private readonly roots = new Map<string, Root>()
  private readonly refresh: (root: string) => Promise<void>
  private readonly failed: (root: string, error: Error) => void
  private timer?: ReturnType<typeof setTimeout>
  private active = 0
  private startedAt = -Infinity
  private closed = false

  constructor(refresh: (root: string) => Promise<void>, failed: (root: string, error: Error) => void) {
    this.refresh = refresh
    this.failed = failed
  }

  schedule(id: string, lagMs: number): void {
    if (this.closed) return
    let root = this.roots.get(id)
    if (!root) { root = { id, requests: [] }; this.roots.set(id, root) }
    const due = Date.now() + Math.max(0, Math.min(MAX_LAG_MS, lagMs))
    if (!root.requests.some((request) => request.due === due)) {
      let done!: () => void
      const reached = new Promise<void>((resolve) => { done = resolve })
      root.requests.push({ due, reached, done })
    }
    this.arm()
  }

  private due(root: Root): number {
    return Math.max((root.startedAt ?? -Infinity) + MIN_INTERVAL_MS, root.requests[0]!.due, this.startedAt + HOST_INTERVAL_MS)
  }

  private arm(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.active >= HOST_CONCURRENCY) return
    const next = [...this.roots.values()].filter((root) => !root.running && root.requests.length).sort((a, b) => this.due(a) - this.due(b))[0]
    if (!next) return
    this.timer = setTimeout(() => { this.timer = undefined; this.perform(next) }, Math.max(0, this.due(next) - Date.now()))
    this.timer.unref?.()
  }

  private perform(root: Root): void {
    const reached = new Set(root.requests.filter((request) => request.due <= Date.now()))
    root.startedAt = this.startedAt = Date.now()
    this.active++
    root.running = Promise.resolve().then(() => this.refresh(root.id)).catch((cause: unknown) => {
      this.failed(root.id, cause instanceof Error ? cause : new Error("A shell's Git inventory could not be read", { cause }))
    }).finally(() => {
      root.requests = root.requests.filter((request) => !reached.has(request))
      for (const request of reached) request.done()
      root.running = undefined
      this.active--
      this.arm()
    })
    this.arm()
  }

  /** A scoped watermark. Failure is logged by the owner; callers continue on the journal's existing evidence. */
  async heard(ids: readonly string[]): Promise<void> {
    await Promise.all(ids.flatMap((id) => this.roots.get(id)?.requests.map((request) => request.reached) ?? []))
  }

  forget(id: string): void {
    const root = this.roots.get(id)
    if (!root) return
    root.requests.forEach((request) => request.done())
    root.requests = []
    this.roots.delete(id)
    this.arm()
  }

  async close(): Promise<void> {
    this.closed = true
    for (const root of this.roots.values()) for (const request of root.requests) request.due = Math.min(request.due, Date.now())
    this.arm()
    await this.heard([...this.roots.keys()])
    await Promise.all([...this.roots.values()].map((root) => root.running))
    clearTimeout(this.timer)
    this.roots.clear()
  }
}

/** The existing stores own values; this only owns when their readers run. */
export type RefetchDomain = "apps" | "sync" | "output" | "preview" | "devices" | "updates" | "account" | "providers"
export interface RefetchClock {
  now(): number
  after(run: () => void, ms: number): () => void
}
export interface RefetchRead {
  scope: string
  domain: RefetchDomain
  key?: string
  fields: readonly string[]
  read(current: () => boolean): Promise<void>
  every(): number | undefined
}
export interface RefetchLease {
  refresh(options?: { immediate?: boolean; invalidate?: boolean }): void
  release(): void
}
interface Entry {
  options: RefetchRead
  refs: number
  generation: number
  running?: { generation: number }
  pending: number
  dirty: boolean
  immediate: boolean
  last: number
  retry: number
  retryAt: number
  cancel?: () => void
  due?: number
}
export const REFETCH_BATCH_MS = 2_000
const KNOWN_FIELDS = {
  apps: new Set(["all", "state", "checks", "room", "recipe", "diagnostics"]),
  sync: new Set(["all", "status"]),
  output: new Set(["all", "output", "state"]),
  preview: new Set(["all", "state", "recipe"]),
  devices: new Set(["all"]),
  updates: new Set(["all"]),
  account: new Set(["all"]),
  providers: new Set(["all"]),
} satisfies Record<RefetchDomain, ReadonlySet<string>>
const CLOCK: RefetchClock = {
  now: Date.now,
  after: (run, ms) => { const timer = setTimeout(run, ms); return () => clearTimeout(timer) },
}

export class ViewRefetch {
  private readonly entries = new Map<string, Entry>()
  private readonly paused = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private shown = true
  private closed = false
  private pending = 0
  private readonly clock: RefetchClock
  private readonly counts = { refetches: 0, completed: 0, failed: 0, staleAnswers: 0, deferredRefetches: 0, deferredInFlight: 0, coalesced: 0, skippedRows: 0, ignoredFields: 0 }

  constructor(clock: RefetchClock = CLOCK) { this.clock = clock }
  get visible(): boolean { return this.shown }
  connected(scope: string): boolean { return !this.paused.has(scope) }
  count(scope: string, domain: RefetchDomain): number {
    let count = 0
    for (const entry of this.entries.values()) if (entry.options.scope === scope && entry.options.domain === domain) count += entry.refs
    return count
  }
  onState(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  readings() { return { ...this.counts, activeKeys: this.entries.size, pending: this.pending } }

  watch(id: string, options: RefetchRead): RefetchLease {
    if (this.closed) throw new Error("The view readers have closed")
    let entry = this.entries.get(id)
    if (entry) {
      entry.refs++
      const every = entry.options.every()
      if (!entry.running && !entry.dirty && every !== undefined && every > 0) this.arm(id, entry, every)
    }
    else {
      entry = { options, refs: 1, generation: 0, pending: 0, dirty: true, immediate: true, last: -Infinity, retry: REFETCH_BATCH_MS, retryAt: 0 }
      this.entries.set(id, entry)
      if (this.ready(entry)) this.run(id, entry)
      else this.counts.deferredRefetches++
    }
    const owned = entry
    let released = false
    this.changed()
    return {
      refresh: (settings = {}) => {
        if (released) return
        if (settings.invalidate) { owned.generation++; owned.running = undefined }
        if (owned.dirty) this.counts.coalesced++
        else if (owned.running) this.counts.deferredInFlight++
        else if (!this.ready(owned)) this.counts.deferredRefetches++
        owned.dirty = true
        if (settings.immediate) { owned.immediate = true; owned.retryAt = 0 }
        if (!owned.running && this.ready(owned)) this.arm(id, owned, this.wait(owned))
      },
      release: () => {
        if (released) return
        released = true
        if (--owned.refs) return
        owned.generation++
        owned.cancel?.()
        this.entries.delete(id)
        this.changed()
      },
    }
  }

  invalidate(scope: string, domain: RefetchDomain | undefined, keys?: readonly string[], fields: readonly string[] = ["all"]): void {
    const matched = new Set<string>()
    for (const [id, entry] of this.entries) {
      const query = entry.options
      if (query.scope !== scope || (domain !== undefined && query.domain !== domain)) continue
      if (keys && query.key && !keys.includes(query.key)) continue
      if (query.key) matched.add(query.key)
      if (fields.length && fields.every((field) => KNOWN_FIELDS[query.domain].has(field) && field !== "all" && !query.fields.includes(field))) { this.counts.ignoredFields++; continue }
      if (entry.dirty) this.counts.coalesced++
      else if (entry.running) this.counts.deferredInFlight++
      else if (!this.ready(entry)) this.counts.deferredRefetches++
      entry.dirty = true
      if (!entry.running && this.ready(entry)) this.arm(id, entry, this.wait(entry))
    }
    if (keys) for (const key of new Set(keys)) if (!matched.has(key)) this.counts.skippedRows++
  }

  setVisible(visible: boolean): void {
    if (visible === this.shown || this.closed) return
    this.shown = visible
    for (const [id, entry] of this.entries) {
      entry.cancel?.(); entry.cancel = undefined; entry.due = undefined
      entry.generation++
      entry.running = undefined
      entry.dirty = true
      entry.immediate = true
      entry.retryAt = 0
      if (visible && this.ready(entry) && !entry.running) this.arm(id, entry, 0)
      else if (!visible) this.counts.deferredRefetches++
    }
    this.changed()
  }

  setConnected(scope: string, connected: boolean): void {
    if (connected === this.connected(scope)) return
    if (connected) this.paused.delete(scope)
    else this.paused.add(scope)
    this.reset(scope)
  }
  reset(scope?: string): void {
    for (const [id, entry] of this.entries) if (scope === undefined || entry.options.scope === scope) {
      entry.generation++; entry.dirty = true; entry.immediate = true; entry.retryAt = 0
      entry.running = undefined
      entry.cancel?.(); entry.cancel = undefined; entry.due = undefined
      if (!entry.running && this.ready(entry)) this.arm(id, entry, 0)
    }
    this.changed()
  }
  reschedule(scope: string, domain?: RefetchDomain): void {
    for (const [id, entry] of this.entries) if (entry.options.scope === scope && (domain === undefined || entry.options.domain === domain) && !entry.running) {
      entry.cancel?.(); entry.cancel = undefined; entry.due = undefined
      this.next(id, entry)
    }
  }
  dispose(): void {
    this.closed = true
    for (const entry of this.entries.values()) { entry.generation++; entry.cancel?.() }
    this.entries.clear(); this.listeners.clear()
  }
  private changed() { for (const listener of this.listeners) listener() }
  private ready(entry: Entry) { return !this.closed && this.shown && this.connected(entry.options.scope) }
  private wait(entry: Entry) { return Math.max(0, entry.immediate ? 0 : entry.last + REFETCH_BATCH_MS - this.clock.now(), entry.retryAt - this.clock.now()) }
  private arm(id: string, entry: Entry, ms: number) {
    const due = this.clock.now() + ms
    if (entry.due !== undefined && entry.due <= due) return
    entry.cancel?.()
    entry.due = due
    entry.cancel = this.clock.after(() => { entry.cancel = undefined; entry.due = undefined; this.run(id, entry) }, ms)
  }
  private next(id: string, entry: Entry) {
    if (this.entries.get(id) !== entry || !this.ready(entry)) return
    if (entry.dirty) this.arm(id, entry, this.wait(entry))
    else {
      const every = entry.options.every()
      if (every !== undefined && every > 0) this.arm(id, entry, every)
    }
  }
  private run(id: string, entry: Entry) {
    if (this.entries.get(id) !== entry || entry.running || !this.ready(entry)) return
    // An explicit action or return may supersede a slow read; at most one retired read overlaps its successor.
    if (entry.pending >= 2) { entry.dirty = true; return }
    const flight = { generation: entry.generation }
    entry.running = flight; entry.pending++; this.pending++
    entry.dirty = false; entry.immediate = false; entry.last = this.clock.now()
    const generation = entry.generation
    const current = () => this.entries.get(id) === entry && entry.running === flight && entry.generation === generation && this.ready(entry)
    this.counts.refetches++
    let pending: Promise<void>
    try { pending = entry.options.read(current) } catch (error) { pending = Promise.reject(error) }
    void pending.then(() => {
      this.counts.completed++
      if (!current()) this.counts.staleAnswers++
      if (current()) entry.retry = REFETCH_BATCH_MS
    }, () => {
      this.counts.failed++
      if (!current()) return
      entry.dirty = true
      entry.retryAt = this.clock.now() + Math.max(entry.retry, entry.options.every() ?? 0)
      entry.retry = Math.min(30_000, entry.retry * 2)
    }).finally(() => {
      entry.pending--; this.pending--
      if (entry.running === flight) entry.running = undefined
      if (!entry.running) this.next(id, entry)
    })
  }
}

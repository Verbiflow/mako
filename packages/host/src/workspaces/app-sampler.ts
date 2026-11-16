import type { AppMark, AppSamplingDemand } from "../contracts/thread-app.js"
import { SAMPLE_EVERY_MS } from "./app-probe.js"
import type { AppsLook } from "./environment-tools.js"

/** How often the sampler's job wakes; each wake looks only when a look is due. */
export const SAMPLER_TICK_MS = 1_000
/** While an app starts, installs or checks, a look a second, as the windows' own looks were. */
const SETTLING_MS = 1_000
/** While an app runs, a look every few seconds catches one that crashed or was ended outside Mako. */
const ALIVE_MS = 4_000
/** With nothing running, only what this host does changes anything, and it says so; this look is for another host's. */
const IDLE_MS = 30_000
/** What the trace and the memory look ran on before, as jobs of their own. */
const TRACE_MS = SAMPLE_EVERY_MS
const MEMORY_MS = 30_000
/**
 * How long an unopted reader's ask keeps the sampler looking. Windows ask for the marks and each followed folder's app every
 * 30 s while they show them (`thread-app-host.ts`), so a window open keeps it going and a host with none goes quiet:
 * looking with nobody to tell took main's idle host from 1.1–1.4% of a core to 3.5–4.5% (perf proof, 2026-11-12).
 */
export const WANTED_MS = 90_000
/** Demand is bounded even if callers keep inventing client identities. */
const MAX_READERS = 128

type Reader = { kind: "legacy"; until: number } | ({ kind: "window" } & AppSamplingDemand)

interface SamplerDeps {
  look(): Promise<AppsLook>
  /** Brings running apps' traces up to date (`EnvironmentTools.traceApps`). */
  trace?: () => Promise<void>
  /** Measures running apps' memory (`ThreadProcesses.memory`). */
  memory?: () => Promise<void>
  /** Every window hears the marks when they change. */
  publish(marks: AppMark[]): void
  now?: () => number
  /** Event connections that really exist, excluding observers; a payload never supplies its owner. */
  connection?: (client: string) => string | undefined
  invalidated?: () => void
}

/**
 * Every app on this Mac, looked at once for every window and pushed only when it changes. Each window used to ask
 * for the marks every second while an app started and every four seconds otherwise, and each folder it followed for
 * its app as often, each look reading the process table: 17% of the person's held loop on 2026-11-12 (339 s). The
 * trace and the memory look ride on the same looks, so the table is read once for all of them, off the host's loop
 * (`childProcessReader`), and only while some run is alive (`ThreadProcesses.tableFor`).
 *
 * `tick` is the one job (`HostJobs.every`, `SAMPLER_TICK_MS`). While a visible connection owns demand (`follow`), or
 * an unopted reader asked within `WANTED_MS`, it looks when one is due: after anything this host changed (`changed`), every second while an
 * app is settling, every four while one runs, and every half minute otherwise. With nobody reading it doesn't look at
 * all; the trace and the memory look run on their own times then, as they did before the sampler. A reader coming
 * back reads afresh (`current`), then hears the pushes.
 */
export class ThreadAppSampler {
  private readonly deps: SamplerDeps
  private readonly now: () => number
  private last: AppsLook | undefined
  private lookedAt = Number.NEGATIVE_INFINITY
  private tracedAt = Number.NEGATIVE_INFINITY
  private measuredAt = Number.NEGATIVE_INFINITY
  private dirty = true
  /** Whether a run was alive at the last trace: a trace closes an app's as it stops, so one more runs after the last goes. */
  private tracedAlive = true
  private readonly readers = new Map<string, Reader>()
  /** An overflowing legacy read retains the old bounded lease without retaining another identity. */
  private overflowUntil = Number.NEGATIVE_INFINITY

  constructor(deps: SamplerDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  /** Something this host did may have changed the marks: the next tick looks. */
  changed(): void {
    this.dirty = true
    this.deps.invalidated?.()
  }

  /** Legacy reads renew their lease; a connection that opted in owns its demand independently of its data reads. */
  wanted(client = "legacy"): void {
    this.prune()
    if (this.readers.get(client)?.kind === "window") return
    const until = this.now() + WANTED_MS
    if (!this.readers.has(client) && this.readers.size >= MAX_READERS) {
      this.overflowUntil = until
      return
    }
    this.readers.set(client, { kind: "legacy", until })
  }

  /**
   * Opt in on this connection, including a hidden tombstone that prevents reads renewing its old lease. True accepts
   * this generation, not receipt of any data; false leaves the caller on its existing behavior (or rejects a stale call).
   */
  follow(client: string, demand: AppSamplingDemand): boolean {
    const connection = this.connection(client)
    if (!connection || connection !== demand.connection) return false
    const wasWatched = this.watched()
    const previous = this.readers.get(client)
    if (previous?.kind === "window" && demand.generation <= previous.generation)
      return demand.generation === previous.generation && demand.visible === previous.visible
    if (!previous && this.readers.size >= MAX_READERS) return false
    this.readers.set(client, { kind: "window", connection: demand.connection, generation: demand.generation, visible: demand.visible })
    if (demand.visible && !wasWatched) this.dirty = true
    return true
  }

  /** A read-only binding for a real event connection; a client name alone cannot acquire demand. */
  connection(client: string): string | undefined {
    return this.deps.connection?.(client)
  }

  generation(client: string): number {
    this.prune()
    const reader = this.readers.get(client)
    return reader?.kind === "window" ? reader.generation : 0
  }

  /** A visible return reads afresh; an opted-in hidden reader only reads the held marks, without waking the sampler. */
  async current(client = "legacy"): Promise<AppMark[]> {
    this.prune()
    const reader = this.readers.get(client)
    if (reader?.kind === "window" && !reader.visible) return this.last?.marks ?? []
    const fresh = this.last !== undefined && this.watched() && (reader?.kind !== "window" || !this.dirty)
    this.wanted(client)
    if (!fresh) await this.sample()
    return this.last?.marks ?? []
  }

  private watched(): boolean {
    this.prune()
    if (this.now() < this.overflowUntil) return true
    for (const reader of this.readers.values()) if (reader.kind === "legacy" || reader.visible) return true
    return false
  }

  private prune(): void {
    const now = this.now()
    for (const [client, reader] of this.readers)
      if (reader.kind === "legacy" ? now >= reader.until : this.connection(client) !== reader.connection) this.readers.delete(client)
  }

  /** The job's wake: looks if one is due, and runs the trace and the memory look when theirs are. */
  readonly tick = async (): Promise<void> => {
    const now = this.now()
    const watched = this.watched()
    if (watched) {
      const every = !this.last ? 0 : this.last.settling ? SETTLING_MS : this.last.alive ? ALIVE_MS : IDLE_MS
      if (this.dirty || now - this.lookedAt >= every) await this.sample()
    }
    // Unwatched, no look says whether anything runs: the trace and the memory look find out for themselves, each
    // reading no process table while no run's group is alive (`ThreadProcesses.tableFor`).
    const alive = watched ? this.last?.alive ?? false : true
    if (this.deps.trace && now - this.tracedAt >= TRACE_MS && (alive || this.tracedAlive)) {
      this.tracedAt = now
      this.tracedAlive = watched ? alive : true
      await this.deps.trace()
    }
    if (this.deps.memory && alive && now - this.measuredAt >= MEMORY_MS) {
      this.measuredAt = now
      await this.deps.memory()
    }
  }

  private async sample(): Promise<void> {
    this.dirty = false
    this.lookedAt = this.now()
    const look = await this.deps.look()
    const before = this.last
    this.last = look
    if (!before || before.signature !== look.signature) this.deps.publish(look.marks)
  }
}

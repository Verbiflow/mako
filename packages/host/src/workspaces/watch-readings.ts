import { HourCounts } from "../base/hour-counts.js"
import { CALM_POLL_MS, SLOW_DELIVERY_MS, type DropReason } from "../contracts/watcher-child.js"
import type { WatchFootprint } from "../contracts/mako-footprint.js"

const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000
const SLOW_READ_MS = 5_000

/** Why the watcher child was started: the first watch, a crash, or a silence it was restarted for. */
export type ChildStart = "first" | "crash" | "silence"

/**
 * What the host's file watching costs and how macOS delivers to it, as the
 * watcher child and the history child tell it: the folders watched and the
 * streams they take, the child's restarts, how late events arrive, what was
 * dropped and why, and the history reads. One per host; Diagnostics reads it
 * and every change of state is a line in the host log.
 */
export class WatchReadings {
  private readonly log: (message: string, fields: Record<string, string | number | boolean>) => void
  private readonly watches = new Map<number, { root: string; ignore: string }>()
  private child?: { pid?: number; since: number }
  private historyChild?: { pid?: number; since: number }
  private starts: WatchFootprint["starts"] = { first: 0, crash: 0, silence: 0 }
  private delivery: WatchFootprint["delivery"] = { ok: true, since: Date.now() }
  private readonly events = new HourCounts()
  private readonly drops = new HourCounts()
  private readonly dropReasons = new Map<DropReason | "unsaid", HourCounts>()
  private readonly reads = new HourCounts()
  private readonly readPaths = new HourCounts()
  private slowestRead?: { ms: number; at: number }
  private loggedDrops = 0

  constructor(log: WatchReadings["log"] = () => {}) {
    this.log = log
  }

  watched(id: number, root: string, ignore: readonly string[]): void {
    this.watches.set(id, { root, ignore: ignore.join("\0") })
  }

  unwatched(id: number): void {
    this.watches.delete(id)
  }

  started(pid: number | undefined, why: ChildStart): void {
    this.child = { pid, since: Date.now() }
    this.starts[why] += 1
    this.log("watcher child started", { pid: pid ?? 0, why, watches: this.watches.size, streams: this.streams() })
  }

  stopped(pid: number | undefined, code: number | null, signal: string | null, why: "idle" | "silence" | "exit"): void {
    const ran = this.child ? Date.now() - this.child.since : 0
    this.child = undefined
    this.log("watcher child stopped", { pid: pid ?? 0, why, code: code ?? -1, signal: signal ?? "", ranMs: ran })
  }

  /** The history child started (a pid) or ended (undefined). */
  historyReader(pid: number | undefined): void {
    this.historyChild = pid === undefined ? undefined : { pid, since: Date.now() }
  }

  /** Delivery as the child's canary heard it: `ok` false once it went unheard, with how late the slowest recent beat came. */
  delivered(ok: boolean, lagMs: number | undefined): void {
    const before = this.delivery
    const slow = (lag?: number) => (lag ?? 0) > SLOW_DELIVERY_MS
    if (before.ok !== ok) this.log(ok ? "file events are heard again" : "file events go unheard; polling instead", { silentMs: ok ? Date.now() - before.since : 0, ...(lagMs !== undefined && { lagMs }) })
    else if (lagMs !== undefined && slow(lagMs) !== slow(before.lagMs)) this.log(slow(lagMs) ? "file events arrive late" : "file events arrive on time again", { lagMs })
    this.delivery = { ok, lagMs: lagMs ?? (ok ? before.lagMs : undefined), since: before.ok === ok ? before.since : Date.now() }
  }

  /** How late a change may be heard now: the canary's lag, and while that's slow, the calm poll's spacing (`CALM_POLL_MS`). */
  lagMs(): number {
    const lag = this.delivery.lagMs ?? 0
    return lag > SLOW_DELIVERY_MS ? Math.max(lag, CALM_POLL_MS) : lag
  }

  heard(paths: number): void {
    this.events.add(paths)
  }

  /** One watch was told events were dropped; logged at most once a minute, with how many since. */
  dropped(root: string, reason: DropReason | undefined): void {
    this.drops.add()
    const key = reason ?? "unsaid"
    if (!this.dropReasons.has(key)) this.dropReasons.set(key, new HourCounts())
    this.dropReasons.get(key)!.add()
    const now = Date.now()
    if (now - this.loggedDrops < MINUTE_MS) return
    this.loggedDrops = now
    this.log("file events dropped", { root, reason: key, lastHour: this.drops.lastHour(now) })
  }

  /** A read of history took `ms` from asking to answer, of which the child spent `caughtUpMs` waiting for the history to catch up and `readMs` replaying it. */
  historyRead(ms: number, paths: number, split: { caughtUpMs?: number; readMs?: number }): void {
    this.reads.add()
    this.readPaths.add(paths)
    const now = Date.now()
    if (!this.slowestRead || this.slowestRead.at < now - HOUR_MS || ms >= this.slowestRead.ms) this.slowestRead = { ms, at: now }
    if (ms < SLOW_READ_MS) return
    const caughtUpMs = Math.round(split.caughtUpMs ?? 0)
    const readMs = Math.round(split.readMs ?? 0)
    this.log("slow history read", { ms: Math.round(ms), queuedMs: Math.max(0, Math.round(ms) - caughtUpMs - readMs), caughtUpMs, readMs, paths })
  }

  /** FSEvents streams the watcher child holds: one per distinct folder and ignore list, as parcel shares them, and the canary's. */
  streams(): number {
    const distinct = new Set([...this.watches.values()].map((watch) => `${watch.root}\u0000${watch.ignore}`)).size
    return distinct ? distinct + 1 : 0
  }

  reading(): WatchFootprint {
    const now = Date.now()
    const roots = new Map<string, number>()
    for (const watch of this.watches.values()) roots.set(watch.root, (roots.get(watch.root) ?? 0) + 1)
    return {
      roots: [...roots].map(([root, watches]) => ({ root, watches })).sort((a, b) => a.root.localeCompare(b.root)),
      streams: this.streams(),
      ...(this.child && { child: { ...this.child } }),
      ...(this.historyChild && { historyChild: { ...this.historyChild } }),
      starts: { ...this.starts },
      delivery: { ...this.delivery },
      eventsLastHour: this.events.lastHour(now),
      droppedLastHour: this.drops.lastHour(now),
      droppedBy: Object.fromEntries([...this.dropReasons].map(([reason, counts]) => [reason, counts.lastHour(now)]).filter(([, count]) => count)),
      history: { readsLastHour: this.reads.lastHour(now), pathsLastHour: this.readPaths.lastHour(now), ...(this.slowestRead && this.slowestRead.at >= now - HOUR_MS && { slowestMs: Math.round(this.slowestRead.ms) }) },
    }
  }
}

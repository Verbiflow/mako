import assert from "node:assert/strict"
import { observeVisibleRead } from "../src/lib/visible-read"
import { ViewRefetch, type RefetchClock } from "../src/lib/view-refetch"
import { RowIntersection as Observer } from "./lib/row-intersection"

Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: Observer })
// SAFETY: the controlled observer uses this object only as an identity, never as a DOM implementation.
const row = {} as Element
let starts = 0, stops = 0
const start = () => { starts++; return () => { stops++ } }
const release = observeVisibleRead(row, start)
const first = Observer.instances.at(-1)!
assert.equal(starts, 0, "unknown intersection does not acquire detail demand")
first.emit(row, false)
assert.equal(starts, 0)
first.emit(row, true)
first.emit(row, true)
assert.equal(starts, 1, "repeated visible records do not duplicate a lease")
const duplicate = observeVisibleRead(row, start)
assert.equal(starts, 2, "another consumer shares the measured intersection")
first.emit(row, false)
assert.equal(stops, 2)
first.emit(row, true)
assert.equal(starts, 4)
release(); release(); duplicate()
assert.equal(stops, 4, "all acquired demand is released exactly once")
assert.equal(first.targets.size, 0)
const oldTime = performance.now() - 1
const replacement = observeVisibleRead(row, start)
const next = Observer.instances.at(-1)!
first.emit(row, true)
next.emit(row, true, oldTime)
assert.equal(starts, 4, "retired observers and queued records cannot start a new lifetime")
next.emit(row, true)
assert.equal(starts, 5)
replacement()

// Releasing the ref synchronously while its reader starts cannot leak the new lease.
let retire = () => {}
retire = observeVisibleRead(row, () => { retire(); return start() })
Observer.instances.at(-1)!.emit(row, true)
assert.equal(starts, 6)
assert.equal(stops, 6)

class Clock implements RefetchClock {
  time = 0
  timers = new Set<{ at: number; run: () => void }>()
  now = () => this.time
  after = (run: () => void, ms: number) => {
    const task = { at: this.time + ms, run }; this.timers.add(task)
    return () => { this.timers.delete(task) }
  }
  async tick(ms: number) {
    const end = this.time + ms
    for (;;) {
      await flush()
      const task = [...this.timers].sort((a, b) => a.at - b.at)[0]
      if (!task || task.at > end) break
      this.time = task.at; this.timers.delete(task); task.run()
    }
    this.time = end; await flush()
  }
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve() }

// The scheduler's real invalidation path: only details are gated, the compact list stays live.
async function sample(gated: boolean) {
  const clock = new Clock(), reads = new ViewRefetch(clock)
  const calls = { detail: 0, list: 0 }
  let applied = 0, pending: (() => void) | undefined
  const watch = () => {
    const lease = reads.watch("detail", { scope: "host", domain: "apps", key: "/work/app", fields: ["state"], every: () => 2_000,
      read: async (current) => { calls.detail++; if (pending) await new Promise<void>((resolve) => { pending = resolve }); if (current()) applied++ },
    })
    return () => lease.release()
  }
  const list = reads.watch("list", { scope: "host", domain: "apps", fields: ["state"], every: () => undefined, read: async () => { calls.list++ } })
  const unwatch = gated ? observeVisibleRead(row, watch) : watch()
  const observer = Observer.instances.at(-1)!
  if (gated) observer.emit(row, true)
  await clock.tick(10_000)
  if (gated) observer.emit(row, false)
  const before = calls.detail
  for (let i = 0; i < 20; i++) { reads.invalidate("host", "apps", ["/work/app"], ["future-field"]); await clock.tick(2_000) }
  if (gated) assert.equal(calls.detail, before, "offscreen hints and fallback timers make no detail reads")
  assert.equal(calls.list, 21, "offscreen changes still update the compact list")
  if (gated) observer.emit(row, true)
  await clock.tick(0)
  if (gated) assert.equal(calls.detail, before + 1, "entering reads the latest state once")
  reads.setVisible(false)
  const hidden = calls.detail
  await clock.tick(10_000)
  assert.equal(calls.detail, hidden)
  reads.setVisible(true); await clock.tick(0)
  if (gated) {
    pending = () => {}
    await clock.tick(2_000)
    const settled = applied
    observer.emit(row, false)
    pending!(); pending = undefined; await flush()
    assert.equal(applied, settled, "an offscreen answer cannot update detail state")
  }
  unwatch(); list.release(); reads.dispose()
  assert.equal(clock.timers.size, 0)
  return { calls, counters: reads.readings() }
}
const mounted = await sample(false), gated = await sample(true)
assert.ok(gated.calls.detail < mounted.calls.detail)
assert.equal(gated.counters.skippedRows, 20)
Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: undefined })
const fallback = observeVisibleRead(row, start)
fallback(); fallback()
assert.equal(starts, stops, "unsupported renderers keep mounted reads with idempotent release")
console.log(JSON.stringify({ mounted, gated }))
console.log("visible detail reads: unknown, offscreen, return, stale answer, shared row, ref replacement, teardown and old-renderer fallback pass")

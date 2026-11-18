import { subscribe } from "node:diagnostics_channel"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { monitorEventLoopDelay, performance, PerformanceObserver } from "node:perf_hooks"
import { isMainThread, threadId } from "node:worker_threads"

/*
 * What the host's own threads did, kept from inside the host `bench:host-load --record` starts (`--import`): the
 * prober outside times answers, and a held loop shorter than the watch's 100 ms is in neither its log nor `/health`.
 *
 * On the main thread a timer every `TICK_MS` keeps how late each tick ran (the loop's delay, for percentiles over any
 * stretch of the run) and every gap of `HOLD_MS` or more between two ticks with the named work open in it
 * (`mako:host-work`), which the bench pairs with the samples of the run's CPU profile to name the function. Each
 * second it keeps how busy the loop was, the process's memory and CPU; each collection, its pause. A worker thread
 * keeps only its loop's delay and how busy it was. All of it is written as the process exits: a write while it runs
 * would hold the loop it measures. Without `MAKO_HOST_LOAD_RECORD` it does nothing.
 */

const TICK_MS = 5
const HOLD_MS = 20
/** The mark's function runs this long once, at a known time, so the profile's clock can be set against this one's. */
const MARK_MS = 30
const NAMED_PER_HOLD = 5
const RECENT_SPANS = 256

const folder = process.env.MAKO_HOST_LOAD_RECORD
if (folder) (isMainThread ? recordMain : recordWorker)(folder)

/** Spins for `ms`: the one function of this name in the profile, whose first sample is when it began. */
function hostLoadClockMark(ms) {
  const until = performance.now() + ms
  let turns = 0
  while (performance.now() < until) turns += 1
  return turns
}

function recordMain(into) {
  mkdirSync(into, { recursive: true })
  const origin = performance.timeOrigin
  const megabytes = (bytes) => Math.round(bytes / 104_857.6) / 10
  const mark = { at: origin + performance.now(), name: hostLoadClockMark.name }
  hostLoadClockMark(MARK_MS)

  // The named work open now and what ended lately, as the host's own watch keeps them.
  const open = new Map()
  const recent = []
  subscribe("mako:host-work", (message) => {
    const now = performance.now()
    if (message.open) return void open.set(message.id, { label: message.label, since: now })
    const span = open.get(message.id)
    if (!span) return
    open.delete(message.id)
    recent.push({ ...span, ended: now })
    if (recent.length > RECENT_SPANS) recent.shift()
  })
  const during = (from, to) => {
    const longest = new Map()
    for (const span of [...open.values(), ...recent.filter((each) => each.ended >= from)]) {
      const ms = (span.ended ?? to) - span.since
      longest.set(span.label, Math.max(ms, longest.get(span.label) ?? 0))
    }
    return [...longest].sort((a, b) => b[1] - a[1]).slice(0, NAMED_PER_HOLD).map(([label, ms]) => `${label} (${Math.round(ms)} ms)`)
  }

  const ticks = { at: [], late: [] }
  const holds = []
  let last = performance.now()
  const tick = () => {
    const now = performance.now()
    const gap = now - last
    ticks.at.push(Math.round(origin + now))
    ticks.late.push(Math.round(Math.max(0, gap - TICK_MS) * 10) / 10)
    if (gap >= HOLD_MS) holds.push({ from: origin + last, to: origin + now, during: during(last, now) })
    last = now
    setTimeout(tick, TICK_MS).unref()
  }
  setTimeout(tick, TICK_MS).unref()

  const samples = []
  let busy = performance.eventLoopUtilization()
  let cpu = process.cpuUsage()
  setInterval(() => {
    const now = performance.eventLoopUtilization()
    const spent = performance.eventLoopUtilization(now, busy)
    const used = process.cpuUsage(cpu)
    busy = now
    cpu = process.cpuUsage()
    const memory = process.memoryUsage()
    samples.push({
      at: Math.round(origin + performance.now()), activeMs: Math.round(spent.active), idleMs: Math.round(spent.idle),
      rssMb: megabytes(memory.rss), heapUsedMb: megabytes(memory.heapUsed), heapTotalMb: megabytes(memory.heapTotal),
      externalMb: megabytes(memory.external), cpuMs: Math.round((used.user + used.system) / 1000),
    })
  }, 1_000).unref()

  // Each collection: when it began, its pause, and its kind (1 a scavenge, 4 a mark-compact, 8 incremental marking, 16 weak callbacks).
  const collections = []
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) collections.push([Math.round((origin + entry.startTime) * 10) / 10, Math.round(entry.duration * 100) / 100, entry.detail?.kind ?? 0])
  }).observe({ entryTypes: ["gc"] })

  process.on("exit", () => {
    try {
      writeFileSync(join(into, `main-${process.pid}.json`), JSON.stringify({ pid: process.pid, tickMs: TICK_MS, holdMs: HOLD_MS, mark, ticks, holds, samples, collections }))
    } catch { /* A recording that can't be written is a run without one; the host's exit is its own. */ }
  })
}

function recordWorker(into) {
  const delay = monitorEventLoopDelay({ resolution: 10 })
  delay.enable()
  const since = Date.now()
  const ms = (nanoseconds) => Math.round(nanoseconds / 1e5) / 10
  // A worker is ended by its owner without an exit of its own to write on, so what it measured is written as it goes.
  const write = () => {
    const busy = performance.eventLoopUtilization()
    try {
      writeFileSync(join(into, `thread-${process.pid}-${threadId}.json`), JSON.stringify({
        pid: process.pid, threadId, since, at: Date.now(), activeMs: Math.round(busy.active), idleMs: Math.round(busy.idle),
        delayMs: { p50: ms(delay.percentile(50)), p99: ms(delay.percentile(99)), max: ms(delay.max) },
      }))
    } catch { /* The folder went with the run. */ }
  }
  setInterval(write, 5_000).unref()
  process.on("exit", write)
}

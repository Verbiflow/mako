import { createHook, executionAsyncId } from "node:async_hooks"
import { performance, PerformanceObserver } from "node:perf_hooks"
import { readFileSync } from "node:fs"
import { DatabaseSync, StatementSync } from "node:sqlite"

const windows = [],
  gc = [],
  resources = new Map()
let active,
  sequence = 0,
  dropped = 0,
  gcDropped = 0,
  resourceDropped = 0
const cpu = () => {
  const c = process.threadCpuUsage()
  return (c.user + c.system) / 1000
}
// Read-only evidence, not a duration subtracted from any assertion. Unavailable/disabled counters are not zero evidence.
const scheduler = () => {
  if (process.platform !== "linux") return { available: false, reason: "not-linux" }
  try {
    const values = readFileSync("/proc/thread-self/schedstat", "utf8").trim().split(/\s+/).map(Number)
    if (values.length !== 3 || values.some((v) => !Number.isSafeInteger(v) || v < 0)) return { available: false, reason: "invalid" }
    let runqueueCollection = null
    try {
      runqueueCollection = readFileSync("/proc/sys/kernel/sched_schedstats", "utf8").trim() === "1"
    } catch {
      runqueueCollection = "unreadable"
    }
    return { available: true, runqueueCollection, runtimeNs: values[0], runqueueNs: values[1], slices: values[2] }
  } catch {
    return { available: false, reason: "unreadable" }
  }
}
const stamp = () => ({ at: performance.now(), cpu: cpu() })
const emit = (type, data = {}) => {
  if (!active) return
  if (active.events.length >= 8192) {
    dropped++
    return
  }
  active.events.push({ type, ...stamp(), asyncId: executionAsyncId(), ...data })
}
const append = (window, event) => {
  if (window.events.length < 8192) window.events.push(event)
  else dropped++
}
function start(label) {
  if (active) throw Error("nested diagnostic window")
  active = {
    label,
    schedulerStart: scheduler(),
    start: stamp(),
    eluStart: performance.eventLoopUtilization(),
    resourceStart: process.resourceUsage(),
    events: [],
  }
  windows.push(active)
  emit("window.start")
}
function finish(result) {
  emit("window.end")
  active.end = stamp()
  active.elu = performance.eventLoopUtilization(active.eluStart)
  active.resourceEnd = process.resourceUsage()
  active.schedulerEnd = scheduler()
  active.cleanupCount = result.incomplete ? 0 : 1
  active.result = result
  active = undefined
}
function span(label, call, extra = {}) {
  if (!active) return call()
  const window = active,
    before = stamp(),
    token = ++sequence
  emit("span.begin", { label, token, ...extra })
  try {
    return call()
  } finally {
    const after = stamp()
    append(window, {
      type: "span.end",
      ...after,
      asyncId: executionAsyncId(),
      label,
      token,
      ...extra,
      wallMs: after.at - before.at,
      cpuMs: after.cpu - before.cpu,
    })
  }
}
function wrap(proto, name, label = name, asynchronous = false) {
  const original = proto[name]
  proto[name] = function (...args) {
    if (!active) return original.apply(this, args)
    if (!asynchronous) return span(label, () => original.apply(this, args))
    const window = active,
      before = stamp(),
      token = ++sequence
    emit("phase.begin", { label, token })
    const result = original.apply(this, args)
    return result.then(
      (value) => {
        append(window, { type: "phase.end", ...stamp(), label, token, wallMs: performance.now() - before.at })
        return value
      },
      (error) => {
        append(window, { type: "phase.error", ...stamp(), label, token, error: String(error) })
        throw error
      },
    )
  }
}
const observer = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    gc.push({ at: e.startTime, duration: e.duration, detail: e.detail })
    if (gc.length > 512) {
      gc.shift()
      gcDropped++
    }
  }
})
observer.observe({ entryTypes: ["gc"] })
const hook = createHook({
  init(id, type, trigger) {
    if (active) {
      if (resources.size >= 8192) {
        resourceDropped++
        return
      }
      resources.set(id, { type, trigger })
      if (type !== "PROMISE") emit("task.scheduled", { id, resource: type, trigger })
    }
  },
  before(id) {
    const r = resources.get(id)
    if (r && active) {
      r.started = stamp()
      if (r.type !== "PROMISE") emit("task.before", { id, resource: r.type, trigger: r.trigger, elu: performance.eventLoopUtilization() })
    }
  },
  after(id) {
    const r = resources.get(id)
    if (r && active) {
      const end = stamp()
      if (r.started && end.at - r.started.at >= 2)
        emit("task.span", {
          id,
          resource: r.type,
          trigger: r.trigger,
          fromAt: r.started.at,
          wallMs: end.at - r.started.at,
          cpuMs: end.cpu - r.started.cpu,
        })
      if (r.type !== "PROMISE") emit("task.after", { id, resource: r.type, trigger: r.trigger, elu: performance.eventLoopUtilization() })
    }
  },
  destroy(id) {
    resources.delete(id)
  },
}).enable()
const originalTimeout = globalThis.setTimeout,
  originalImmediate = globalThis.setImmediate,
  originalClearTimeout = globalThis.clearTimeout
let samplerCallback, samplerTimer, marker
const observeSampler = (kind) => {
  if (!active) return
  const now = stamp()
  if (kind === "tick") active.tickCount = (active.tickCount ?? 0) + 1
  const gap = { ms: now.at - marker.at, cpuMs: now.cpu - marker.cpu, fromMs: marker.at - active.start.at, toMs: now.at - active.start.at }
  if (!active.markerGap || gap.ms > active.markerGap.ms) active.markerGap = gap
  marker = now
  emit("sampler." + kind, {
    at: now.at,
    cpu: now.cpu,
    elu: performance.eventLoopUtilization(),
    resourceUsage: process.resourceUsage(),
    scheduler: scheduler(),
  })
}
globalThis.clearTimeout = function (timer) {
  if (active && timer === samplerTimer) {
    observeSampler("cleanup")
    finish({ ...active.markerGap, anchor: "Diagnostic timer/cleanup markers, not the normative collector result" })
    samplerCallback = undefined
    samplerTimer = undefined
  }
  return originalClearTimeout(timer)
}
for (const [name, original] of [
  ["setTimeout", originalTimeout],
  ["setImmediate", originalImmediate],
]) {
  globalThis[name] = function (callback, ...args) {
    const sampler =
      name === "setTimeout" &&
      args[0] === 1 &&
      callback.name === "tick" &&
      (callback === samplerCallback || new Error().stack.replaceAll("\\", "/").includes("/scripts/lib/loop-hold.ts:"))
    if (sampler && callback !== samplerCallback) {
      if (windows.length >= 4) {
        dropped++
        return original(callback, ...args)
      }
      start("collector." + (windows.length + 1))
      samplerCallback = callback
      marker = stamp()
    }
    if (!active) return original(callback, ...args)
    const label = callback.name || "anonymous",
      registration = ++sequence
    const stack =
      label === "tick"
        ? "longestHold.tick"
        : new Error().stack
            .split("\n")
            .slice(2, 5)
            .map((s) => s.trim())
            .join(" | ")
    emit("callback.scheduled", { name, label, registration, delay: name === "setTimeout" ? args[0] : undefined, stack })
    const timer = original(
      function (...values) {
        emit("callback.begin", { name, label, registration })
        if (sampler) observeSampler("tick")
        try {
          return callback.apply(this, values)
        } finally {
          emit("callback.end", { name, label, registration })
        }
      },
      ...args,
    )
    if (sampler) samplerTimer = timer
    return timer
  }
}
const sql = new WeakMap(),
  prepare = DatabaseSync.prototype.prepare
DatabaseSync.prototype.prepare = function (query, ...args) {
  const stmt = prepare.call(this, query, ...args)
  sql.set(stmt, String(query).slice(0, 120))
  return stmt
}
for (const [proto, name, label] of [
  [DatabaseSync.prototype, "exec", "sqlite.exec"],
  [StatementSync.prototype, "all", "sqlite.all"],
  [StatementSync.prototype, "get", "sqlite.get"],
  [StatementSync.prototype, "run", "sqlite.run"],
]) {
  const original = proto[name]
  proto[name] = function (...args) {
    if (!active) return original.apply(this, args)
    const window = active,
      before = stamp(),
      asyncId = executionAsyncId(),
      query = name === "exec" ? String(args[0]).slice(0, 120) : sql.get(this)
    try {
      return original.apply(this, args)
    } finally {
      const end = stamp()
      if (end.at - before.at >= 0.25)
        append(window, {
          type: "native.span",
          label,
          query,
          at: before.at,
          endAt: end.at,
          wallMs: end.at - before.at,
          cpuMs: end.cpu - before.cpu,
          asyncId,
        })
    }
  }
}
export async function installHostProbes(root) {
  const imports = await Promise.all([
    import(root + "/scripts/lib/agents-world.ts"),
    import(root + "/packages/host/src/conversations/live-conversations.ts"),
    import(root + "/packages/host/src/conversations/agents.ts"),
    import(root + "/packages/host/src/conversations/live-records.ts"),
    import(root + "/packages/host/src/conversations/live-journal.ts"),
    import(root + "/packages/host/src/base/host-jobs.ts"),
    import(root + "/packages/host/src/conversations/live-auto-continue.ts"),
  ])
  const [{ AgentsWorld }, { LiveConversations }, { Agents }, { LiveRecords }, { LiveJournal }, { HostJobs }, { LiveAutoContinue }] = imports
  const open = AgentsWorld.prototype.open
  AgentsWorld.prototype.open = function () {
    if (active) active.phase = this.options.resumeInSlices ? "sliced" : "atOnce"
    return span("world.open", () => open.call(this))
  }
  for (const n of ["continueRestartedInSlices", "readIn"]) wrap(LiveConversations.prototype, n, "live." + n, true)
  for (const n of ["continueRestarted", "armWakes"]) wrap(LiveConversations.prototype, n, "live." + n)
  wrap(Agents.prototype, "resumeInSlices", "agents.resumeInSlices", true)
  wrap(Agents.prototype, "resume", "agents.resume")
  for (const n of ["loadSliced", "loadInSlices"]) wrap(LiveRecords.prototype, n, "records." + n, true)
  for (const n of ["openJournal", "readIn"]) wrap(LiveRecords.prototype, n, "records." + n)
  wrap(LiveJournal.prototype, "commit", "journal.commit")
  wrap(LiveAutoContinue.prototype, "fire", "autoContinue.fire")
  const run = HostJobs.prototype.run
  HostJobs.prototype.run = function (job) {
    return span("job." + job.state.name, () => run.call(this, job))
  }
  const reading = LiveJournal.prototype.reading
  LiveJournal.prototype.reading = function (...args) {
    const iterator = reading.apply(this, args),
      id = ++sequence
    let step = 0
    for (const name of ["next", "throw", "return"]) {
      const original = iterator[name]
      iterator[name] = (...values) => span("journal.step." + name, () => original.apply(iterator, values), { reader: id, step: ++step })
    }
    return iterator
  }
}
export function selectGcEvents(entries, from, to) {
  const overlaps = (entry) => entry.at + entry.duration >= from && entry.at <= to
  const overlapping = entries.filter(overlaps)
  return {
    events: [...overlapping, ...entries.filter((entry) => !overlaps(entry))].slice(0, 64),
    overlapCount: overlapping.length,
    truncated: entries.length > 64,
  }
}

/** Diagnostic output only: it never gates, retries, filters or adjusts the existing wall-clock assertion. */
export function report() {
  if (active) finish({ incomplete: true })
  for (const w of windows) {
    const from = w.start.at + (w.result.fromMs ?? 0),
      to = w.start.at + (w.result.toMs ?? w.end.at - w.start.at)
    const overlapsGap = (e) => {
      const eventFrom = e.fromAt ?? (e.endAt !== undefined ? e.at : e.wallMs !== undefined ? e.at - e.wallMs : e.at)
      const eventTo = e.endAt ?? e.at
      return eventTo >= from && eventFrom <= to
    }
    const events = w.events.filter(overlapsGap)
    const windowGc = gc.filter((e) => e.at + e.duration >= w.start.at && e.at <= w.end.at)
    const selectedGc = selectGcEvents(windowGc, from, to)
    const spanSummary = (type) => {
      const retained = w.events.filter((event) => event.type === type)
      const overlapping = retained.filter(overlapsGap).length
      return {
        retained: retained.length,
        overlapping,
        outputTruncated: retained.length > 8,
        spans: retained
          .sort((a, b) => Number(overlapsGap(b)) - Number(overlapsGap(a)) || b.wallMs - a.wallMs)
          .slice(0, 8)
          .map((event) => ({ ...event, overlapsMarkerGap: overlapsGap(event) })),
      }
    }
    console.log(
      "resume diagnostic: " +
        JSON.stringify({
          evidenceOnly: true,
          label: w.label,
          phase: w.phase ?? "not-observed",
          cleanupCount: w.cleanupCount,
          samplerTickCount: w.tickCount ?? 0,
          coordinates:
            "Absolute performance-clock timestamps; markerGap offsets use diagnostic start.at, not the original collector origin.",
          scopes: {
            cpu: "threadCpuUsage: executing main thread",
            scheduler: "thread-self schedstat: executing thread; collection must be enabled",
            resourceUsage: "process-wide, including context-switch counts",
            syncSpans: "inclusive wall spans; runtime/native/scheduling may overlap",
            asyncPhases: "include awaited time; not task holds",
            gc: "observed start/duration; one observer drain opportunity does not prove complete delivery",
          },
          limitations:
            "Probes alter task timing; marker gaps are not normative collector results. Missing/truncated GC or disabled/unreadable scheduler counters cannot exclude a cause.",
          runtime: { node: process.version, uv: process.versions.uv },
          markerGap: w.result,
          start: w.start,
          end: w.end,
          schedulerStart: w.schedulerStart,
          schedulerEnd: w.schedulerEnd,
          elu: w.elu,
          processResourceStart: w.resourceStart,
          processResourceEnd: w.resourceEnd,
          gc: selectedGc.events,
          gcOverlapCount: selectedGc.overlapCount,
          intervalEvents: events.slice(0, 96),
          intervalEventCount: events.length,
          intervalOutputTruncated: events.length > 96,
          longestSyncSpans: spanSummary("span.end"),
          longestAsyncPhases: spanSummary("phase.end"),
          longestNative: spanSummary("native.span"),
          longestTasks: spanSummary("task.span"),
          traceDropped: dropped,
          resourceDropped,
          gcDropped,
          gcOutputTruncated: selectedGc.truncated,
        }),
    )
  }
  const incomplete = windows.filter((w) => w.cleanupCount !== 1).length
  console.log(
    "resume diagnostic status: " +
      JSON.stringify({
        evidenceOnly: true,
        windows: windows.length,
        cleanupCounts: windows.map((w) => w.cleanupCount),
        windowLimit: 4,
        eventLimitPerWindow: 8192,
        resourceLimit: 8192,
        gcRetentionLimit: 512,
        detection: !windows.length ? "missing" : incomplete ? "incomplete" : "detected",
        traceDropped: dropped,
        resourceDropped,
        gcDropped,
      }),
  )
  if (!windows.length || incomplete) process.exitCode = 1
  observer.disconnect()
  hook.disable()
  resources.clear()
}

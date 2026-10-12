// Loaded into a measured host's main process through NODE_OPTIONS by
// scripts/measure-host.mjs. Every second it appends CPU time and memory to
// MAKO_MEASURE_SAMPLES, and the event loop's delay while the file named by
// MAKO_MEASURE_LOOP exists: measure-host creates it for the phases that
// measure the loop. Sampling the loop takes a timer every millisecond, about
// 2% of a core, which would be most of what an idle host costs.
const { appendFileSync, existsSync } = require("node:fs")
const { monitorEventLoopDelay } = require("node:perf_hooks")
const { isMainThread } = require("node:worker_threads")

const samples = process.env.MAKO_MEASURE_SAMPLES
const loopSwitch = process.env.MAKO_MEASURE_LOOP
const socket = process.env.MAKO_WEB_SOCKET
const options = (process.env.NODE_OPTIONS ?? "").replace(`--require ${__filename}`, "").trim()
if (options) process.env.NODE_OPTIONS = options
else delete process.env.NODE_OPTIONS
delete process.env.MAKO_MEASURE_LOOP

// Node runs --require preloads in worker threads too; only the main thread's loop is measured.
// The host is the entry under Node or Electron's Helper in Node mode, with its socket to serve.
const host = /dist-electron[\\/]entry\.js$/.test(process.argv[1] ?? "")
if (samples && loopSwitch && isMainThread && socket && host) {
  const delay = monitorEventLoopDelay({ resolution: 1 })
  let sampling = false
  let cpu = process.cpuUsage()
  let at = performance.now()
  const ms = (ns) => Math.round(ns / 1e4) / 100
  setInterval(() => {
    const now = performance.now()
    const used = process.cpuUsage(cpu)
    const memory = process.memoryUsage()
    appendFileSync(samples, JSON.stringify({
      at: Date.now(),
      pid: process.pid,
      ...(sampling && { loop: { p50: ms(delay.percentile(50)), p99: ms(delay.percentile(99)), max: ms(delay.max), mean: ms(delay.mean) } }),
      cpuPercent: Math.round(((used.user + used.system) / 1000 / (now - at)) * 1000) / 10,
      rssMb: Math.round(memory.rss / 1048576),
      heapMb: Math.round(memory.heapUsed / 1048576),
    }) + "\n")
    delay.reset()
    const wanted = existsSync(loopSwitch)
    if (wanted && !sampling) delay.enable()
    else if (!wanted && sampling) delay.disable()
    sampling = wanted
    cpu = process.cpuUsage()
    at = now
  }, 1000).unref()
}

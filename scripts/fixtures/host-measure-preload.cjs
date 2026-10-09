// Loaded into a measured host's main process through NODE_OPTIONS by
// scripts/measure-host.mjs. Every second it appends the event loop's delay,
// CPU time and memory to MAKO_MEASURE_SAMPLES. With MAKO_MEASURE_STREAM_AGENT
// set it points the Grok harness at that ACP agent, in this throwaway host
// only, once the host is listening, so module start-up order is untouched.
const { appendFileSync, existsSync } = require("node:fs")
const { join } = require("node:path")
const { pathToFileURL } = require("node:url")
const { monitorEventLoopDelay } = require("node:perf_hooks")
const { isMainThread } = require("node:worker_threads")

const samples = process.env.MAKO_MEASURE_SAMPLES
const agent = process.env.MAKO_MEASURE_STREAM_AGENT
const repo = process.env.MAKO_MEASURE_REPO
const socket = process.env.MAKO_WEB_SOCKET
const options = (process.env.NODE_OPTIONS ?? "").replace(`--require ${__filename}`, "").trim()
if (options) process.env.NODE_OPTIONS = options
else delete process.env.NODE_OPTIONS

// Node runs --require preloads in worker threads too; only the main thread's loop is measured.
// The host is Electron's main process, or its entry under Node or Electron's Helper in Node mode.
const host = process.type === "browser" || /dist-electron[\\/]entry\.js$/.test(process.argv[1] ?? "")
if (samples && isMainThread && process.env.MAKO_HOST_ONLY === "1" && host) {
  const delay = monitorEventLoopDelay({ resolution: 1 })
  delay.enable()
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
      loop: { p50: ms(delay.percentile(50)), p99: ms(delay.percentile(99)), max: ms(delay.max), mean: ms(delay.mean) },
      cpuPercent: Math.round(((used.user + used.system) / 1000 / (now - at)) * 1000) / 10,
      rssMb: Math.round(memory.rss / 1048576),
      heapMb: Math.round(memory.heapUsed / 1048576),
    }) + "\n")
    delay.reset()
    cpu = process.cpuUsage()
    at = now
  }, 1000).unref()

  if (agent && repo && socket) {
    const patch = setInterval(() => {
      if (!existsSync(socket)) return
      clearInterval(patch)
      import(pathToFileURL(join(repo, "dist-electron/providers/index.js")).href).then(({ providerHost }) => {
        const grok = providerHost.acpSources.get("grok")
        if (!grok) throw new Error("The host registered no Grok ACP source")
        grok.available = () => true
        grok.launch = async () => ({
          command: process.execPath,
          args: [agent],
          configureEnvironment(env) {
            env.ELECTRON_RUN_AS_NODE = "1"
            for (const key of ["MEASURE_STREAM_MS", "MEASURE_CHUNK_MS"])
              if (process.env[key]) env[key] = process.env[key]
          },
        })
        appendFileSync(samples, JSON.stringify({ at: Date.now(), streamAgent: "installed" }) + "\n")
      }).catch((error) => {
        appendFileSync(samples, JSON.stringify({ at: Date.now(), streamAgent: "failed", reason: String(error?.message ?? error) }) + "\n")
      })
    }, 100)
    patch.unref()
  }
}

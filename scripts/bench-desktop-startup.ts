import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import WebSocket from "ws"
import { z } from "zod"
import { PackagedApp } from "./lib/packaged-app.mjs"

/*
 * How long a packaged desktop takes to show something and to be usable, and
 * what it costs once it sits idle, for Mako and for another Electron app.
 *
 *   npx tsx scripts/bench-desktop-startup.ts --app mako --executable <Mako.app>/Contents/MacOS/Mako --root <scratch> --port <free-thread-port>
 *   npx tsx scripts/bench-desktop-startup.ts --app capy --executable <probe>/Contents/MacOS/Capy --root <scratch> --port <free-thread-port> --userdata-env CAPY_PERF_USERDATA
 *
 * Every run is on a profile and home of its own under `--root`; nothing reads
 * or writes the person's. Mako runs through `PackagedApp` (its own data root,
 * a mock keychain). Another app needs its profile redirected by the caller
 * (`--userdata-env NAME` sets NAME to `<root>/profile`).
 *
 * Mako's runs: a cold start (no host yet, empty profile), a desktop restart
 * against the host it left running, and a restart of both. Another app's: a
 * first launch on an empty profile, then `--runs - 1` launches on the same one.
 *
 * Each run reads, from the window's own Performance timeline: navigation start
 * (`performance.timeOrigin`) after the spawn, first contentful and largest
 * contentful paint, DOMContentLoaded, long animation frames before the app was
 * usable, and the scripts it loaded. "Usable" is `--ready <expression>` turning
 * true (Mako: the composer exists). Then the process tree (and Mako's host's)
 * settles `--settle` seconds, and its CPU over the next `--idle` seconds and its
 * resident memory are read from `ps`. The readiness expression measures DOM
 * availability, not a completed paint or successful interaction. `windowMs`
 * is when the debugger first reports a page target, not a visible window.
 */

const argv = process.argv.slice(2)
const option = (name: string, fallback?: string) => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1]! : fallback
}
const appName = option("--app", "mako")!
const executable = resolve(option("--executable")!)
const root = resolve(option("--root")!)
const runs = Number(option("--runs", "3"))
const settleS = Number(option("--settle", "10"))
const idleS = Number(option("--idle", "30"))
const port = Number(option("--port"))
const userdataEnv = option("--userdata-env")
const ready = option("--ready", appName === "mako" ? "Boolean(window.mako && document.querySelector('.composer-input'))" : "document.body.innerText.trim().length > 0")!
const out = option("--json")
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Pass --port within this Thread's allocation")
if (appName !== "mako" && !userdataEnv) throw new Error("Another app needs --userdata-env and a probe build that honors it")
if (listening(port)) throw new Error(`Port ${port} is already held; existing processes were left running`)

function save(readings: Reading[], reading: Reading): void {
  readings.push(reading)
  if (out) writeFileSync(out, JSON.stringify(readings, null, 2))
  console.log(`${reading.run}: ${reading.readyMs} ms ready, ${reading.footprintMB} MB footprint, ${reading.idleCpuPercent}% idle CPU`)
}

interface Proc { pid: number; ppid: number; rss: number; cpu: number; comm: string }

function processes(): Proc[] {
  return execFileSync("ps", ["-axo", "pid=,ppid=,rss=,time=,comm="], { encoding: "utf8" }).trim().split("\n").map((line) => {
    const [pid, ppid, rss, time, ...comm] = line.trim().split(/\s+/)
    const cpu = time!.split(":").reduce((total, part) => total * 60 + Number(part), 0)
    return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss) * 1024, cpu, comm: comm.join(" ") }
  })
}

/** Every process under `roots`, the roots included. */
function tree(roots: number[]): Proc[] {
  const all = processes()
  const found = new Map<number, Proc>()
  const queue = roots.filter(Boolean)
  while (queue.length) {
    const pid = queue.shift()!
    const proc = all.find((item) => item.pid === pid)
    if (!proc || found.has(pid)) continue
    found.set(pid, proc)
    for (const child of all) if (child.ppid === pid) queue.push(child.pid)
  }
  return [...found.values()]
}

const PAGE_READING = `(async () => {
  const observed = (type) => new Promise((done) => {
    const entries = []
    try {
      const observer = new PerformanceObserver((list) => entries.push(...list.getEntries()))
      observer.observe({ type, buffered: true })
      setTimeout(() => { observer.disconnect(); done(entries) }, 100)
    } catch { done(entries) }
  })
  const nav = performance.getEntriesByType("navigation")[0]
  const paints = Object.fromEntries(performance.getEntriesByType("paint").map((entry) => [entry.name, Math.round(entry.startTime)]))
  const lcp = (await observed("largest-contentful-paint")).at(-1)
  const frames = await observed("long-animation-frame")
  const scripts = performance.getEntriesByType("resource").filter((entry) => entry.initiatorType === "script" || /\\.m?js(\\?|$)/.test(entry.name))
  return {
    timeOrigin: performance.timeOrigin,
    domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    load: nav ? Math.round(nav.loadEventEnd) : null,
    fcp: paints["first-contentful-paint"] ?? null,
    lcp: lcp ? Math.round(lcp.startTime) : null,
    frames: frames.map((frame) => ({ start: Math.round(frame.startTime), duration: Math.round(frame.duration), blocking: Math.round(frame.blockingDuration ?? 0) })),
    scripts: { count: scripts.length, bytes: scripts.reduce((total, entry) => total + (entry.decodedBodySize || 0), 0), lastEnd: Math.round(Math.max(0, ...scripts.map((entry) => entry.responseEnd))) },
    visibility: document.visibilityState,
  }
})()`

const Metric = z.object({ name: z.string(), value: z.number() })
const DebugTarget = z.object({ type: z.string(), url: z.string(), webSocketDebuggerUrl: z.string().optional() })
const DebugReply = z.object({
  id: z.number().optional(),
  result: z.object({
    result: z.object({ value: z.unknown() }).optional(),
    metrics: z.array(Metric).optional(),
    exceptionDetails: z.unknown().optional(),
  }).optional(),
  error: z.object({ message: z.string() }).optional(),
})
type DebugReply = z.infer<typeof DebugReply>
interface Evaluation { expression: string; awaitPromise: true; returnByValue: true }
interface Page {
  evaluate<T>(expression: string, schema: z.ZodType<T>): Promise<T>
  send(method: "Performance.enable" | "Performance.getMetrics"): Promise<z.infer<typeof Metric>[]>
  close(): void
}

async function connect(debugPort: number, match: (url: string) => boolean, deadline: number): Promise<{ page: Page; seenAt: number }> {
  for (;;) {
    if (Date.now() > deadline) throw new Error("No page target")
    const list = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(async (response) => z.array(DebugTarget).parse(await response.json())).catch(() => [])
    const target = list.find((item) => item.type === "page" && match(item.url))
    if (target?.webSocketDebuggerUrl) {
      const seenAt = Date.now()
      const socket = new WebSocket(target.webSocketDebuggerUrl)
      await new Promise((done, fail) => { socket.once("open", done); socket.once("error", fail) })
      let id = 0
      const waiting = new Map<number, (message: DebugReply) => void>()
      socket.on("message", (data) => {
        const message = DebugReply.parse(JSON.parse(data.toString()))
        if (message.id === undefined) return
        waiting.get(message.id)?.(message)
        waiting.delete(message.id)
      })
      const command = (method: "Runtime.evaluate" | "Performance.enable" | "Performance.getMetrics", params?: Evaluation): Promise<DebugReply> => new Promise((done, fail) => {
        const n = ++id
        const timer = setTimeout(() => { waiting.delete(n); fail(new Error(`Timed out: ${method}`)) }, 30_000)
        waiting.set(n, (message) => {
          clearTimeout(timer)
          if (message.error) fail(new Error(message.error.message))
          else if (message.result?.exceptionDetails) fail(new Error(JSON.stringify(message.result.exceptionDetails)))
          else done(message)
        })
        socket.send(JSON.stringify({ id: n, method, params }))
      })
      const page: Page = {
        evaluate: async (expression, schema) => schema.parse((await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value),
        send: async (method) => (await command(method)).result?.metrics ?? [],
        close: () => socket.close(),
      }
      return { page, seenAt }
    }
    await delay(25)
  }
}

async function until(page: Page, expression: string, deadline: number): Promise<number> {
  for (;;) {
    if (Date.now() > deadline) throw new Error(`Never ready: ${expression}`)
    if (await page.evaluate(expression, z.boolean()).catch(() => false)) return Date.now()
    await delay(25)
  }
}

interface Reading {
  run: string
  windowMs: number
  navigationMs: number
  fcpMs: number | null
  lcpMs: number | null
  domContentLoadedMs: number | null
  readyMs: number
  longFramesBeforeReady: number
  blockingBeforeReadyMs: number
  /** Chromium counters at the measurement, enabled after attaching to the page. */
  renderer: { taskMs: number; scriptMs: number; layoutMs: number; styleMs: number; heapMB: number; nodes: number }
  processes: number
  footprintMB: number
  rssMB: number
  idleCpuPercent: number
  byKind: Record<string, { count: number; rssMB: number; footprintMB: number; idleCpuPercent: number }>
}

/** A process's physical footprint. The sum is not a deduplicated tree footprint. */
function footprint(pid: number): number {
  try {
    const text = execFileSync("footprint", ["-f", "bytes", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    return Number(/phys_footprint:\s*(\d+)/.exec(text)?.[1] ?? 0)
  } catch {
    return 0
  }
}

async function measure(run: string, spawnedAt: number, page: Page, seenAt: number, readyAt: number, roots: () => number[]): Promise<Reading> {
  await page.send("Performance.enable")
  const metrics = Object.fromEntries((await page.send("Performance.getMetrics")).map((metric) => [metric.name, metric.value]))
  const timeline = await page.evaluate(PAGE_READING, z.object({
    timeOrigin: z.number(), domContentLoaded: z.number().nullable(), fcp: z.number().nullable(), lcp: z.number().nullable(),
    frames: z.array(z.object({ start: z.number(), duration: z.number(), blocking: z.number() })),
    scripts: z.object({ count: z.number(), bytes: z.number(), lastEnd: z.number() }),
  }))
  console.log(`${run}: criterion met`)
  const origin = timeline.timeOrigin - spawnedAt
  const readyInPage = readyAt - timeline.timeOrigin
  const before = timeline.frames.filter((frame) => frame.start < readyInPage)
  await delay(settleS * 1000)
  const first = tree(roots())
  await delay(idleS * 1000)
  const second = tree(roots())
  const kind = (proc: Proc) => {
    const name = proc.comm.split("/").at(-1) ?? proc.comm
    return /Renderer/.test(name) ? "renderer" : /GPU/.test(proc.comm) || /gpu/.test(name) ? "gpu" : /Helper/.test(name) ? "helper" : name
  }
  const byKind: Reading["byKind"] = {}
  for (const proc of second) {
    const before = first.find((item) => item.pid === proc.pid)
    const entry = (byKind[kind(proc)] ??= { count: 0, rssMB: 0, footprintMB: 0, idleCpuPercent: 0 })
    entry.count += 1
    entry.rssMB += proc.rss / 2 ** 20
    entry.footprintMB += footprint(proc.pid) / 2 ** 20
    entry.idleCpuPercent += before ? ((proc.cpu - before.cpu) / idleS) * 100 : 0
  }
  for (const entry of Object.values(byKind)) {
    entry.rssMB = Math.round(entry.rssMB)
    entry.footprintMB = Math.round(entry.footprintMB)
    entry.idleCpuPercent = Math.round(entry.idleCpuPercent * 100) / 100
  }
  const cpu = second.reduce((total, proc) => total + (proc.cpu - (first.find((item) => item.pid === proc.pid)?.cpu ?? proc.cpu)), 0)
  return {
    run,
    windowMs: seenAt - spawnedAt,
    navigationMs: Math.round(origin),
    fcpMs: timeline.fcp === null ? null : Math.round(origin + timeline.fcp),
    lcpMs: timeline.lcp === null ? null : Math.round(origin + timeline.lcp),
    domContentLoadedMs: timeline.domContentLoaded === null ? null : Math.round(origin + timeline.domContentLoaded),
    readyMs: readyAt - spawnedAt,
    longFramesBeforeReady: before.length,
    blockingBeforeReadyMs: before.reduce((total, frame) => total + frame.blocking, 0),
    renderer: { taskMs: Math.round((metrics.TaskDuration ?? 0) * 1000), scriptMs: Math.round((metrics.ScriptDuration ?? 0) * 1000), layoutMs: Math.round((metrics.LayoutDuration ?? 0) * 1000), styleMs: Math.round((metrics.RecalcStyleDuration ?? 0) * 1000), heapMB: Math.round((metrics.JSHeapUsedSize ?? 0) / 2 ** 20), nodes: metrics.Nodes ?? 0 },
    processes: second.length,
    footprintMB: Object.values(byKind).reduce((total, entry) => total + entry.footprintMB, 0),
    rssMB: Math.round(second.reduce((total, proc) => total + proc.rss, 0) / 2 ** 20),
    idleCpuPercent: Math.round((cpu / idleS) * 10000) / 100,
    byKind,
  }
}

/** Whether anything listens on `at` on the loopback. */
function listening(at: number): boolean {
  try {
    execFileSync("lsof", ["-nP", `-iTCP:${at}`, "-sTCP:LISTEN"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

/** Ends a Mako desktop alone (its host is its own process group), and waits until its debugging port is free. */
async function closeDesktop(desktop: ChildProcess): Promise<void> {
  const exited = new Promise((done) => desktop.once("exit", done))
  if (desktop.exitCode === null && desktop.signalCode === null) {
    process.kill(-desktop.pid!, "SIGTERM")
    if ((await Promise.race([exited.then(() => true), delay(10_000).then(() => false)])) === false) {
      try { process.kill(-desktop.pid!, "SIGKILL") } catch { /* Gone. */ }
      await exited
    }
  }
  for (let waited = 0; listening(port) && waited < 15_000; waited += 100) await delay(100)
  if (listening(port)) throw new Error(`Debugging port ${port} is still held after closing the desktop`)
}

async function benchMako(): Promise<Reading[]> {
  const workspace = join(root, "workspace")
  mkdirSync(workspace, { recursive: true })
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })
  const env = {
    HOME: home, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, GROK_HOME: undefined,
    XDG_CONFIG_HOME: undefined, XDG_DATA_HOME: undefined, XDG_STATE_HOME: undefined, XDG_CACHE_HOME: undefined,
    npm_config_prefix: undefined, NPM_CONFIG_PREFIX: undefined,
  }
  const app = new PackagedApp({ executable, root, workspace, paintCovered: false, env })
  const readings: Reading[] = []
  const desktopRun = async (run: string) => {
    const spawnedAt = Date.now()
    const started = app.start()
    const { page, seenAt } = await connect(port, (url) => url.startsWith("mako-app:"), spawnedAt + 120_000)
    await page.send("Performance.enable")
    const readyAt = await until(page, ready, spawnedAt + 120_000)
    await started
    save(readings, await measure(run, spawnedAt, page, seenAt, readyAt, () => [app.child?.pid ?? 0, app.hostPid ?? 0]))
    page.close()
  }
  // `PackagedApp` takes its debugging port from the Thread's allocation; this run names the one it reads.
  process.env.MAKO_THREAD_PORTS = String(port)
  try {
    await desktopRun("cold: no host, empty profile")
    // The desktop alone: its host stays, as it does after a Quit.
    await closeDesktop(app.child!)
    app.child = undefined
    const host = await app.host()
    if (!host) throw new Error("The host left with the desktop")
    for (let index = 1; index < runs; index++) {
      await desktopRun(`warm desktop, host running (${index})`)
      await closeDesktop(app.child!)
      app.child = undefined
    }
    await app.stop()
    await desktopRun("warm profile, host started again")
  } finally {
    await app.stop().catch(() => undefined)
  }
  return readings
}

async function benchOther(): Promise<Reading[]> {
  const profile = join(root, "profile")
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })
  rmSync(profile, { recursive: true, force: true })
  const readings: Reading[] = []
  for (let index = 0; index < runs; index++) {
    const spawnedAt = Date.now()
    const child: ChildProcess = spawn(executable, ["--use-mock-keychain", `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"], {
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MAKO_"))), HOME: home, ...(userdataEnv && { [userdataEnv]: profile }) },
      detached: true,
      stdio: "ignore",
    })
    child.once("error", (error) => console.error(error.message))
    const exited = new Promise((done) => child.once("exit", done))
    try {
      const { page, seenAt } = await connect(port, (url) => !url.startsWith("devtools:") && url !== "about:blank", spawnedAt + 60_000)
      await page.send("Performance.enable")
      const readyAt = await until(page, ready, spawnedAt + 60_000)
      save(readings, await measure(index === 0 ? "first launch, empty profile" : `warm profile (${index})`, spawnedAt, page, seenAt, readyAt, () => [child.pid ?? 0]))
      page.close()
    } finally {
      try { process.kill(-child.pid!, "SIGTERM") } catch { /* Already exited. */ }
      await Promise.race([exited, delay(5000)])
      try { process.kill(-child.pid!, "SIGKILL") } catch { /* Gone. */ }
      await delay(1500)
    }
  }
  return readings
}

const readings = appName === "mako" ? await benchMako() : await benchOther()
for (const reading of readings) {
  console.log(`${appName} · ${reading.run}`)
  console.log(`  window ${reading.windowMs} ms · navigation ${reading.navigationMs} ms · first paint ${reading.fcpMs ?? "–"} ms · largest paint ${reading.lcpMs ?? "–"} ms · usable ${reading.readyMs} ms`)
  console.log(`  renderer snapshot: ${reading.renderer.taskMs} ms of tasks (${reading.renderer.scriptMs} script, ${reading.renderer.layoutMs} layout, ${reading.renderer.styleMs} style), ${reading.longFramesBeforeReady} long frames starting before readiness, ${reading.blockingBeforeReadyMs} ms blocking, ${reading.renderer.heapMB} MB heap, ${reading.renderer.nodes} nodes`)
  console.log(`  idle after ${settleS} s: ${reading.processes} processes, ${reading.footprintMB} MB footprint (${reading.rssMB} MB resident), ${reading.idleCpuPercent}% of a core over ${idleS} s`)
  console.log(`  ${Object.entries(reading.byKind).map(([kind, entry]) => `${kind} ×${entry.count} ${entry.footprintMB} MB ${entry.idleCpuPercent}%`).join(" · ")}`)
}
if (out) writeFileSync(out, JSON.stringify(readings, null, 2))

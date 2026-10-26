import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { request } from "node:http"
import { createRequire } from "node:module"
import { arch, cpus, loadavg, platform, release, tmpdir, totalmem } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { parseArgs, promisify } from "node:util"
import { encodeRuntimeCall } from "@mako/host/contracts/runtime"
import { runtimeLocation } from "@mako/host/transport/service"
import { headlessNodeExecutable } from "@mako/host/base/headless-node"
import { subscribeRuntime } from "@mako/host/transport/connection"
import { GROK_VERSIONS } from "@mako/host/harnesses/grok/versions"

/**
 * Measures a host the way its clients see it, in a throwaway profile: time
 * from spawn to /health, memory of the host and every process under it,
 * round trips on the socket, and the event loop's delay idle, under reads and
 * with Sessions streaming. Streaming runs scripts/fixtures/acp-stream-agent.mjs
 * as `grok`, first on the measured host's PATH, so Grok's own definition
 * launches it with no account and no network.
 *
 *   node scripts/measure-host.mjs                 the built dist-electron host under
 *                                                 Electron's Helper in Node mode, as
 *                                                 hostCommand runs it on a Mac
 *   node scripts/measure-host.mjs --runtime node  the same under this Node
 *   node scripts/measure-host.mjs --app Mako.app  a packaged app's host: start-up,
 *                                                 memory and reads only, since a
 *                                                 packaged app ignores NODE_OPTIONS
 *   node scripts/measure-host.mjs --node loader   under this Node with a module loader
 *                                                 first, such as a Linux machine's
 *   node scripts/measure-host.mjs --program mako-host.js
 *                                                 an installed `mako-host` under this Node,
 *                                                 as a Linux machine runs it
 *                                                 (`npm run test:host-linux -- --measure`)
 *   node scripts/measure-host.mjs --dev           a checkout's host as a development host,
 *                                                 which also hashes its build at start and
 *                                                 watches it; otherwise it runs as installed
 *   node scripts/measure-host.mjs --budget        the same, then each measure against its
 *                                                 target; exits 1 if any is missed.
 *                                                 `npm run host:budget` builds first
 *
 * After streaming it times one more launch, its caches warm, and after the
 * host stops, a task's first computer call with and without a loaded spare.
 *
 * Idle is measured with the loop unsampled, since sampling it costs more
 * than an idle host does; reads and streaming sample it every millisecond.
 */
const { values: options } = parseArgs({
  options: {
    app: { type: "string" },
    node: { type: "string" },
    program: { type: "string" },
    dev: { type: "boolean", default: false },
    budget: { type: "boolean", default: false },
    runtime: { type: "string" },
    runs: { type: "string", default: "5" },
    sessions: { type: "string", default: "6" },
    "stream-ms": { type: "string", default: "20000" },
    reads: { type: "string", default: "300" },
    out: { type: "string" },
  },
})
const run = promisify(execFile)
const repo = resolve(".")
const packaged = options.app ? await realpath(resolve(options.app)) : undefined
const loader = options.node ? resolve(options.node) : undefined
const program = options.program ? await realpath(resolve(options.program)) : undefined
const runtime = options.runtime ?? (loader || program ? "node" : "helper")
if (!["helper", "node"].includes(runtime)) throw new Error(`--runtime is helper or node, not ${runtime}`)
if (program && (packaged || loader || options.dev || runtime !== "node"))
  throw new Error("--program measures an installed mako-host under this Node; drop --app, --node, --dev and --runtime")
if (packaged && runtime === "node") throw new Error("A packaged app's host runs under its Helper; --runtime node measures the checkout")
if (packaged && options.dev) throw new Error("A packaged app's host is never a development host; --dev measures a checkout")
if (options.budget && (packaged || options.dev || runtime !== "helper" || options.sessions !== "6"))
  throw new Error("The budget run measures a checkout's host as installed, under the Helper, with six Sessions; drop --app, --dev, --runtime, --node and --sessions")
if (options.budget && platform() !== "darwin") throw new Error("The targets are a Mac's; Linux's come with the Linux proof")
const electron = packaged ? join(packaged, "Contents/MacOS/Mako") : runtime === "node" ? undefined : createRequire(import.meta.url)("electron")
const executable = runtime === "node" ? process.execPath : headlessNodeExecutable(electron)
const entry = program ?? (packaged ? join(packaged, "Contents/Resources/app.asar/dist-electron/entry.js") : join(repo, "dist-electron/entry.js"))
const args = [entry]
// Plain Node keeps the caller's options (a container's --preserve-symlinks) and adds the loader.
const hostNodeOptions = loader ? `${process.env.NODE_OPTIONS ?? ""} --import ${loader}`.trim() : ""
const psArgs = platform() === "linux" ? ["-eo", "pid=,ppid=,rss=,args="] : ["-axo", "pid=,ppid=,rss=,command="]
const runs = Number(options.runs)
const sessions = packaged ? 0 : Number(options.sessions)
const streamMs = Number(options["stream-ms"])
// Under macOS's long temp folder the catalog reader's socket passes the
// 104-byte limit, and the host would fall back to a worker no Mac runs.
const scratch = await realpath(await mkdtemp(join(platform() === "darwin" ? "/tmp" : tmpdir(), "mako-measure-")))
const home = join(scratch, "home")
const dataRoot = join(scratch, "data")
const samplesFile = join(scratch, "samples.ndjson")
const loopSwitch = join(scratch, "sample-the-loop")
const location = runtimeLocation(dataRoot)
await mkdir(home, { recursive: true })
await mkdir(location.directory, { recursive: true, mode: 0o700 })
const standIn = join(scratch, "bin")
const standInSessions = join(scratch, "stand-in-sessions")
const quoted = (text) => `'${text.replaceAll("'", "'\\''")}'`
await mkdir(standIn)
await writeFile(join(standIn, "grok"), `#!/bin/sh
case " $* " in
  *" --version "*) echo "grok ${GROK_VERSIONS.tested} (measure stand-in)"; exit 0 ;;
  *" stdio "*) echo "$$" >> ${quoted(standInSessions)}; ELECTRON_RUN_AS_NODE=1 exec ${quoted(process.execPath)} ${quoted(join(repo, "scripts/fixtures/acp-stream-agent.mjs"))} ;;
esac
echo "The measure stand-in for grok answers --version and agent stdio, not: $*" >&2
exit 2
`, { mode: 0o755 })

const env = {
  ...process.env,
  HOME: home,
  MAKO_DATA_ROOT: dataRoot,
  MAKO_WEB_SOCKET: location.socket,
  MAKO_PROFILE: "measure",
  MAKO_RUNTIME_TRACE: "1",
  MAKO_TELEMETRY: "off",
}
for (const key of ["ELECTRON_RUN_AS_NODE", "MAKO_PROD", "VITE_DEV_SERVER_URL", "CLAUDE_CONFIG_DIR", "NODE_OPTIONS"]) delete env[key]
if (!options.dev) env.MAKO_PROD = "1"
let running
let measuredPid
const client = randomUUID()

function call(path, body) {
  return new Promise((done, fail) => {
    const began = performance.now()
    const req = request({ socketPath: location.socket, path, method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-mako-window": client } }, (response) => {
      const chunks = []
      response.on("data", (chunk) => chunks.push(chunk))
      response.on("end", () => done({ status: response.statusCode, ms: performance.now() - began, body: Buffer.concat(chunks).toString() }))
      response.on("error", fail)
    })
    req.on("error", fail)
    req.end(body)
  })
}
const invoke = async (channel, values) => {
  const reply = await call("/rpc", encodeRuntimeCall(channel, values, 1))
  const parsed = JSON.parse(reply.body)
  if (!parsed.ok) throw new Error(`${channel}: ${parsed.error}`)
  return { ms: reply.ms, value: parsed.value }
}

async function start(measured) {
  const childEnv = { ...env }
  if (hostNodeOptions) childEnv.NODE_OPTIONS = hostNodeOptions
  if (electron) Object.assign(childEnv, { ELECTRON_RUN_AS_NODE: "1", MAKO_HOST_EXECUTABLE: electron })
  if (measured) Object.assign(childEnv, {
    NODE_OPTIONS: `${hostNodeOptions} --require ${join(repo, "scripts/fixtures/host-measure-preload.cjs")}`.trim(),
    MAKO_MEASURE_SAMPLES: samplesFile,
    MAKO_MEASURE_LOOP: loopSwitch,
    PATH: [standIn, env.PATH].filter(Boolean).join(delimiter),
    MEASURE_STREAM_MS: String(streamMs),
  })
  const spawned = performance.now()
  const host = spawn(executable, args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] })
  running = host
  const timeline = []
  let output = ""
  host.stdout.on("data", (data) => {
    const at = Math.round(performance.now() - spawned)
    for (const line of data.toString().split("\n"))
      if (/^\[mako-(entry|runtime|startup)\]/.test(line)) timeline.push({ at, line: line.slice(0, 160) })
  })
  host.stderr.on("data", (data) => { output = (output + data).slice(-4000) })
  const deadline = Date.now() + 60_000
  for (;;) {
    assert.ok(host.exitCode === null, `The host exited while starting: ${output}`)
    assert.ok(Date.now() < deadline, "The host answered /health within 60 s")
    const health = await call("/health").catch(() => undefined)
    if (health?.status === 200) {
      return { host, timeline, healthMs: Math.round(performance.now() - spawned), info: JSON.parse(health.body) }
    }
    await delay(5)
  }
}
async function stop(host) {
  const sent = performance.now()
  const exited = once(host, "exit")
  host.kill("SIGTERM")
  const settled = await Promise.race([exited.then(() => true), delay(20_000).then(() => false)])
  if (!settled) {
    host.kill("SIGKILL")
    await once(host, "exit")
    // A killed host leaves helpers such as Crashpad's handler; only this run's profile names them.
    const { stdout } = await run("ps", psArgs)
    for (const line of stdout.split("\n"))
      if (line.includes(scratch)) process.kill(Number(line.trim().split(/\s+/)[0]), "SIGTERM")
  }
  running = undefined
  await rm(location.socket, { force: true })
  return settled ? Math.round(performance.now() - sent) : null
}

/**
 * `mb` is resident memory, which counts every resident shared page (on
 * macOS, all of the Electron framework) in each process that maps it. With
 * `footprint` set, the system's own accounting of what each process costs is
 * added: on macOS its footprint (the figure Activity Monitor shows), private
 * and dirty memory; on Linux its proportional set size, its private pages
 * and its share of each page it shares.
 */
async function processes(root, { footprint = false } = {}) {
  const { stdout } = await run("ps", psArgs)
  const rows = stdout.trim().split("\n").map((line) => {
    const [, pid, ppid, rss, command] = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
    return { pid: Number(pid), ppid: Number(ppid), mb: Math.round(Number(rss) / 1024), command }
  })
  const tree = []
  const visit = (pid, depth) => {
    for (const row of rows.filter((item) => item.ppid === pid)) {
      tree.push({ ...row, depth, name: describe(row.command) })
      visit(row.pid, depth + 1)
    }
  }
  const self = rows.find((row) => row.pid === root)
  visit(root, 1)
  const sum = (key) => [self, ...tree].reduce((total, row) => total + (row ? key(row) ?? 0 : 0), 0)
  const memory = {
    hostMb: self?.mb ?? 0,
    children: tree.map(({ pid, name, mb, depth }) => ({ pid, name, mb, depth })),
    totalMb: sum((row) => row.mb),
  }
  if (footprint && ["darwin", "linux"].includes(platform())) {
    const pids = [root, ...tree.map((row) => row.pid)]
    const footprints = platform() === "darwin" ? await footprintsOf(pids) : await proportionalSizesOf(pids)
    memory.footprintMb = footprints.get(root) ?? null
    for (const child of memory.children) child.footprintMb = footprints.get(child.pid) ?? null
    memory.totalFootprintMb = sum((row) => footprints.get(row.pid))
  }
  for (const child of memory.children) delete child.pid
  return memory
}
async function footprintsOf(pids) {
  const file = join(scratch, `footprint-${Date.now()}.json`)
  await run("footprint", ["-j", file, ...pids.flatMap((pid) => ["-p", String(pid)])]).catch(() => {})
  const report = JSON.parse(await readFile(file, "utf8").catch(() => '{"processes":[]}'))
  await rm(file, { force: true })
  return new Map(report.processes.map((item) => [item.pid, Math.round(item.footprint / 1048576)]))
}
async function proportionalSizesOf(pids) {
  const sizes = await Promise.all(pids.map(async (pid) => {
    const rollup = await readFile(`/proc/${pid}/smaps_rollup`, "utf8").catch(() => "")
    const kb = Number(rollup.match(/^Pss:\s+(\d+) kB$/m)?.[1])
    return [pid, Number.isFinite(kb) ? Math.round(kb / 1024) : null]
  }))
  return new Map(sizes.filter(([, mb]) => mb !== null))
}
function describe(command) {
  const type = command.match(/--type=([\w-]+)/)?.[1]
  const service = command.match(/--utility-sub-type=([\w.]+)/)?.[1]
  if (type) return `Electron ${type}${service ? ` (${service.split(".").pop()})` : ""}`
  const script = command.match(/\/(dist-electron|host\/dist|scripts\/fixtures|app\.asar[^ ]*)\/([\w./-]+)/)
  if (script) return script[2]
  const [binary, first] = command.split(" ")
  return [binary.split("/").pop(), first?.split("/").slice(-2).join("/")].filter(Boolean).join(" ")
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] * 100) / 100
}
const summary = (values) => values.length ? { count: values.length, p50: percentile(values, 50), p95: percentile(values, 95), p99: percentile(values, 99), max: percentile(values, 100) } : null
async function samplesBetween(from, to) {
  const rows = (await readFile(samplesFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  const window = rows.filter((row) => row.pid === measuredPid && row.at > from && row.at <= to)
  if (!window.length) return null
  const sampled = window.filter((row) => row.loop)
  return {
    seconds: window.length,
    ...(sampled.length && {
      loopP99Ms: { median: percentile(sampled.map((row) => row.loop.p99), 50), worst: Math.max(...sampled.map((row) => row.loop.p99)) },
      loopMaxMs: Math.max(...sampled.map((row) => row.loop.max)),
    }),
    cpuPercent: { median: percentile(window.map((row) => row.cpuPercent), 50), peak: Math.max(...window.map((row) => row.cpuPercent)) },
    heapMb: Math.max(...window.map((row) => row.heapMb)),
  }
}
/** Starts or stops sampling the measured host's loop; the preload notices within its next second. */
async function sampleTheLoop(on) {
  if (on) await writeFile(loopSwitch, "")
  else await rm(loopSwitch, { force: true })
  await delay(1100)
}
/**
 * A task's first computer call as the host makes it, in this process: cold,
 * when the call starts the task's worker, and warm, when it takes the spare a
 * pool loads once a task has used the computer. The CLI's calls reach the
 * same worker through the same socket.
 */
async function firstComputerCalls() {
  const { ControlWorkers, startDesktopControlSession } = await import("@mako/control-runtime/session")
  const workers = new ControlWorkers({ quietMs: 60_000 })
  const opened = []
  const timedFirstCall = async (taskId) => {
    const session = await startDesktopControlSession({ taskId }, { workers })
    opened.push(session)
    const began = performance.now()
    await session.request({ method: "status" }, AbortSignal.timeout(20_000))
    return { ms: Math.round((performance.now() - began) * 10) / 10, pid: session.pid }
  }
  try {
    const cold = await timedFirstCall("measure-cold")
    const warm = []
    let taken = cold.pid
    for (let index = 0; index < 3; index++) {
      const deadline = Date.now() + 20_000
      while (!workers.sparePid || workers.sparePid === taken) {
        assert.ok(Date.now() < deadline, "A spare loads once a task has used the computer")
        await delay(20)
      }
      const spare = workers.sparePid
      await workers.spareLoaded()
      const call = await timedFirstCall(`measure-warm-${index}`)
      assert.equal(call.pid, spare, "The next task's first call takes the spare")
      warm.push(call.ms)
      taken = call.pid
    }
    return { coldFirstCallMs: cold.ms, warmFirstCallMs: warm, warmMedianMs: [...warm].sort((a, b) => a - b)[1] }
  } finally {
    for (const session of opened) await session.close()
    await workers.close()
  }
}
/** Each finished launch phase in the measured host's log, of one conversation or all. */
async function launchPhases(conversation) {
  const phases = []
  for (const line of (await readFile(join(dataRoot, "logs", "host.log"), "utf8").catch(() => "")).split("\n")) {
    if (!line.includes("provider-startup phase") || (conversation && !line.includes(`conversation=${conversation}`))) continue
    const phase = line.match(/ phase=([\w-]+) .*durationMs=([\d.]+) state=done/)
    if (phase) phases.push({ phase: phase[1], ms: Number(phase[2]) })
  }
  return phases
}
/** The machine's load average over the last minute. */
function loadAverage() {
  return Math.round(loadavg()[0] * 100) / 100
}
/** The host's own view of its event loop, from `/health`. */
const hostLoop = async () => JSON.parse((await call("/health")).body).eventLoop ?? null

/**
 * The targets of the host design's performance table (Wayfinder,
 * meta-harness/host-redesign.md), for a checkout's host as installed on a
 * Mac. `--budget` checks each; one not measured counts as missed.
 */
const BUDGETS = [
  { measure: "Spawn to /health, warm median", unit: "ms", target: 200, value: (r) => r.startup.warmMedianMs },
  { measure: "Stop on SIGTERM, idle, slowest", unit: "ms", target: 1000, value: (r) => Math.max(...r.startup.stopMs) },
  { measure: "Memory idle, all processes (footprint)", unit: "MB", target: 200, value: (r) => r.idle.memory.totalFootprintMb },
  { measure: "CPU idle, a window subscribed, median", unit: "%", target: 1, value: (r) => r.idle.cpuPercent?.median },
  { measure: "Hot read p99, idle", unit: "ms", target: 5, value: (r) => r.reads.sequentialMs.p99 },
  { measure: "Hot read p99, six Sessions streaming", unit: "ms", target: 5, value: (r) => r.streaming?.readsDuringMs.p99 },
  { measure: "Event-loop delay p99, six Sessions streaming, worst second", unit: "ms", target: 20, value: (r) => r.streaming?.host?.loopP99Ms?.worst },
  { measure: "Event-loop holds of 100 ms or more, whole run", unit: "", target: 0, value: (r) => r.streaming?.hostLoop?.holds.count },
  { measure: "A Session's launch, Mako's own share, caches warm", unit: "ms", target: 20, value: (r) => r.streaming?.warmLaunch?.makoMs },
  { measure: "Stop on SIGTERM, with Sessions", unit: "ms", target: 1000, value: (r) => r.stopMs },
  { measure: "First computer call, warm spare, median", unit: "ms", target: 30, value: (r) => r.computer?.warmMedianMs },
]

/** Prints each budget against its measure; true when every one is met. */
function checkBudgets(measured) {
  const rows = BUDGETS.map(({ measure, unit, target, value }) => {
    const got = value(measured)
    const known = Number.isFinite(got)
    return { measure, target: `${target}${unit && ` ${unit}`}`, measured: known ? `${got}${unit && ` ${unit}`}` : "not measured", met: known && got <= target ? "yes" : "MISSED" }
  })
  console.table(rows)
  const { cores, loadAverageAtStart, loadAverageAtEnd } = measured.machine
  console.log(`measure-host: the machine's load average was ${loadAverageAtStart} at the start and ${loadAverageAtEnd} at the end, on ${cores} cores; timings on a busy machine run slow, so a near miss then is worth a run on a quiet one`)
  const missed = rows.filter((row) => row.met !== "yes").length
  console.log(missed ? `measure-host: ${missed} of ${rows.length} budgets missed` : `measure-host: all ${rows.length} budgets met`)
  return missed === 0
}

let finished = false
// Electron always has pointer compression; a Node, only when built with it.
const node = `Node${process.config.variables.v8_enable_pointer_compression ? " with pointer compression" : ""}`
const report = {
  measured: new Date().toISOString(),
  runtime: program
    ? `${program} under ${node}, as installed`
    : `${packaged ? "packaged" : "dist-electron"}${runtime === "helper" ? " under Electron's Helper in Node mode" : ` under ${node}`}${packaged ? "" : options.dev ? ", as a development host" : ", as installed"}`,
  executable,
  machine: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, cores: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30), loadAverageAtStart: loadAverage() },
}
try {
  // Start-up: the first run compiles into an empty cache; the rest reuse it,
  // as an installed host's every start after its first does.
  const startups = []
  for (let index = 0; index < runs; index++) {
    const started = await start(false)
    report.build ??= { version: started.info.version, devBuild: started.info.devBuild, methods: started.info.methods.length, protocol: started.info.protocol }
    const stopMs = await stop(started.host)
    startups.push({ healthMs: started.healthMs, stopMs, timeline: started.timeline })
  }
  const warm = startups.slice(1)
  const median = warm.length ? warm.map((item) => item.healthMs).sort((a, b) => a - b)[Math.floor(warm.length / 2)] : undefined
  report.startup = {
    coldHealthMs: startups[0].healthMs,
    warmHealthMs: warm.map((item) => item.healthMs),
    warmMedianMs: median,
    stopMs: startups.map((item) => item.stopMs),
    timeline: (warm.find((item) => item.healthMs === median) ?? startups[0]).timeline,
  }

  // A window stays subscribed throughout, as in real use; a profile host with
  // no client stops itself.
  const { host } = await start(!packaged)
  measuredPid = host.pid
  const received = { packets: 0, bytes: 0 }
  let subscribed = true
  const unsubscribe = subscribeRuntime(location.socket, client, (packet) => {
    received.packets++
    received.bytes += packet.channel === "ready" ? JSON.stringify(packet).length : packet.payload.length
  }, () => { subscribed = false })
  const attached = () => assert.ok(subscribed, "The measuring window stayed subscribed to /events")
  await delay(10_000)
  const idleFrom = Date.now()
  const loopBefore = await hostLoop()
  await delay(10_000)
  attached()
  const loopAfter = await hostLoop()
  report.idle = {
    memory: await processes(host.pid, { footprint: true }),
    ...(await samplesBetween(idleFrom, Date.now())),
    ...(loopBefore && loopAfter && { loopChecksPerSecond: Math.round(((loopAfter.delayMs.checks - loopBefore.delayMs.checks) / ((Date.now() - idleFrom) / 1000)) * 10) / 10 }),
  }

  if (!packaged) await sampleTheLoop(true)
  for (let index = 0; index < 20; index++) await invoke("mako:threads", [])
  const readsFrom = Date.now()
  const sequential = []
  for (let index = 0; index < Number(options.reads); index++) sequential.push((await invoke("mako:threads", [])).ms)
  const parallelBegan = performance.now()
  const parallel = await Promise.all(Array.from({ length: 200 }, () => invoke("mako:threads", []).then((reply) => reply.ms)))
  report.reads = {
    channel: "mako:threads",
    sequentialMs: summary(sequential),
    parallel: { calls: 200, ms: summary(parallel), wallMs: Math.round(performance.now() - parallelBegan) },
    host: await samplesBetween(readsFrom, Date.now() + 1000),
  }

  if (sessions) {
    const project = join(scratch, "project")
    await mkdir(project)
    await run("git", ["init", "-q", project]).catch(() => {})
    const before = { ...received }
    const ids = Array.from({ length: sessions }, () => randomUUID())
    const streamFrom = Date.now()
    const startMs = await Promise.all(ids.map((conversationId, index) => invoke("mako:live-start", ["grok", project, {
      conversationId,
      title: `Measured stream ${index + 1}`,
      initialRequest: { id: randomUUID(), text: "stream", attachments: [] },
    }]).then((reply) => Math.round(reply.ms))))
    const during = []
    let peak = { totalMb: 0 }
    while (Date.now() - streamFrom < streamMs) {
      during.push((await invoke("mako:threads", [])).ms)
      if (during.length % 20 === 0) {
        const memory = await processes(host.pid)
        if (memory.totalMb > peak.totalMb) peak = await processes(host.pid, { footprint: true })
      }
      await delay(100)
    }
    const streamTo = Date.now()
    const memoryStreaming = await processes(host.pid, { footprint: true })
    await delay(3000)
    const snapshots = await Promise.all(ids.map(async (id) => (await invoke("mako:live-snapshot", [id])).value))
    const texts = snapshots.map((snapshot) => JSON.stringify(snapshot ?? "").length)
    const served = (await readFile(standInSessions, "utf8").catch(() => "")).split("\n").filter(Boolean).length
    assert.ok(served >= sessions, `Grok's launch ran the stand-in for every measured session: ${served} of ${sessions}`)
    report.streaming = {
      sessions,
      streamMs,
      windowMs: streamTo - streamFrom,
      agent: "scripts/fixtures/acp-stream-agent.mjs through Grok's ACP source: 4 words every 20 ms, a 40-line tool result every 2 s",
      liveStartMs: startMs,
      snapshotBytes: texts,
      eventsReceived: { packets: received.packets - before.packets, megabytes: Math.round((received.bytes - before.bytes) / 1e4) / 100 },
      readsDuringMs: summary(during),
      memoryPeak: peak,
      memoryAtEnd: memoryStreaming,
      host: await samplesBetween(streamFrom + 2000, streamTo),
      hostLoop: await hostLoop(),
    }
    const phases = {}
    for (const { phase, ms } of await launchPhases()) (phases[phase] ??= []).push(ms)
    report.streaming.startupPhasesMs = Object.fromEntries(Object.entries(phases).map(([name, values]) => [name, summary(values)]))
    const short = snapshots.find((_, index) => texts[index] <= 10_000)
    if (short) report.streaming.unstreamedSnapshot = short
    assert.ok(!short, "Every measured Session streamed its turn into its snapshot")

    // The six launched at once, each waiting on the first run of every harness's
    // `mcp list`. A window prewarms that while the first message is written, so
    // one more launch, with the caches warm, is what a person's launch costs.
    const warmId = randomUUID()
    await invoke("mako:live-start", ["grok", project, {
      conversationId: warmId,
      title: "Measured warm launch",
      initialRequest: { id: randomUUID(), text: "stream", attachments: [] },
    }])
    const deadline = Date.now() + 20_000
    let warm = []
    while (!warm.some((entry) => entry.phase === "launch")) {
      assert.ok(Date.now() < deadline, "The warm launch finished within 20 s")
      await delay(50)
      warm = await launchPhases(warmId)
    }
    const total = (phase) => warm.filter((entry) => entry.phase === phase).reduce((sum, entry) => sum + entry.ms, 0)
    const agentMs = total("handshake") + total("session-open")
    report.streaming.warmLaunch = {
      phasesMs: Object.fromEntries([...new Set(warm.map((entry) => entry.phase))].map((phase) => [phase, Math.round(total(phase) * 100) / 100])),
      agentMs: Math.round(agentMs * 100) / 100,
      makoMs: Math.round((total("launch") - agentMs) * 100) / 100,
    }
  }
  attached()
  unsubscribe()
  report.stopMs = await stop(host)
  // The shared reader, as on a machine, or a worker in the host when it couldn't start one.
  const adopted = [...(await readFile(join(dataRoot, "logs", "host.log"), "utf8")).matchAll(/catalog discovery adopted .* kind=(\w+)/g)]
  report.catalog = adopted.at(-1)?.[1] ?? null
  // A Linux machine's computer is the cloud control worker's (runtime/control), measured by its own acceptance.
  if (!packaged && !program) report.computer = await firstComputerCalls()
  if (!packaged)
    report.samples = (await readFile(samplesFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
      .filter((row) => row.pid === measuredPid).map((row) => [row.at, row.loop?.p99 ?? null, row.loop?.max ?? null, row.cpuPercent, row.rssMb])
  report.machine.loadAverageAtEnd = loadAverage()
  finished = true
} finally {
  if (running) report.stopMs = await stop(running)
  const out = options.out ?? join(scratch, "..", `mako-measure-${report.runtime}-${Date.now()}.json`)
  await writeFile(out, JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify(report, null, 2))
  console.log(`measure-host: wrote ${out}`)
  if (finished) await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  else console.log(`measure-host: kept the profile and host log for inspection in ${scratch}`)
}
if (options.budget && !checkBudgets(report)) process.exitCode = 1

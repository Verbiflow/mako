import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { request } from "node:http"
import { createRequire } from "node:module"
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { parseArgs, promisify } from "node:util"
import { encodeRuntimeCall } from "../dist-electron/contracts/runtime.js"
import { runtimeLocation } from "../dist-electron/runtime-service.js"
import { subscribeRuntime } from "../dist-electron/runtime-connection.js"

/**
 * Measures a host the way its clients see it, in a throwaway profile: time
 * from spawn to /health, memory of the host and every process under it,
 * round trips on the socket, and the event loop's delay idle, under reads and
 * with Sessions streaming. Streaming uses scripts/fixtures/acp-stream-agent.mjs
 * in place of the Grok CLI, so it needs no account and no network.
 *
 *   node scripts/measure-host.mjs                 the built dist-electron host
 *   node scripts/measure-host.mjs --app Mako.app  a packaged app's host: start-up,
 *                                                 memory and reads only, since a
 *                                                 packaged app ignores NODE_OPTIONS
 *   node scripts/measure-host.mjs --node loader   dist-electron under plain Node, with
 *                                                 a module loader standing in for
 *                                                 Electron until the host needs none
 */
const { values: options } = parseArgs({
  options: {
    app: { type: "string" },
    node: { type: "string" },
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
const executable = packaged ? join(packaged, "Contents/MacOS/Mako") : loader ? process.execPath : createRequire(import.meta.url)("electron")
const args = packaged ? [] : loader ? [join(repo, "dist-electron/main.js")] : [repo]
// Plain Node keeps the caller's options (a container's --preserve-symlinks) and adds the loader.
const hostNodeOptions = loader ? `${process.env.NODE_OPTIONS ?? ""} --import ${loader}`.trim() : ""
const psArgs = platform() === "linux" ? ["-eo", "pid=,ppid=,rss=,args="] : ["-axo", "pid=,ppid=,rss=,command="]
const runs = Number(options.runs)
const sessions = packaged ? 0 : Number(options.sessions)
const streamMs = Number(options["stream-ms"])
const scratch = await realpath(await mkdtemp(join(tmpdir(), "mako-measure-")))
const home = join(scratch, "home")
const dataRoot = join(scratch, "data")
const samplesFile = join(scratch, "samples.ndjson")
const location = runtimeLocation(dataRoot)
await mkdir(home, { recursive: true })
await mkdir(location.directory, { recursive: true, mode: 0o700 })

const env = {
  ...process.env,
  HOME: home,
  MAKO_HOST_ONLY: "1",
  MAKO_WEB_ONLY: "1",
  MAKO_DATA_ROOT: dataRoot,
  MAKO_WEB_SOCKET: location.socket,
  MAKO_PROFILE: "measure",
  MAKO_CURSOR_SDK_ROOT: join(scratch, "cursor"),
  MAKO_RUNTIME_TRACE: "1",
  MAKO_TELEMETRY: "off",
}
for (const key of ["ELECTRON_RUN_AS_NODE", "MAKO_PROD", "MAKO_STANDALONE", "VITE_DEV_SERVER_URL", "CLAUDE_CONFIG_DIR", "NODE_OPTIONS"]) delete env[key]
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
    req.end(body === undefined ? undefined : JSON.stringify(body))
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
  if (measured) Object.assign(childEnv, {
    NODE_OPTIONS: `${hostNodeOptions} --require ${join(repo, "scripts/fixtures/host-measure-preload.cjs")}`.trim(),
    MAKO_MEASURE_SAMPLES: samplesFile,
    MAKO_MEASURE_REPO: repo,
    MAKO_MEASURE_STREAM_AGENT: join(repo, "scripts/fixtures/acp-stream-agent.mjs"),
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
 * `mb` is resident memory, which on macOS counts every resident page of the
 * shared Electron framework in each process that maps it. With `footprint`
 * set, macOS's own accounting (the figure Activity Monitor shows) is added:
 * private and dirty memory, which is what the processes actually cost.
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
  if (footprint && platform() === "darwin") {
    const footprints = await footprintsOf([root, ...tree.map((row) => row.pid)])
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
function describe(command) {
  const type = command.match(/--type=([\w-]+)/)?.[1]
  const service = command.match(/--utility-sub-type=([\w.]+)/)?.[1]
  if (type) return `Electron ${type}${service ? ` (${service.split(".").pop()})` : ""}`
  const script = command.match(/\/(dist-electron|scripts\/fixtures|app\.asar[^ ]*)\/([\w./-]+)/)
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
  const window = rows.filter((row) => row.loop && row.pid === measuredPid && row.at > from && row.at <= to)
  if (!window.length) return null
  return {
    seconds: window.length,
    loopP99Ms: { median: percentile(window.map((row) => row.loop.p99), 50), worst: Math.max(...window.map((row) => row.loop.p99)) },
    loopMaxMs: Math.max(...window.map((row) => row.loop.max)),
    cpuPercent: { median: percentile(window.map((row) => row.cpuPercent), 50), peak: Math.max(...window.map((row) => row.cpuPercent)) },
    heapMb: Math.max(...window.map((row) => row.heapMb)),
  }
}
const streamAgent = async () => (await readFile(samplesFile, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((row) => row.streamAgent)

let finished = false
const report = {
  measured: new Date().toISOString(),
  runtime: packaged ? "packaged" : loader ? "plain-node" : "dist-electron",
  executable,
  machine: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, cores: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30) },
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
    received.bytes += JSON.stringify(packet).length
  }, () => { subscribed = false })
  const attached = () => assert.ok(subscribed, "The measuring window stayed subscribed to /events")
  await delay(10_000)
  const idleFrom = Date.now()
  await delay(10_000)
  attached()
  report.idle = { memory: await processes(host.pid, { footprint: true }), ...(await samplesBetween(idleFrom, Date.now())) }

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
    const agent = await streamAgent()
    assert.equal(agent?.streamAgent, "installed", `The streaming agent replaced Grok's launch: ${agent?.reason ?? "not yet"}`)
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
        if (memory.totalMb > peak.totalMb) peak = memory
      }
      await delay(100)
    }
    const streamTo = Date.now()
    const memoryStreaming = await processes(host.pid, { footprint: true })
    await delay(3000)
    const snapshots = await Promise.all(ids.map(async (id) => (await invoke("mako:live-snapshot", [id])).value))
    const texts = snapshots.map((snapshot) => JSON.stringify(snapshot ?? "").length)
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
    }
    const phases = {}
    for (const line of (await readFile(join(dataRoot, "logs", "host.log"), "utf8")).split("\n")) {
      const phase = line.match(/provider-startup phase .* phase=([\w-]+) .*durationMs=([\d.]+) state=done/)
      if (phase) (phases[phase[1]] ??= []).push(Number(phase[2]))
    }
    report.streaming.startupPhasesMs = Object.fromEntries(Object.entries(phases).map(([name, values]) => [name, summary(values)]))
    const short = snapshots.find((_, index) => texts[index] <= 10_000)
    if (short) report.streaming.unstreamedSnapshot = short
    assert.ok(!short, "Every measured Session streamed its turn into its snapshot")
  }
  attached()
  unsubscribe()
  report.stopMs = await stop(host)
  if (!packaged)
    report.samples = (await readFile(samplesFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
      .filter((row) => row.loop).map((row) => [row.at, row.loop.p99, row.loop.max, row.cpuPercent, row.rssMb])
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

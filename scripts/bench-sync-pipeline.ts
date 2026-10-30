import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { join, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { parseArgs } from "node:util"
import { zstdDecompressSync } from "node:zlib"
import { z } from "zod"
import { decodeChunkPack, decodeRecordPush, RecordBundleSchema, type RecordBundle, type RecordPushAnswer } from "@mako/protocol/records"
import { BackfillProgressSchema } from "../packages/sessions/src/record-backfill.ts"
import { ON_DEMAND_CATALOG_NODE_ARGS } from "../packages/host/src/threads/daemon-command.ts"
import { connectDaemon, type DaemonClient } from "../packages/sessions/src/daemon.ts"
import { removeScratch } from "./lib/scratch-processes.mjs"

/**
 * How long a write on this Mac takes to be in the account, and what holds it up, on the real sync daemon:
 * `npm run bench:sync-pipeline`.
 *
 * A scratch home holds a Codex session; the sync daemon (`mako-syncd`, this checkout's build, or `--daemon <file>`)
 * runs on it as the installed app runs it, with the session in its scope and both its links (the reading copies and
 * the originals) pointing at a gateway stand-in in this process, which keeps chunks once by hash and takes every
 * bundle. Each line the bench appends carries a mark (`mk<n>x`); the stand-in reads every chunk it's sent, and a mark
 * counts as in the account once a bundle it took names a chunk holding it. Meanwhile the sync status is asked every
 * 250 ms with the host's 3 s timeout, as the host asks it every 5 s.
 *
 * Scenarios: `quiet`, a line every 2 s; `turn`, a line every 50 ms for 10 s, as an answer streams; `large`, the same turn
 * on a session of `--large-mib` MiB (its first upload timed too); `busy-host`, the turn while a process of its own
 * plays the host, asking the status every 5 s and holding its own loop 1.5 s in every 3 (`--play-host`). The harness
 * stores are never touched: only the scratch home is.
 *
 *   npm run bench:sync-pipeline [-- --daemon <daemon-main.js>] [--large-mib 150] [--out <file>] [--keep]
 */
const { values } = parseArgs({
  options: {
    daemon: { type: "string" },
    "large-mib": { type: "string", default: "150" },
    port: { type: "string", default: "20024" },
    out: { type: "string" },
    keep: { type: "boolean", default: false },
    scenarios: { type: "string", default: "quiet,turn,large,busy-host" },
    "play-host": { type: "string" },
  },
})
const daemonScript = resolve(values.daemon ?? join(import.meta.dirname, "../packages/sessions/dist/daemon-main.js"))
const port = Number(values.port)
const say = (line: string) => process.stderr.write(`${line}\n`)

/** The account's records routes for one device's two forms, in memory: chunks by hash, each bundle taken. */
class StandIn {
  readonly chunks = new Map<string, number[]>()
  /** When each mark was first named by a bundle the stand-in took, by form. */
  readonly arrived = { originals: new Map<number, number>(), copies: new Map<number, number>() }
  readonly sent = { originals: 0, copies: 0 }
  readonly calls: Record<string, number> = {}
  readonly holdings = new Map<string, Record<string, number>>()
  server: Server | undefined

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.#answer(request).then(
        ({ status, body }) => {
          response.writeHead(status, { "content-type": "application/json" })
          response.end(JSON.stringify(body))
        },
        (error: Error) => {
          response.writeHead(500, { "content-type": "application/json" })
          response.end(JSON.stringify({ title: error.message }))
        }
      )
    })
    await new Promise<void>((done) => this.server?.listen(port, "127.0.0.1", done))
  }

  async #answer(request: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const url = new URL(request.url ?? "/", "http://stand.in")
    const form = url.pathname.includes("/originals") ? "originals" : "copies"
    const route = url.pathname.replace(/^.*\/(originals|records)/, "")
    const body = await new Promise<Buffer>((done) => {
      const parts: Buffer[] = []
      request.on("data", (part: Buffer) => parts.push(part))
      request.on("end", () => done(Buffer.concat(parts)))
    })
    const key = `${request.method} ${route.split("?")[0]}`
    this.calls[key] = (this.calls[key] ?? 0) + 1
    this.sent[form] += body.length
    if (key === "POST /chunks/missing") {
      const { hashes } = z.object({ hashes: z.array(z.string()) }).parse(JSON.parse(body.toString()))
      return { status: 200, body: { missing: hashes.filter((hash) => !this.chunks.has(hash)) } }
    }
    if (key === "PUT /chunks") {
      const pack = decodeChunkPack(body)
      for (const chunk of pack) this.#keep(chunk)
      return { status: 200, body: { taken: pack.length } }
    }
    if (key === "POST /sessions/with-chunks") {
      const { bundle, pack } = decodeRecordPush(body)
      for (const chunk of decodeChunkPack(pack)) this.#keep(chunk)
      const missing = bundle.units.flatMap((unit) => unit.versions.flatMap((version) => hashesOf(version.chunks))).filter((hash) => !this.chunks.has(hash))
      if (missing.length) return { status: 409, body: { missing } }
      return { status: 200, body: this.#take(form, bundle) }
    }
    if (key === "POST /sessions") return { status: 200, body: this.#take(form, RecordBundleSchema.parse(JSON.parse(body.toString()))) }
    if (key === "GET /sessions/holdings") return { status: 200, body: { holdings: this.holdings.get(`${form}\n${url.searchParams.get("nativeId")}`) ?? {}, next: null } }
    if (key === "GET /sessions") return { status: 200, body: { sessions: [] } }
    return { status: 404, body: { title: `No ${key}` } }
  }

  #keep(chunk: { hash: string; codec: number; body: Uint8Array }): void {
    if (this.chunks.has(chunk.hash)) return
    const plain = chunk.codec === 1 ? zstdDecompressSync(chunk.body) : Buffer.from(chunk.body)
    this.chunks.set(chunk.hash, [...plain.toString("latin1").matchAll(/mk(\d+)x/g)].map((match) => Number(match[1])))
  }

  #take(form: "originals" | "copies", bundle: RecordBundle): RecordPushAnswer {
    const now = performance.now()
    const held = this.holdings.get(`${form}\n${bundle.nativeId}`) ?? {}
    let versions = 0
    for (const unit of bundle.units)
      for (const version of unit.versions) {
        versions += 1
        held[unit.key] = Math.max(held[unit.key] ?? -1, version.seq)
        for (const hash of hashesOf(version.chunks)) for (const mark of this.chunks.get(hash) ?? []) if (!this.arrived[form].has(mark)) this.arrived[form].set(mark, now)
      }
    this.holdings.set(`${form}\n${bundle.nativeId}`, held)
    return { ok: true, versions, held: 0, through: versions }
  }
}

const hashesOf = (chunks: string) => chunks.match(/.{64}/g) ?? []

const percentile = (values: readonly number[], share: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]!) : null
}
const summary = (values: readonly number[]) => ({ n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: values.length ? Math.round(Math.max(...values)) : null })
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms))
const spin = (ms: number) => {
  const until = performance.now() + ms
  while (performance.now() < until);
}

/** A Codex session in the scratch home: its rollout, which the catalog lists and the record store takes. */
function rollout(home: string, filler = 0) {
  const id = randomUUID()
  const at = new Date()
  const folder = join(home, ".codex", "sessions", ...at.toISOString().slice(0, 10).split("-"))
  mkdirSync(folder, { recursive: true })
  const path = join(folder, `rollout-${at.toISOString().slice(0, 19).replaceAll(":", "-")}-${id}.jsonl`)
  const timestamp = () => new Date().toISOString()
  const message = (role: string, text: string) =>
    `${JSON.stringify({ timestamp: timestamp(), type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } })}\n`
  writeFileSync(path, `${JSON.stringify({ timestamp: timestamp(), type: "session_meta", payload: { id, cwd: home, cli_version: "0.160.0" } })}\n${message("user", "Begin")}`)
  // A large session: answers of 64 KiB that don't compress to nothing, as a long Session's tool output doesn't.
  for (let written = 0; written < filler; written += 64 * 1024) appendFileSync(path, message("assistant", randomBytes(48 * 1024).toString("base64")))
  return { path, id, append: (text: string) => appendFileSync(path, message("assistant", text)) }
}

type Probe = { ms: number[]; timedOut: number }

/** The sync daemon's resident memory, sampled every 250 ms: its guard retires it past 512 MB. */
function sampleMemory(pid: number | undefined) {
  let peak = 0
  const timer = setInterval(() => {
    try {
      peak = Math.max(peak, Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)]).toString().trim()) / 1024)
    } catch {
      // Gone: retired, which the scenario's status says.
    }
  }, 250)
  return {
    stop: () => {
      clearInterval(timer)
      return Math.round(peak)
    },
  }
}

/** The sync status, asked every 250 ms as the host asks it, timed; a request the client gave up on at 3 s is counted apart. */
function probeStatus(client: DaemonClient) {
  const probe: Probe = { ms: [], timedOut: 0 }
  let running = true
  void (async () => {
    while (running) {
      const started = performance.now()
      const answered = await client.syncStatus().then(() => true, () => false)
      if (answered) probe.ms.push(performance.now() - started)
      else probe.timedOut += 1
      await delay(250)
    }
  })()
  return {
    stop: () => {
      running = false
      return probe
    },
  }
}

/** What the host's own process saw of the status (`playHost`). */
const HostStatusSchema = z.object({ n: z.number(), p50: z.number().nullable(), p95: z.number().nullable(), max: z.number().nullable(), timedOut: z.number() })

type Writes = { count: number; everyMs: number; session?: ReturnType<typeof rollout>; filler?: number; busyHost?: boolean }

/** One scenario: a session in scope, its lines written at their pace, and when each reached the account in each form. */
async function scenario(order: number, stand: StandIn, home: string, client: DaemonClient, writes: Writes) {
  const session = writes.session ?? rollout(home)
  const scope = { sessions: [{ harness: "codex", nativeId: session.id, path: session.path, thread: `t-${order}`, busy: true, tier: "now" as const }], paused: false }
  // The first capture and upload of what was there: a large session's is its throughput.
  const memory = sampleMemory(daemon?.pid)
  const first = performance.now()
  const sentBefore = stand.sent.originals
  await client.scopeSync(scope)
  const opened = performance.now()
  const firstMark = 1_000_000 * order
  session.append(`opening mk${firstMark}x`)
  for (let waited = 0; !stand.arrived.originals.has(firstMark) && waited < 600; waited++) await delay(100)
  const firstUpload = { ms: Math.round(performance.now() - first), mib: +((stand.sent.originals - sentBefore) / 1048576).toFixed(1) }
  const probe = probeStatus(client)
  const host = writes.busyHost ? spawn(process.execPath, [...process.execArgv, import.meta.filename, "--play-host", join(home, ".mako", "syncd.sock")], { stdio: ["ignore", "pipe", "ignore"] }) : undefined
  const hostSaid: Buffer[] = []
  host?.stdout?.on("data", (part: Buffer) => hostSaid.push(part))
  const written = new Map<number, number>()
  for (let n = 1; n <= writes.count; n++) {
    const mark = firstMark + n
    written.set(mark, performance.now())
    session.append(`word ${n} of the answer mk${mark}x`)
    await delay(writes.everyMs)
  }
  const last = Math.max(...written.keys())
  for (let waited = 0; (!stand.arrived.originals.has(last) || !stand.arrived.copies.has(last)) && waited < 3_000; waited++) await delay(100)
  const status = probe.stop()
  const daemonPeakMb = memory.stop()
  let hostStatus: z.infer<typeof HostStatusSchema> | undefined
  if (host) {
    const exited = new Promise((done) => host.once("exit", done))
    host.kill("SIGTERM")
    await exited
    hostStatus = HostStatusSchema.parse(JSON.parse(Buffer.concat(hostSaid).toString()))
  }
  const lag = (form: "originals" | "copies") => {
    const lags: number[] = []
    let missing = 0
    for (const [mark, at] of written) {
      const arrived = stand.arrived[form].get(mark)
      if (arrived === undefined) missing += 1
      else lags.push(arrived - at)
    }
    return { ...summary(lags), missing }
  }
  return {
    writes: writes.count, everyMs: writes.everyMs, sessionMiB: +((writes.filler ?? 0) / 1048576).toFixed(0),
    firstUpload, firstMarkMs: Math.round((stand.arrived.originals.get(firstMark) ?? NaN) - opened),
    originals: lag("originals"), copies: lag("copies"),
    status: { ...summary(status.ms), timedOut: status.timedOut, over1s: status.ms.filter((ms) => ms >= 1_000).length },
    daemonPeakMb, daemonAlive: daemon?.exitCode === null,
    ...hostStatus && { hostStatus },
  }
}

/** The host's part, in a process of its own: the status every 5 s, its loop held 1.5 s in every 3; its timings on exit. */
async function playHost(socket: string): Promise<void> {
  const client = await connectDaemon(socket)
  const timed: number[] = []
  let timedOut = 0
  process.once("SIGTERM", () => {
    process.stdout.write(JSON.stringify({ ...summary(timed), timedOut }))
    process.exit(0)
  })
  setInterval(() => spin(1_500), 3_000)
  for (;;) {
    const started = performance.now()
    await client.syncStatus().then(() => timed.push(performance.now() - started), () => (timedOut += 1))
    await delay(5_000)
  }
}
if (values["play-host"]) await playHost(values["play-host"])

const results: Record<string, Awaited<ReturnType<typeof scenario>>> = {}
const home = mkdtempSync("/tmp/mako-sp-")
let daemon: ChildProcess | undefined
const stand = new StandIn()
try {
  await stand.start()
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home }
  for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_DATA_HOME", "OPENCODE_DB", "MAKO_DATA_ROOT"]) delete env[name]
  mkdirSync(join(home, ".mako"), { recursive: true })
  mkdirSync(join(home, ".codex", "sessions"), { recursive: true })
  const wanted = new Set(values.scenarios.split(","))
  // The large session is there before the daemon starts, as a long Session is: the backfill's pass, in a process of its
  // own, takes it into the record store, and the daemon captures only what's written to it after.
  const large = wanted.has("large") ? rollout(home, Number(values["large-mib"]) * 1048576) : undefined
  // As the host starts it (`ON_DEMAND_CATALOG_NODE_ARGS`): its heap and its GC are what its memory guard sees.
  daemon = spawn(process.execPath, [...ON_DEMAND_CATALOG_NODE_ARGS, daemonScript], { env, stdio: "ignore" })
  let client: DaemonClient | undefined
  for (let tries = 0; !client && tries < 100; tries++) {
    await delay(200)
    client = await connectDaemon(join(home, ".mako", "syncd.sock")).catch(() => undefined)
  }
  if (!client) throw new Error("the sync daemon didn't answer")
  const base = (form: string) => `http://127.0.0.1:${port}/v1/devices/d-bench/${form}`
  await client.syncOriginals({ id: base("originals"), base: base("originals"), authorization: "Bearer bench" })
  await client.syncCopies({ id: base("records"), base: base("records"), authorization: "Bearer bench" })
  if (large) {
    for (let waited = 0; waited < 600; waited++) {
      let text = "{}"
      try {
        text = readFileSync(join(home, ".mako", "records", "backfill.json"), "utf8")
      } catch {
        // Not written until the pass has begun.
      }
      if (BackfillProgressSchema.safeParse(JSON.parse(text)).data?.endedAt) break
      await delay(500)
    }
  }
  const runs: [string, Writes][] = [
    ["quiet", { count: 10, everyMs: 2_000 }],
    ["turn", { count: 200, everyMs: 50 }],
    ["large", { count: 200, everyMs: 50, ...large && { session: large }, filler: Number(values["large-mib"]) * 1048576 }],
    ["busy-host", { count: 200, everyMs: 50, busyHost: true }],
  ]
  for (const [name, writes] of runs) {
    if (!wanted.has(name)) continue
    results[name] = await scenario(Object.keys(results).length + 1, stand, home, client, writes)
    say(`${name}: ${JSON.stringify(results[name])}`)
  }
  client.close()
  const held = readFileSync(join(home, ".mako", "logs", "syncd.log"), "utf8").split("\n").filter((line) => line.includes("loop held"))
  const report = { daemon: daemonScript, scenarios: results, requests: stand.calls, sentMiB: { originals: +(stand.sent.originals / 1048576).toFixed(1), copies: +(stand.sent.copies / 1048576).toFixed(1) }, loopHeld: held.map((line) => line.slice(0, 300)) }
  const text = JSON.stringify(report, null, 2)
  if (values.out) writeFileSync(values.out, text)
  process.stdout.write(`${text}\n`)
} finally {
  daemon?.kill("SIGTERM")
  stand.server?.close()
  await delay(500)
  if (!values.keep) await removeScratch(home)
  else say(`kept ${home}`)
}

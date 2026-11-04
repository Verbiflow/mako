import { execFileSync, fork, spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { invokeRuntime, probeRuntime } from "@mako/host/transport/connection"
import { runtimeLocation } from "@mako/host/transport/service"
import { heldBy, slices } from "./lib/cpu-slices.ts"
import { claudeSessionPath, makeWorld, TODAY, type WorldScale } from "./lib/host-load-world.ts"
import { removeScratch } from "./lib/scratch-processes.mjs"

/**
 * Whether the host keeps answering while many Fins work: `npm run bench:host-load`.
 *
 * A real host (this checkout's build, or `--host <mako-host.js>` for another's) runs isolated in a scratch home on a
 * world shaped as the person's Mac was the day it stalled (`TODAY`: 52 Threads' worktrees of a two-repository
 * project, 95 apps with 24 running, some 850 processes, a rail of sessions). Its Fins work all through: each edits
 * files in its worktrees a few times a second and appends the call to its transcript, builds now and then and runs
 * tests that churn the temporary folder. Three windows ask what the renderer asks (the worktrees' summaries every
 * half minute and as focus moves between them, the apps' marks and each followed folder's app every four seconds).
 * Meanwhile a prober of its own asks `/health` every 20 ms and reads a list every 100 ms, each timed to its answer.
 *
 * It fails (exit 1) when one health check in a hundred waited past `--health-p99-ms` (100) or one read in a hundred
 * past `--read-p99-ms` (500), when any waited past `--max-ms` (1000), or when one failed. A host answering as it
 * should waits about 50 ms on one health check in a hundred here, and the host that stalled waited 600 ms, with reads
 * of ten seconds: the limits sit between the two, so a slow runner doesn't fail it and a regression can't pass. `--cpu-prof <dir>` keeps the host's CPU profile and
 * prints the longest slices it held the loop for, named by the host's own functions; `--out <file>` keeps the report;
 * `--home-from <home>` runs on APFS clones of a real home's harness stores (macOS, read-only to the original).
 *
 *   npm run bench:host-load [-- --scale today|ci] [--seconds 60] [--warmup 20] [--host <mako-host.js>] [--cpu-prof <dir>] [--out <file>] [--keep]
 */
const { values } = parseArgs({
  options: {
    scale: { type: "string", default: "today" },
    seconds: { type: "string", default: "60" },
    warmup: { type: "string", default: "20" },
    host: { type: "string" },
    "cpu-prof": { type: "string" },
    "home-from": { type: "string" },
    "budget-ms": { type: "string", default: "50" },
    "health-p99-ms": { type: "string", default: "100" },
    "read-p99-ms": { type: "string", default: "500" },
    "max-ms": { type: "string", default: "1000" },
    windows: { type: "string", default: "3" },
    root: { type: "string" },
    out: { type: "string" },
    keep: { type: "boolean", default: false },
  },
})
const say = (line: string) => process.stderr.write(`${line}\n`)
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms))
const SCALES = {
  today: TODAY,
  ci: { threads: 29, fins: [6, 6, 4, 3, 2, 2], files: [1500, 2200], apps: 95, running: 24, processes: 400, sessions: 600 },
  /** For changing the bench itself. */
  tiny: { threads: 2, fins: [1], files: [60, 60], apps: 3, running: 1, processes: 4, sessions: 5 },
} satisfies Record<string, WorldScale>
const scale: WorldScale = z.enum(["today", "ci", "tiny"]).transform((name) => SCALES[name]).parse(values.scale)
const hostScript = resolve(values.host ?? join(import.meta.dirname, "../packages/host/dist/mako-host.js"))
if (!existsSync(hostScript)) throw new Error(`${hostScript} isn't built: npx tsgo -b packages/host`)
const budget = Number(values["budget-ms"])
const maxMs = Number(values["max-ms"])

const root = realpathSync(values.root ? (mkdirSync(values.root, { recursive: true }), values.root) : mkdtempSync(join(tmpdir(), "mako-host-load-")))
say(`world: ${root}`)
const began = performance.now()
const world = await makeWorld(root, scale)
say(`world made in ${Math.round(performance.now() - began)} ms: ${world.checkouts.length} checkouts, ${world.checkouts.reduce((sum, checkout) => sum + checkout.repositories.length, 0)} worktrees`)
if (values["home-from"]) {
  for (const store of [".claude/projects", ".codex/sessions", ".cursor/projects", ".cursor/chats"]) {
    const from = join(values["home-from"], store)
    if (!existsSync(from)) continue
    mkdirSync(join(world.home, store, ".."), { recursive: true })
    execFileSync("cp", ["-c", "-R", from, join(world.home, store, "..")])
    say(`cloned ${store}`)
  }
}

const children: ChildProcess[] = []
let host: ChildProcess | undefined
const finish = async (code: number) => {
  for (const child of children) child.kill("SIGKILL")
  world.release()
  if (!values.keep) await removeScratch(root).catch((error: Error) => say(`scratch left: ${error.message}`))
  process.exit(code)
}

try {
  const { directory, socket } = runtimeLocation(world.dataRoot)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(MAKO_|CLAUDE_|CODEX_HOME|CURSOR_)/.test(name)))
  const profileDir = values["cpu-prof"] && resolve(values["cpu-prof"])
  if (profileDir) mkdirSync(profileDir, { recursive: true })
  host = spawn("nice", ["-n", "5", process.execPath, ...(profileDir ? ["--cpu-prof", "--cpu-prof-dir", profileDir, "--cpu-prof-interval", "1000"] : []), hostScript], {
    env: { ...env, HOME: world.home, TMPDIR: world.temporary, MAKO_DATA_ROOT: world.dataRoot, MAKO_WEB_SOCKET: socket, MAKO_PROD: "1", MAKO_TELEMETRY: "off" },
    stdio: ["ignore", "ignore", "inherit"],
  })
  const exited = new Promise<number | null>((done) => host!.once("exit", (code) => done(code)))
  for (const deadline = Date.now() + 60_000; ; await delay(100)) {
    const probe = await probeRuntime(socket, { timeoutMs: 2_000 }).catch(() => undefined)
    if (probe?.state === "ready") break
    if (Date.now() > deadline) throw new Error("the host didn't answer /health within a minute")
  }
  const client = randomUUID()
  const call = (channel: string, ...args: unknown[]) => invokeRuntime(socket, client, channel, args, 1, { timeoutMs: 600_000 })
  for (const deadline = Date.now() + 180_000; ; await delay(500)) {
    const listed = z.object({ ready: z.boolean() }).loose().parse(await call("mako:threads"))
    if (listed.ready) break
    if (Date.now() > deadline) throw new Error("the host hasn't read its catalog within three minutes")
  }
  say(`host ready in ${Math.round(performance.now() - began)} ms`)

  // The Fins at work: the Apexes with Fins, and every Fin.
  const working = world.checkouts.filter((checkout, index) => checkout.fin || index < scale.fins.length)
  const fins = working.map((checkout, index) => ({
    name: `fin-${index}`, path: checkout.path, repositories: checkout.repositories, session: checkout.session, transcript: claudeSessionPath(world.home, checkout.path, checkout.session),
  }))
  const churn = fork(join(import.meta.dirname, "lib/host-load-churn.mjs"), [JSON.stringify({
    fins, temporary: world.temporary, editMs: [300, 1200], buildMs: [20_000, 40_000], buildFiles: 400, formatFiles: 40, temporaryFiles: 300,
  })], { stdio: ["ignore", "ignore", "inherit", "ipc"] })
  children.push(churn)

  // The windows, each asking what the renderer asks, never waiting for one answer to ask again.
  const windows = Number(values.windows)
  const followed = world.checkouts.map((checkout) => checkout.path)
  let windowCalls = 0
  let windowFailures = 0
  const ask = (channel: string, ...args: unknown[]) => {
    windowCalls += 1
    call(channel, ...args).catch(() => { windowFailures += 1 })
  }
  const timers: NodeJS.Timeout[] = []
  for (let w = 0; w < windows; w += 1) {
    ask("mako:worktree-summaries")
    timers.push(setInterval(() => ask("mako:worktree-summaries"), 30_000))
    timers.push(setInterval(() => ask("mako:thread-app-marks"), 4_000))
    const mine = followed.slice(w * 3, w * 3 + 3)
    timers.push(setInterval(() => mine.forEach((cwd) => ask("mako:thread-app", cwd)), 4_000))
  }
  // Focus moving between windows: each focus refreshes that window's summaries.
  timers.push(setInterval(() => ask("mako:worktree-summaries"), 10_000))

  say(`warming up for ${values.warmup} s with ${fins.length} Fins at work`)
  await delay(Number(values.warmup) * 1000)
  const probeOut = join(root, "probe.json")
  const prober = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "lib/host-load-probe.ts"), socket, probeOut, "mako:worktrees", "20", "100", "30000"], {
    stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, TSX_TSCONFIG_PATH: join(import.meta.dirname, "../tsconfig.scripts.json") },
  })
  children.push(prober)
  say(`probing for ${values.seconds} s`)
  await delay(Number(values.seconds) * 1000)
  const proberDone = new Promise((done) => prober.once("exit", done))
  prober.kill("SIGTERM")
  await proberDone
  const health = z.object({ eventLoop: z.unknown().optional(), jobs: z.unknown().optional() }).loose().parse(
    await (await import("@mako/host/transport/connection")).runtimeRequest({ socket, path: "/health", read: (body: string) => JSON.parse(body), timeoutMs: 30_000 }).catch(() => ({})),
  )
  for (const timer of timers) clearInterval(timer)
  churn.kill("SIGKILL")
  host.kill("SIGTERM")
  const code = await Promise.race([exited, delay(60_000).then(() => "timeout" as const)])
  if (code === "timeout") host.kill("SIGKILL")

  const probed = z.object({ health: z.array(z.tuple([z.number(), z.number().nullable()])), reads: z.array(z.tuple([z.number(), z.number().nullable()])) }).parse(JSON.parse(readFileSync(probeOut, "utf8")))
  const summary = (times: [number, number | null][]) => {
    const answered = times.map(([, ms]) => ms).filter((ms): ms is number => ms !== null).sort((a, b) => a - b)
    const at = (share: number) => answered[Math.min(answered.length - 1, Math.floor(share * answered.length))] ?? null
    const over = times.filter(([, ms]) => ms === null || ms > budget).length
    return { n: times.length, failed: times.length - answered.length, p50: at(0.5), p99: at(0.99), p999: at(0.999), max: answered.at(-1) ?? null, overBudget: over, overShare: times.length ? over / times.length : 1 }
  }
  // One profile per thread: the main thread's is numbered 0 (`CPU.<date>.<time>.<pid>.0.<n>.cpuprofile`).
  const profile = profileDir && readdirSync(profileDir).filter((name) => /\.\d+\.0\.\d+\.cpuprofile$/.test(name)).map((name) => join(profileDir, name)).sort().at(-1)
  const found = profile ? slices(profile, 50) : []
  const answers = { health: summary(probed.health), reads: summary(probed.reads) }
  const report = {
    scale: values.scale, host: hostScript, seconds: Number(values.seconds), fins: fins.length, windows, windowCalls, windowFailures,
    ...answers, eventLoop: health.eventLoop,
    ...profile && {
      profile,
      slices: { count: found.length, totalMs: found.reduce((sum, slice) => sum + slice.ms, 0), longest: [...found].sort((a, b) => b.ms - a.ms).slice(0, 15) },
      heldBy: heldBy(found),
    },
  }
  const text = JSON.stringify(report, null, 2)
  if (values.out) writeFileSync(values.out, text)
  process.stdout.write(`${text}\n`)
  const failures: string[] = []
  const limits = { health: { p99: Number(values["health-p99-ms"]), max: maxMs }, reads: { p99: Number(values["read-p99-ms"]), max: maxMs } }
  for (const name of ["health", "reads"] as const) {
    const result = answers[name]
    if (result.failed) failures.push(`${name}: ${result.failed} of ${result.n} failed or passed the probe's timeout`)
    if ((result.p99 ?? Infinity) > limits[name].p99) failures.push(`${name}: one in a hundred waited ${result.p99} ms or more (budget ${limits[name].p99} ms); ${result.overBudget} of ${result.n} waited past ${budget} ms`)
    if ((result.max ?? Infinity) > limits[name].max) failures.push(`${name}: the longest wait was ${result.max} ms (budget ${limits[name].max} ms)`)
  }
  for (const failure of failures) say(`FAIL ${failure}`)
  await finish(failures.length ? 1 : 0)
} catch (error) {
  say(`bench:host-load failed: ${error instanceof Error ? error.stack : String(error)}`)
  host?.kill("SIGKILL")
  await finish(1)
}

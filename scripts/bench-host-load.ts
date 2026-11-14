import { execFileSync, fork, spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { invokeRuntime, probeRuntime } from "@mako/host/transport/connection"
import { runtimeLocation } from "@mako/host/transport/service"
import { HOST_NODE_OPTIONS } from "@mako/host/base/process-warnings"
import { heldBy, slices, timeIn } from "./lib/cpu-slices.ts"
import { readResident, unmeasured, type ResidentMemory } from "./lib/host-load-memory.ts"
import { claudeSessionPath, makeWorld, TODAY, type WorldScale } from "./lib/host-load-world.ts"
import { removeScratch } from "./lib/scratch-processes.mjs"
import { scriptedModel } from "./scripted-model.ts"
import { fakeCloud, type AccountReports } from "./lib/sync-bench-cloud.ts"

/**
 * Whether the host keeps answering while many Fins work: `npm run bench:host-load`.
 *
 * A real host (this checkout's build, or `--host <mako-host.js>` for another's) runs isolated in a scratch home on a
 * world shaped as the person's Mac was the day it stalled (`TODAY`: 52 Threads' worktrees of a two-repository
 * project, 95 apps with 24 running, some 850 processes, a rail of sessions). Its Fins work all through: each edits
 * files in its worktrees a few times a second and appends the call to its transcript, builds now and then and runs
 * tests that churn the temporary folder. Three windows ask what the renderer asks (the worktrees' summaries every
 * half minute and as focus moves between them, the apps' marks once, then as the host pushes them, and each followed
 * folder's app every half minute).
 * Meanwhile a prober of its own asks `/health` every 20 ms and reads a list every 100 ms, each timed to its answer.
 * These deliberate 50 Hz health and 10 Hz worktree stress probes include response construction, encoding and
 * writing in the host's profile; they are not the renderer's polling rates or a measure of idle production RPC cost.
 * `--tool-heavy --send --seconds 120` adds 13 scripted turns of 64 file patches (832 calls), including turn-end
 * attribution. Completion reads only `live-state`: a status check must not serialize the growing transcript.
 *
 * A shared runner's speed varies by several times between runs, so the limits are calibrated in the same run: a
 * yardstick process beside the host, under the same contention and running none of Mako's code
 * (`host-load-yardstick.mjs`), times its own event loop while the host is probed. It fails (exit 1) only on a clear
 * regression: a health check waiting two seconds past the yardstick's worst wait (the stalled host held its loop for
 * 3-5 s at a time), one in a hundred
 * waiting past `--times` (30) times the yardstick's one in a hundred (at least 150 ms), one read in a hundred past ten
 * times that, or a probe failing. On one CI runner in one job, at this scale, the yardstick waited 14 ms on one tick in
 * a hundred; the host before #358 waited 3.3 s on one health check in a hundred and 20 s on a read, and the host
 * after it 74 ms and 605 ms: each limit is several times from either. Every number goes to the job's summary
 * (`GITHUB_STEP_SUMMARY`) whether it passes or not; `--report-only` judges without failing. `--cpu-prof <dir>` keeps the host's CPU profile and
 * prints the longest slices it held the loop for, named by the host's own functions; `--out <file>` keeps the report;
 * `--peak-limit-mb` fails on the host's peak resident memory, sampled each second, and on readings too few to say. Memory barely varies between
 * machines: 629 MB on a Mac and 669 MB on a CI runner at this scale, so `checks.yml` sets 1,500;
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
    times: { type: "string", default: "30" },
    "report-only": { type: "boolean", default: false },
    "peak-limit-mb": { type: "string", default: "0" },
    windows: { type: "string", default: "3" },
    root: { type: "string" },
    out: { type: "string" },
    keep: { type: "boolean", default: false },
    send: { type: "boolean", default: false },
    "tool-heavy": { type: "boolean", default: false },
    "model-port": { type: "string" },
    "send-quiet": { type: "boolean", default: false },
    fins: { type: "string", default: "0" },
    "node-arg": { type: "string", multiple: true },
    gc: { type: "boolean", default: false },
    "app-poll-ms": { type: "string", default: "30000" },
    "heap-snapshots": { type: "string" },
    "snapshot-sends": { type: "string" },
    idle: { type: "boolean", default: false },
    "idle-only": { type: "boolean", default: false },
    "summaries-every": { type: "string", default: "30000" },
    account: { type: "boolean", default: false },
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
/** The host's peak resident memory this run may reach; 0 reports it without judging. */
const peakLimit = Number(values["peak-limit-mb"])
const times = Number(values.times)
/**
 * A health check this much slower than the yardstick's worst wait is the loop held for seconds, as the day it stalled:
 * a runner that stops every process at once stops the yardstick as long, so its stall isn't the host's.
 */
const HELD_MS = 2_000
/** One health check in a hundred may wait this long whatever the yardstick says: below it a runner's noise decides. */
const HEALTH_FLOOR_MS = 150
/** A read does work of its own (a hundred worktrees looked at), so it may take this many health checks' limits. */
const READ_TIMES = 10

if (values["tool-heavy"] && (!values.send || Number(values.fins) > 0))
  throw new Error("--tool-heavy requires --send and no --fins")

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
  await model?.close()
  await cloud?.close()
  if (!values.keep) await removeScratch(root).catch((error: Error) => say(`scratch left: ${error.message}`))
  process.exit(code)
}

/** With `--send`: when the stand-in model first heard each `BENCH-S<n>` message, by its tag. */
const heardAt = new Map<string, number>()
const completedTools = new Set<string>()
const toolSteps = new Map<string, number>()
const TOOL_CALLS = 64
const TOOL_TURNS = 13
const LiveStateStatus = z.object({ status: z.string() }).loose()
/** With `--fins <n>` (and `--send`): the Apex the sends go to starts this many Fins, each a Codex turn, before the probe. */
const finCount = Number(values.fins)
// `--account`: the host signs in to the protocol's fake gateway in this process, which counts what it reports of its
// Sessions (frames, rows, bytes), so the account's message rate is measured beside the loop.
const cloud = values.account ? await fakeCloud() : undefined
if (cloud) {
  await cloud.account()
  mkdirSync(join(world.dataRoot, "cloud"), { recursive: true, mode: 0o700 })
  // Signed in for the account only: no harness sign-ins shared, no login item installed.
  writeFileSync(join(world.dataRoot, "cloud", "sign-ins.json"), JSON.stringify({ version: 2, sharing: false, accessOnly: true, inStep: {} }), { mode: 0o600 })
  mkdirSync(join(world.home, ".mako"), { recursive: true })
  writeFileSync(join(world.home, ".mako", "syncd-login-optout"), "")
}
const model = values.send || finCount > 0 ? await scriptedModel({
  ...values["model-port"] && { port: z.coerce.number().int().min(1).max(65535).parse(values["model-port"]) },
  reply: (heard) => {
    for (const match of heard.matchAll(/BENCH-([SF]\d+)/g)) if (!heardAt.has(match[1]!)) heardAt.set(match[1]!, performance.now())
    if (values["tool-heavy"]) {
      const tag = [...heard.matchAll(/BENCH-(S\d+)/g)].at(-1)?.[1]
      if (!tag) throw new Error("The tool-heavy turn has no bench tag")
      const step = toolSteps.get(tag) ?? 0
      if (step < TOOL_CALLS) {
        toolSteps.set(tag, step + 1)
        const path = `app/attribution-bench-${tag}-${step}.ts`
        const lines = Array.from({ length: 128 }, (_, line) => `+export const v${line} = ${step * 128 + line}`).join("\n")
        return { call: { id: `attribution_${tag}_${step}`, name: "apply_patch", input: `*** Begin Patch\n*** Add File: ${path}\n${lines}\n*** End Patch\n` } }
      }
      completedTools.add(tag)
    }
    return { text: "Done." }
  },
}) : undefined
if (model) {
  // A sealed Codex in the scratch home, answered by the stand-in: a real send's way through the host, no account.
  mkdirSync(join(world.home, ".codex"), { recursive: true })
  writeFileSync(join(world.home, ".codex", "config.toml"), `openai_base_url = "${model.url}/v1"\nchatgpt_base_url = "${model.url}/backend-api"\n\n[features]\nplugins = false\n`)
  writeFileSync(join(world.home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "mako-host-load" }), { mode: 0o600 })
}

try {
  const { directory, socket } = runtimeLocation(world.dataRoot)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(MAKO_|CLAUDE_|CODEX_HOME|CURSOR_)/.test(name)))
  const profileDir = values["cpu-prof"] && resolve(values["cpu-prof"])
  if (profileDir) mkdirSync(profileDir, { recursive: true })
  // `--node-arg` passes options to the host's Node (a heap limit, `--heap-prof`); `--gc` traces its collections.
  // The host's own options first, as the app starts it (`hostCommand`): the program's first line isn't read when Node runs it.
  // `--heap-snapshots <dir>`: the host writes a heap snapshot there on SIGUSR2, after a full collection, as each send
  // `--snapshot-sends` names is answered ("20,80"), to tell what the host keeps per send from what it collects.
  const snapshots = values["heap-snapshots"] && resolve(values["heap-snapshots"])
  if (snapshots) mkdirSync(snapshots, { recursive: true })
  const nodeArgs = [...HOST_NODE_OPTIONS, ...(values["node-arg"] ?? []), ...(values.gc ? ["--trace-gc"] : []), ...(snapshots ? ["--heapsnapshot-signal=SIGUSR2"] : [])]
  host = spawn("nice", ["-n", "5", process.execPath, ...nodeArgs, ...(profileDir ? ["--cpu-prof", "--cpu-prof-dir", profileDir, "--cpu-prof-interval", "1000"] : []), hostScript], {
    cwd: world.project,
    env: { ...env, HOME: world.home, TMPDIR: world.temporary, MAKO_DATA_ROOT: world.dataRoot, MAKO_WEB_SOCKET: socket, MAKO_PROD: "1", MAKO_TELEMETRY: "off", ...finCount > 0 && { MAKO_FIN_SLOTS: "8" }, ...cloud && { MAKO_CLOUD_URL: cloud.url } },
    stdio: ["ignore", values.gc ? "pipe" : "ignore", "inherit"],
    ...profileDir && values["node-arg"]?.some((arg) => arg.startsWith("--heap-prof")) && { cwd: profileDir },
    ...snapshots && { cwd: snapshots },
  })
  // Each collection's pause as `--trace-gc` prints it ("Mark-Compact 450.2 (480.1) -> 320.4 (350.0) MB, … 85.13 / 0.00 ms"), by when it was heard.
  const collections: { at: number; kind: string; ms: number }[] = []
  if (values.gc && host.stdout) {
    let pending = ""
    host.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      const lines = (pending + chunk).split("\n")
      pending = lines.pop() ?? ""
      for (const line of lines) {
        const match = /(Scavenge|Mark-Compact|Mark-Sweep|Minor Mark-Sweep)[^,]*,.*?(\d+(?:\.\d+)?) \/ \d+(?:\.\d+)? ms/.exec(line)
        if (match) collections.push({ at: Date.now(), kind: match[1]!, ms: Number(match[2]) })
      }
    })
  }
  // Its resident memory every 5 s, to tell a sawtooth of garbage from growth.
  const rssSeries: [number, number][] = []
  const snapshotsTaken: { why: string; file: string; rssMb: number | undefined }[] = []
  const exited = new Promise<number | null>((done) => host!.once("exit", (code) => done(code)))
  // Its resident memory, the peak from outside: memory doesn't vary with a runner's speed the way a wait does.
  const memory: ResidentMemory = { peakKb: 0, readings: 0, misses: 0 }
  const hostPid = String(host.pid)
  const sampling = performance.now()
  const footprint = setInterval(() => void readResident(hostPid, memory), 1_000)
  const series = setInterval(() => {
    const kb = Number(spawnSync("ps", ["-o", "rss=", "-p", hostPid], { encoding: "utf8" }).stdout.trim())
    if (kb > 0) rssSeries.push([Date.now(), Math.round(kb / 1024)])
  }, 5_000)
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
  if (cloud) {
    const Account = z.object({ state: z.object({ status: z.string(), url: z.string().optional() }).loose() }).loose()
    let account = Account.parse(await call("mako:cloud-sign-in"))
    if (account.state.status === "signing-in") await cloud.signIn(z.string().parse(account.state.url))
    for (const deadline = Date.now() + 120_000; account.state.status !== "signed-in"; await delay(300)) {
      if (Date.now() > deadline) throw new Error(`the host isn't signed in to the fake account: ${account.state.status}`)
      account = Account.parse(await call("mako:cloud-account"))
    }
    say("signed in to the fake account")
  }

  // `--idle`: the host on this world with nothing at work and no window, settled 30 s, then its own CPU over 60 s, as
  // the perf proof of 2026-11-12 measured it; `--idle-only` stops there.
  let idle: { hostPercent: number; from: number; to: number } | undefined
  if (values.idle || values["idle-only"]) {
    const cpuSeconds = () => {
      const time = spawnSync("ps", ["-o", "time=", "-p", hostPid], { encoding: "utf8" }).stdout.trim()
      return time.split(":").reduce((sum, part) => sum * 60 + Number(part), 0)
    }
    await delay(30_000)
    const [fromCpu, from] = [cpuSeconds(), Date.now()]
    await delay(60_000)
    const [toCpu, to] = [cpuSeconds(), Date.now()]
    idle = { hostPercent: Math.round(((toCpu - fromCpu) / ((to - from) / 1000)) * 1000) / 10, from, to }
    say(`idle: the host used ${idle.hostPercent}% of a core`)
  }
  if (values["idle-only"]) {
    clearInterval(footprint)
    clearInterval(series)
    host.kill("SIGTERM")
    await Promise.race([exited, delay(60_000)])
    if (values.out) writeFileSync(values.out, JSON.stringify({ scale: values.scale, host: hostScript, nodeArgs, idle }, null, 2))
    await finish(0)
  }

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
    // A window before the host said summaries as they change asked every half minute; `--summaries-every 0` is one now.
    const summariesEvery = Number(values["summaries-every"])
    if (summariesEvery > 0) timers.push(setInterval(() => ask("mako:worktree-summaries"), summariesEvery))
    // The marks are read once, then pushed by the host's sampler as they change (`ThreadAppSampler`); each followed
    // folder's app is read again on each push and otherwise every 30 s (`thread-app-host.ts`). A world whose apps hold
    // still pushes nothing, so the 30 s look stands for the pushes too.
    ask("mako:thread-app-marks")
    const mine = followed.slice(w * 3, w * 3 + 3)
    // `--app-poll-ms`: how often a window asks for each followed folder's app; an older renderer asked every 4 s.
    timers.push(setInterval(() => mine.forEach((cwd) => ask("mako:thread-app", cwd)), Number(values["app-poll-ms"])))
  }
  // Focus moving between windows: each focus refreshes that window's summaries.
  timers.push(setInterval(() => ask("mako:worktree-summaries"), 10_000))

  // A message the person sends, timed from the call until its harness asks the model: what waits behind the load
  // (its checkpoint's Git reads, the loop) is in it, the harness's own start isn't (it's running already).
  const sends: [number, number | null][] = []
  const sendDetails: { tag: string; request: string; submittedAt: number; acceptedMs: number; modelMs: number | null }[] = []
  let conversation: string | undefined
  if (values.send || finCount > 0) {
    conversation = randomUUID()
    // By default the send's checkout is one the Fins edit all through; `--send-quiet` takes one nothing edits but the send.
    const churned = (index: number) => world.checkouts[index]!.fin || index < scale.fins.length
    const quietAt = world.checkouts.findLastIndex((_, index) => !churned(index))
    const cwd = world.checkouts[values["send-quiet"] && quietAt >= 0 ? quietAt : 0]!.path
    await call("mako:live-start", "codex", cwd, { conversationId: conversation, modeId: values["tool-heavy"] ? "access:full" : "access:ask", title: "Host load send", initialRequest: { id: randomUUID(), text: "BENCH-S0 start", attachments: [] } })
    for (const deadline = Date.now() + 180_000; !(values["tool-heavy"] ? completedTools : heardAt).has("S0"); await delay(100))
      if (Date.now() > deadline) throw new Error("the bench's Codex never asked the stand-in model")
    if (finCount > 0) {
      // The person's tree of 2026-11-12: an Apex of many Fins, each of which every batch of the Apex's row reads.
      const session = z.object({ sessionId: z.string() }).loose().parse(await call("mako:live-snapshot", conversation)).sessionId
      const caller = { kind: "agent", session }
      for (let i = 0; i < finCount; i += 1) {
        const started = z.object({ refused: z.string().optional() }).loose().parse(await call("mako:agents-start", caller, {
          brief: { objective: `BENCH-F${i} review part ${i}.` }, harness: "codex", name: `part-${i}`, clientKey: `part-${i}`, cwd, mode: "background", wake: "never", queue: true,
        }))
        if (started.refused) throw new Error(`Fin ${i} was refused: ${JSON.stringify(started)}`)
      }
      say(`${finCount} Fins started; waiting for each to ask the model`)
      for (const deadline = Date.now() + 15 * 60_000; [...heardAt.keys()].filter((tag) => tag.startsWith("F")).length < finCount; await delay(500))
        if (Date.now() > deadline) throw new Error(`only ${[...heardAt.keys()].filter((tag) => tag.startsWith("F")).length} of ${finCount} Fins asked the model in 15 minutes`)
      await delay(5_000)
    }
  }
  say(`warming up for ${values.warmup} s with ${fins.length} Fins at work`)
  await delay(Number(values.warmup) * 1000)
  const yardstickOut = join(root, "yardstick.json")
  const yardstick = spawn(process.execPath, [join(import.meta.dirname, "lib/host-load-yardstick.mjs"), yardstickOut, "300"], { stdio: ["ignore", "inherit", "inherit"] })
  children.push(yardstick)
  const probeOut = join(root, "probe.json")
  const prober = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "lib/host-load-probe.ts"), socket, probeOut, "mako:worktrees", "20", "100", "30000"], {
    stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, TSX_TSCONFIG_PATH: join(import.meta.dirname, "../tsconfig.scripts.json") },
  })
  children.push(prober)
  // A read someone waits on, as a window's Changes panel or a send's checkpoint asks, one at a time while the windows'
  // summaries passes run: it must never queue behind a pass of every worktree.
  const reviewed = z.object({ worktrees: z.array(z.object({ path: z.string() }).loose()) }).loose().parse(await call("mako:worktrees")).worktrees.map((worktree) => worktree.path)
  const checkoutReads: [number, number | null][] = []
  let probing = true
  const reading = (async () => {
    for (let at = 0; probing && reviewed.length; at += 1) {
      const began = performance.now()
      const ms = await call("mako:worktree-review", reviewed[at % reviewed.length]).then(() => performance.now() - began, () => null)
      checkoutReads.push([Date.now(), ms === null ? null : Math.round(ms * 10) / 10])
      await delay(500)
    }
  })()
  const snapshotAt = new Set((values["snapshot-sends"] ?? "").split(",").filter(Boolean).map(Number))
  /** A heap snapshot of the host (`--heapsnapshot-signal`), waited for until its file holds still. */
  const heapSnapshot = async (folder: string, why: string) => {
    const before = new Set(readdirSync(folder))
    host!.kill("SIGUSR2")
    for (const deadline = Date.now() + 300_000; Date.now() < deadline; await delay(2_000)) {
      const made = readdirSync(folder).find((name) => name.endsWith(".heapsnapshot") && !before.has(name))
      if (!made) continue
      const size = statSync(join(folder, made)).size
      await delay(3_000)
      if (size > 0 && statSync(join(folder, made)).size === size) {
        say(`heap snapshot ${why}: ${made}`)
        snapshotsTaken.push({ why, file: join(folder, made), rssMb: rssSeries.at(-1)?.[1] })
        return
      }
    }
    say(`heap snapshot ${why}: none written`)
  }
  const sending = (async () => {
    for (let n = 1; probing && conversation && (!values["tool-heavy"] || n < TOOL_TURNS); n += 1) {
      await delay(3_000)
      const tag = `S${n}`
      const began = performance.now(), submittedAt = Date.now(), request = randomUUID()
      await call("mako:live-prompt", conversation, request, `BENCH-${tag} next`, []).catch(() => undefined)
      const acceptedMs = Math.round((performance.now() - began) * 10) / 10
      for (const deadline = Date.now() + 60_000; !heardAt.has(tag) && Date.now() < deadline; ) await delay(10)
      if (values["tool-heavy"]) {
        for (const deadline = Date.now() + 90_000; !completedTools.has(tag) && Date.now() < deadline; ) await delay(10)
        if (!completedTools.has(tag)) throw new Error(`Attribution scripted turn ${tag} did not finish its ${TOOL_CALLS} tool calls`)
        for (const deadline = Date.now() + 60_000; ; await delay(20)) {
          const state = LiveStateStatus.parse(await call("mako:live-state", conversation))
          if (state.status !== "running") break
          if (Date.now() > deadline) throw new Error(`Attribution turn ${tag} did not settle`)
        }
      }
      const heard = heardAt.get(tag)
      const modelMs = heard === undefined ? null : Math.round((heard - began) * 10) / 10
      sends.push([Date.now(), modelMs])
      sendDetails.push({ tag, request, submittedAt, acceptedMs, modelMs })
      if (snapshots && snapshotAt.has(n)) await heapSnapshot(snapshots, `after send ${n}`)
    }
  })()
  say(`probing for ${values.seconds} s`)
  const probedFrom = Date.now()
  const reportsFrom = cloud?.reported?.()
  await delay(Number(values.seconds) * 1000)
  const reportsTo = cloud?.reported?.()
  probing = false
  await reading
  await sending
  const proberDone = new Promise((done) => prober.once("exit", done))
  const yardstickDone = new Promise((done) => yardstick.once("exit", done))
  prober.kill("SIGTERM")
  yardstick.kill("SIGTERM")
  await Promise.all([proberDone, yardstickDone])
  const health = z.object({ eventLoop: z.unknown().optional(), jobs: z.unknown().optional() }).loose().parse(
    await (await import("@mako/host/transport/connection")).runtimeRequest({ socket, path: "/health", read: (body: string) => JSON.parse(body), timeoutMs: 30_000 }).catch(() => ({})),
  )
  const probedTo = Date.now()
  for (const timer of timers) clearInterval(timer)
  clearInterval(footprint)
  clearInterval(series)
  const sampled = (performance.now() - sampling) / 1_000
  churn.kill("SIGKILL")
  host.kill("SIGTERM")
  const code = await Promise.race([exited, delay(60_000).then(() => "timeout" as const)])
  if (code === "timeout") host.kill("SIGKILL")

  const probed = z.object({ health: z.array(z.tuple([z.number(), z.number().nullable()])), reads: z.array(z.tuple([z.number(), z.number().nullable()])) }).parse(JSON.parse(readFileSync(probeOut, "utf8")))
  const summary = (times: [number, number | null][]) => {
    const answered = times.map(([, ms]) => ms).filter((ms): ms is number => ms !== null).sort((a, b) => a - b)
    const at = (share: number) => answered[Math.min(answered.length - 1, Math.floor(share * answered.length))] ?? null
    const over = times.filter(([, ms]) => ms === null || ms > budget).length
    return { n: times.length, failed: times.length - answered.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), p999: at(0.999), max: answered.at(-1) ?? null, overBudget: over, overShare: times.length ? over / times.length : 1 }
  }
  // One profile per thread: the main thread's is numbered 0 (`CPU.<date>.<time>.<pid>.0.<n>.cpuprofile`).
  const profile = profileDir && readdirSync(profileDir).filter((name) => /\.\d+\.0\.\d+\.cpuprofile$/.test(name)).map((name) => join(profileDir, name)).sort().at(-1)
  const found = profile ? slices(profile, 50) : []
  const answers = { health: summary(probed.health), reads: summary(probed.reads), checkoutReads: summary(checkoutReads), ...model && { sends: summary(sends) } }
  const peakMb = Math.round(memory.peakKb / 1024)
  // What the host held and what its collections cost while it was probed.
  const inWindow = <T extends { at: number }>(entries: T[]) => entries.filter((entry) => entry.at >= probedFrom && entry.at <= probedTo)
  const rssProbed = rssSeries.filter(([at]) => at >= probedFrom && at <= probedTo).map(([, mb]) => mb).sort((a, b) => a - b)
  const pauses = (kinds: RegExp) => {
    const ms = inWindow(collections).filter((entry) => kinds.test(entry.kind)).map((entry) => entry.ms).sort((a, b) => a - b)
    return { count: ms.length, totalMs: Math.round(ms.reduce((sum, each) => sum + each, 0)), p99: ms[Math.min(ms.length - 1, Math.floor(0.99 * ms.length))] ?? null, max: ms.at(-1) ?? null }
  }
  const rss = rssProbed.length ? { min: rssProbed[0]!, median: rssProbed[Math.floor(rssProbed.length / 2)]!, max: rssProbed.at(-1)!, series: rssSeries } : undefined
  const gc = values.gc ? { major: pauses(/^Mark-(Compact|Sweep)$/), minor: pauses(/^(Scavenge|Minor Mark-Sweep)$/) } : undefined
  const unread = unmeasured(memory, sampled)
  const report = {
    scale: values.scale, host: hostScript, seconds: Number(values.seconds), fins: fins.length, windows, windowCalls, windowFailures,
    ...values["tool-heavy"] && { toolWorkload: { callsPerTurn: TOOL_CALLS, requestedTurns: TOOL_TURNS, steps: Object.fromEntries(toolSteps), completed: [...completedTools] } },
    ...answers, ...model && { sendSamples: sends, sendDetails }, eventLoop: health.eventLoop, peakMb: unread ? null : peakMb, memoryReadings: memory.readings, memoryMisses: memory.misses,
    nodeArgs, ...idle && { idle }, ...reportsFrom && reportsTo && { account: accountRate(reportsFrom, reportsTo, (probedTo - probedFrom) / 60_000) }, ...snapshotsTaken.length && { snapshots: snapshotsTaken }, ...rss && { rss }, ...gc && { gc },
    ...profile && {
      profile,
      slices: { count: found.length, totalMs: found.reduce((sum, slice) => sum + slice.ms, 0), longest: [...found].sort((a, b) => b.ms - a.ms).slice(0, 15) },
      heldBy: heldBy(found),
      // What telling the account this host's Sessions cost the host's thread, its calls included: the report's rows
      // (`session-report`), and keeping its Sessions' records in the account (`session-uploads`).
      accountWork: timeIn(profile, ["conversations/session-report.js", "conversations/session-uploads.js"]),
    },
  }
  const text = JSON.stringify(report, null, 2)
  if (values.out) writeFileSync(values.out, text)
  process.stdout.write(`${text}\n`)
  const Measured = z.object({ n: z.number(), p50: z.number(), p99: z.number(), max: z.number() })
  const measured = z.object({ late: Measured, spawn: Measured, chunk: Measured }).parse(JSON.parse(readFileSync(yardstickOut, "utf8")))
  const healthLimit = Math.max(HEALTH_FLOOR_MS, times * measured.late.p99)
  const readLimit = READ_TIMES * healthLimit
  const heldLimit = Math.round(HELD_MS + measured.late.max)
  const failures: string[] = []
  if (values["tool-heavy"] && (completedTools.size !== TOOL_TURNS || [...toolSteps.values()].some((count) => count !== TOOL_CALLS)))
    failures.push(`tool-heavy workload incomplete: ${completedTools.size}/${TOOL_TURNS} turns of ${TOOL_CALLS} calls`)
  for (const name of ["health", "reads"] as const) {
    const result = answers[name]
    if (result.failed) failures.push(`${name}: ${result.failed} of ${result.n} failed or passed the probe's timeout`)
  }
  if ((answers.health.max ?? Infinity) >= heldLimit) failures.push(`a health check waited ${answers.health.max} ms, ${HELD_MS} ms past the yardstick's worst ${measured.late.max} ms: the loop was held for seconds`)
  if ((answers.health.p99 ?? Infinity) > healthLimit) failures.push(`one health check in a hundred waited ${answers.health.p99} ms, past ${healthLimit} ms (${times} times the yardstick's ${measured.late.p99} ms)`)
  if ((answers.reads.p99 ?? Infinity) > readLimit) failures.push(`one read in a hundred waited ${answers.reads.p99} ms, past ${readLimit} ms`)
  if (peakLimit && peakMb > peakLimit) failures.push(`the host peaked at ${peakMb} MB, past ${peakLimit} MB`)
  if (peakLimit && unread) failures.push(`the host's memory can't be judged: ${unread}`)
  const row = (name: string, result: { p50: number | null; p99: number | null; max: number | null }, limit: string) => `| ${name} | ${result.p50} | ${result.p99} | ${result.max} | ${limit} |`
  const table = [
    `### bench:host-load (${values.scale}${values.host ? `, ${values.host}` : ""}): ${failures.length ? "failed" : "passed"}`,
    "",
    "| | p50 ms | p99 ms | max ms | fails at |",
    "|---|---|---|---|---|",
    row("host health check", answers.health, `p99 > ${healthLimit}, max >= ${heldLimit}`),
    row("host read (`mako:worktrees`)", answers.reads, `p99 > ${readLimit}`),
    row("a checkout's Git read (`mako:worktree-review`)", answers.checkoutReads, "-"),
    ...answers.sends ? [row("a message sent, until its harness asks the model (`--send`)", answers.sends, "-")] : [],
    row("yardstick's own loop (calibration)", measured.late, "-"),
    row("yardstick's spawn of git", measured.spawn, "-"),
    row("yardstick's 2,000-row JSON round trip", measured.chunk, "-"),
    "",
    `Host peak resident memory: ${unread ? `unmeasured (${unread})` : `${peakMb} MB`}${peakLimit ? `, fails past ${peakLimit} MB` : ""}.`,
    `Loop held in slices of 50 ms or more: ${report.slices ? `${report.slices.count} slices, ${report.slices.totalMs} ms` : "not profiled"}.`,
    ...failures.map((failure) => `- **${failure}**`),
  ].join("\n")
  say(table)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`)
  for (const failure of failures) say(`FAIL ${failure}`)
  await finish(failures.length && !values["report-only"] ? 1 : 0)
} catch (error) {
  say(`bench:host-load failed: ${error instanceof Error ? error.stack : String(error)}`)
  host?.kill("SIGKILL")
  await finish(1)
}

/** What the account took of the host's Sessions reports over the probed window, a minute's worth. */
function accountRate(from: AccountReports, to: AccountReports, minutes: number) {
  const per = (key: keyof AccountReports) => Math.round(((to[key] - from[key]) / minutes) * 10) / 10
  return { frames: to.frames - from.frames, framesPerMin: per("frames"), rowsPerMin: per("rows"), gonePerMin: per("gone"), kbPerMin: Math.round(per("bytes") / 102.4) / 10 }
}

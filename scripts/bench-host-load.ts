import { execFileSync, fork, spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { invokeRuntime, probeRuntime, subscribeRuntime } from "@mako/host/transport/connection"
import { runtimeLocation } from "@mako/host/transport/service"
import { HOST_NODE_OPTIONS } from "@mako/host/base/process-warnings"
import { heldBy, slices, timeIn } from "./lib/cpu-slices.ts"
import { readResident, unmeasured, type ResidentMemory } from "./lib/host-load-memory.ts"
import { claudeSessionPath, makeWorld, PERSON, TODAY, type WorldScale } from "./lib/host-load-world.ts"
import { recordedRun, SeriesSchema, threadProfile, ThreadRecordingSchema, type Phase } from "./lib/host-load-holds.ts"
import { bySource } from "./lib/host-load-sources.ts"
import { ownedScratch } from "./lib/owned-scratch.mjs"
import { once } from "node:events"
import { scriptedModel } from "./scripted-model.ts"
import { SCRIPTED_GETS } from "./scripted-harness-env.ts"
import { hostLoadOutcome, type HostLoadExit } from "./lib/host-load-exit.ts"
import { fakeCloud, type AccountReports } from "./lib/sync-bench-cloud.ts"
import { createMakoBridge } from "@mako/host/contracts/renderer-bridge"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { LiveHistoryRead } from "@mako/host/contracts/live-history"
import { WINDOW_LIVE_FORM } from "@mako/protocol/live-form"
import { followHostLoadOutputs } from "./lib/host-load-output.ts"

/**
 * Whether the host keeps answering while many Fins work: `npm run bench:host-load`.
 *
 * A real host (this checkout's build, or `--host <mako-host.js>` for another's) runs isolated in a scratch home on a
 * world shaped as the person's Mac was the day it stalled (`TODAY`: 52 Threads' worktrees of a two-repository
 * project, 95 apps with 24 running, some 850 processes, a rail of sessions). Its Fins work all through: each edits
 * files in its worktrees a few times a second and appends the call to its transcript, builds now and then and runs
 * tests that churn the temporary folder. Three windows ask what the renderer asks (the worktrees' summaries every
 * half minute and as focus moves between them, the apps' marks once, then as the host pushes them, and each followed
 * folder's app every half minute). Each visible output follows its returned cursor through the production reader,
 * with one log append per second; current hosts must establish output hints and deliver an observed append before
 * measurement and after it. `--legacy-output` is only for a pinned host predating hints and uses its 500 ms poll.
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
 * (`GITHUB_STEP_SUMMARY`) whether it passes or not; `--report-only` relaxes the performance budgets, while a host that crashed or didn't quit still fails the run, `--idle-only` included. `--cpu-prof <dir>` keeps the host's CPU profile and
 * prints the longest slices it held the loop for, named by the host's own functions; `--out <file>` keeps the report;
 * `--peak-limit-mb` fails on the host's peak resident memory, sampled each second, and on readings too few to say. Memory barely varies between
 * machines: 629 MB on a Mac and 669 MB on a CI runner at this scale, so `checks.yml` sets 1,500;
 * `--home-from <home>` runs on APFS clones of a real home's harness stores (macOS, read-only to the original).
 * `--send` times each message from the call until its harness asks the model, reporting p50, p95, p99 and every
 * sample (`sendSamples`, and per send `sendDetails`: its request, when the host accepted it and when the model heard
 * it); `--harness claude`, `--harness opencode` or `--harness grok` sends through a sealed Claude Code, OpenCode or Grok instead of Codex,
 * while the Fins stay on Codex.
 *
 * `--record <dir>` keeps what the host's own thread did all through, by stretch of the run: its start (spawn until its
 * catalog and rail answer), a quiet baseline (`--idle`), the measured seconds, and a burst after them (`--burst
 * <seconds>`: every `--working` Fin ends its turn at once while a window opens the longest conversation and lists each
 * seeded Apex). A recorder inside the host (`host-load-recorder.mjs`) keeps every gap of 20 ms or more between two
 * 5 ms ticks with the work open in it; the run's CPU profile names the function on the thread in each
 * (`host-load-holds.ts`), and the yardstick's delay is cut to the same stretches. `--scale person` is the world of the
 * person's host on 2026-11-17 (`PERSON`); `--working <n>` starts n Codex Fins under its seeded Apexes, each streaming
 * text at a model's pace and patching a file, turn after turn, until the burst. `--send-every` and `--probe-every`
 * slow the timed sends and the stress probes to what a person and a window ask.
 *
 *   npm run bench:host-load [-- --scale today|ci|person] [--seconds 60] [--warmup 20] [--host <mako-host.js>] [--cpu-prof <dir>] [--out <file>] [--keep]
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
    harness: { type: "string", default: "codex" },
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
    // For an explicitly pinned host predating output hints; current hosts must prove the hinted path.
    "legacy-output": { type: "boolean", default: false },
    record: { type: "string" },
    working: { type: "string", default: "0" },
    burst: { type: "string", default: "0" },
    "send-every": { type: "string", default: "3000" },
    "probe-every": { type: "string", default: "20,100" },
    // How the working Fins wake their Apex: `never` unless given (`decisions`, `always`).
    wake: { type: "string", default: "never" },
    // The budget of a recorded run (`bench:host-person`): the steady busy share and the longest hold it may reach.
    "max-busy": { type: "string" },
    "max-hold-ms": { type: "string" },
    // And the longest hold the thread spent computing (its own CPU time in the gap): what the host's code did, apart
    // from a write or a read it waited on.
    "max-run-ms": { type: "string" },
    // The host's niceness, 5 as it always ran here; 0 runs it as the yardstick runs, to tell a hold that is the host's
    // from one that is the machine not running a lowered process.
    nice: { type: "string", default: "5" },
    // A recorded run without the CPU profile: its holds have no function, only their length and the thread's own CPU
    // time, to tell what the sampler itself adds (it stops the thread it samples).
    "no-profile": { type: "boolean", default: false },
    // `NAME=value` for the host's environment, which otherwise takes none of this process's `MAKO_` settings: a
    // switch to measure with and without (`MAKO_JOURNAL_WRITER=0`).
    "host-env": { type: "string", multiple: true },
  },
})
/** The harness the timed sends go through (`--harness`). */
const harness = z.enum(["codex", "claude", "opencode", "grok"]).parse(values.harness)
const say = (line: string) => process.stderr.write(`${line}\n`)
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms))
const SCALES = {
  today: TODAY,
  ci: { threads: 29, fins: [6, 6, 4, 3, 2, 2], files: [1500, 2200], apps: 95, running: 24, processes: 400, sessions: 600 },
  /** For changing the bench itself. */
  tiny: { threads: 2, fins: [1], files: [60, 60], apps: 3, running: 1, processes: 4, sessions: 5 },
  person: PERSON,
  /** `person` in small, for changing what `--record` does; its first tree is past a tree's hourly limit on starts. */
  "tiny-person": { threads: 4, fins: [2, 1], files: [60, 60], apps: 3, running: 1, processes: 4, sessions: 20, olderSessions: 40, trees: [125, 5], journalsMb: [6, 1] },
} satisfies Record<string, WorldScale>
const scale: WorldScale = z.enum(["today", "ci", "tiny", "person", "tiny-person"]).transform((name) => SCALES[name]).parse(values.scale)
const hostScript = resolve(values.host ?? join(import.meta.dirname, "../packages/host/dist/mako-host.js"))
if (!existsSync(hostScript)) throw new Error(`${hostScript} isn't built: npx tsgo -b packages/host`)
const budget = Number(values["budget-ms"])
/** `--record <dir>`: where the run's recording, its profiles, every hold and the host's log are kept. */
const record = values.record && resolve(values.record)
if (record) mkdirSync(record, { recursive: true })
/** The host's peak resident memory this run may reach; 0 reports it without judging. */
const peakLimit = Number(values["peak-limit-mb"])
const times = Number(values.times)
/**
 * A health check this much slower than the yardstick's worst wait is the loop held for seconds, as the day it stalled:
 * a runner that stops every process at once stops the yardstick as long, so its stall isn't the host's.
 */
const HELD_MS = 2_000
const CleanupCodeSchema = z.object({ code: z.enum(["EACCES", "EPERM", "ENOENT", "ESRCH", "EIO", "EBUSY", "ENOTEMPTY", "ENOTDIR"]) })
/** One health check in a hundred may wait this long whatever the yardstick says: below it a runner's noise decides. */
const HEALTH_FLOOR_MS = 150
/** A read does work of its own (a hundred worktrees looked at), so it may take this many health checks' limits. */
const READ_TIMES = 10

if (values["tool-heavy"] && (!values.send || Number(values.fins) > 0))
  throw new Error("--tool-heavy requires --send and no --fins")

const scratch = ownedScratch("mako-host-load-", { root: values.root, keep: values.keep })
const root = scratch.path
const children: ChildProcess[] = []
const outputFollowers: Awaited<ReturnType<typeof followHostLoadOutputs>>[] = []
const outputStreams: (() => void)[] = []
let host: ChildProcess | undefined
let releaseWorld: () => void | Promise<void> = () => {}
let closeModel: () => Promise<void> = async () => {}
let closeCloud: () => Promise<void> = async () => {}
let finishing: Promise<never> | undefined
const stopChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (!child.pid) throw new Error("The owned child's start is unconfirmed.")
  const reaped = once(child, "exit")
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    child.kill("SIGKILL")
    await Promise.race([reaped, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("The owned child did not exit after its stop.")), 10_000) })])
  } catch (error) {
    void reaped.catch(() => {})
    throw error
  } finally { clearTimeout(timer) }
}
const finish = (code: number): Promise<never> => {
  finishing ??= Promise.resolve().then(async () => {
    let failed = false
    const attempt = async (stage: string, work: () => void | boolean | Promise<void>) => {
      try { await work() } catch (error) {
        failed = true
        let reason = "unknown", code = "unknown"
        try {
          if (error instanceof Error) {
            reason = error.message.includes("still in use") ? "in-use" : error.message.includes("inspection") ? "inspection" : error.message.includes("identity changed") ? "identity" : "cleanup"
            const parsed = CleanupCodeSchema.safeParse(error.cause ?? error)
            if (parsed.success) code = parsed.data.code
          }
        } catch { /* Diagnostics never replace cleanup. */ }
        say(`bench:host-load cleanup failed at ${stage} (${reason}, ${code}); scratch is kept if its guards cannot prove it unused`)
      }
    }
    for (const following of outputFollowers) await attempt("output reader close", following.close)
    for (const release of outputStreams) release()
    await Promise.all([...new Set([...(host ? [host] : []), ...children])].map(child => attempt("child stop", () => stopChild(child))))
    await attempt("world release", releaseWorld)
    await attempt("model close", closeModel)
    await attempt("cloud close", closeCloud)
    await attempt("scratch removal", () => scratch.dispose())
    process.exit(code || (failed ? 1 : 0))
  })
  return finishing
}

try {
const began = performance.now()
const world = await makeWorld(root, scale)
releaseWorld = world.release
say(`world: ${root}`)
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


/** What the world holds, for a recorded run's report: its worktrees, its seeded trees, and its journals by size. */
const journalSizes = existsSync(join(world.dataRoot, "conversations")) ? readdirSync(join(world.dataRoot, "conversations")).filter((name) => name.endsWith(".sqlite")).map((name) => statSync(join(world.dataRoot, "conversations", name)).size / 1_048_576).sort((a, b) => a - b) : []
const worldSaid = {
  checkouts: world.checkouts.length, worktrees: world.checkouts.reduce((sum, checkout) => sum + checkout.repositories.length, 0), files: scale.files,
  trees: world.trees.map((tree) => tree.fins), long: world.long.map((long) => [long.megabytes, long.fileMb]), sessions: scale.sessions + (scale.olderSessions ?? 0),
  journals: {
    count: journalSizes.length, totalMb: Math.round(journalSizes.reduce((sum, size) => sum + size, 0)), medianMb: Math.round((journalSizes[Math.floor(journalSizes.length / 2)] ?? 0) * 100) / 100,
    over1Mb: journalSizes.filter((size) => size >= 1).length, over10Mb: journalSizes.filter((size) => size >= 10).length, over100Mb: journalSizes.filter((size) => size >= 100).length, largestMb: Math.round(journalSizes.at(-1) ?? 0),
  },
}
if (record) say(`world holds ${JSON.stringify(worldSaid)}`)

/** With `--send`: when the stand-in model first heard each `BENCH-S<n>` message, by its tag. */
const heardAt = new Map<string, number>()
const completedTools = new Set<string>()
const toolSteps = new Map<string, number>()
const TOOL_CALLS = 64
const TOOL_TURNS = 13
const LiveStateStatus = z.object({ status: z.string() }).loose()
/** With `--fins <n>` (and `--send`): the Apex the sends go to starts this many Fins, each a Codex turn, before the probe. */
const finCount = Number(values.fins)
/** With `--working <n>`: Fins started under the seeded Apexes that work turn after turn until the burst. */
const workingCount = Number(values.working)
if (workingCount > 0 && !world.trees.length) throw new Error("--working needs a scale with seeded Apexes (--scale person)")
/** Each working Fin's steps so far, whether the burst has begun, and the Fins waiting at its gate to end together. */
const workSteps = new Map<string, number>()
const workDone = new Set<string>()
const gate = { bursting: false, waiting: new Set<string>(), open: () => {} }
/** The working Fins' conversations, to say whose journal commits were slow. */
const workingConversations = new Set<string>()
const gateOpened = new Promise<void>((opened) => { gate.open = opened })
const WORK_WORDS = "reading the module and its callers then changing the one function that decides it and running the checks again before the next part".split(" ")
const workText = (seed: number, words: number) => Array.from({ length: words }, (_, index) => WORK_WORDS[(seed * 7 + index * 13) % WORK_WORDS.length]).join(" ")
// `--account`: the host signs in to the protocol's fake gateway in this process, which counts what it reports of its
// Sessions (frames, rows, bytes), so the account's message rate is measured beside the loop.
const cloud = values.account ? await fakeCloud() : undefined
if (cloud) {
  closeCloud = () => cloud.close()
  await cloud.account()
  mkdirSync(join(world.dataRoot, "cloud"), { recursive: true, mode: 0o700 })
  // Signed in for the account only: no harness sign-ins shared, no login item installed.
  writeFileSync(join(world.dataRoot, "cloud", "sign-ins.json"), JSON.stringify({ version: 2, sharing: false, accessOnly: true, inStep: {} }), { mode: 0o600 })
  mkdirSync(join(world.home, ".mako"), { recursive: true })
  writeFileSync(join(world.home, ".mako", "syncd-login-optout"), "")
}
const model = values.send || finCount > 0 || workingCount > 0 ? await scriptedModel({
  ...values["model-port"] && { port: z.coerce.number().int().min(1).max(65535).parse(values["model-port"]) },
  // What a harness reads before it asks (Grok's model list), as the live tests' stand-in answers it.
  answers: SCRIPTED_GETS,
  reply: async (heard) => {
    for (const match of heard.matchAll(/BENCH-([SFW]\d+)/g)) if (!heardAt.has(match[1]!)) heardAt.set(match[1]!, performance.now())
    const worker = [...heard.matchAll(/BENCH-(W\d+)/g)].at(-1)?.[1]
    if (worker) {
      if (workDone.has(worker)) return { text: "Done." }
      if (gate.bursting) {
        // Every working Fin ends in the same moment: each waits here until all have asked, or eight seconds.
        gate.waiting.add(worker)
        if (gate.waiting.size >= workSteps.size) gate.open()
        await Promise.race([gateOpened, delay(8_000)])
        workDone.add(worker)
        return { text: "Done." }
      }
      const step = (workSteps.get(worker) ?? 0) + 1
      workSteps.set(worker, step)
      // A model's wait for its first token, then thinking and an answer at 40 tokens a second, then a file patched.
      await delay(1_000 + Math.random() * 2_500)
      const lines = Array.from({ length: 96 }, (_, line) => `+export const v${line} = ${step * 128 + line}`).join("\n")
      return {
        reasoning: workText(step, 60), text: workText(step + 3, 140), pace: 25,
        call: { id: `work_${worker}_${step}`, name: "apply_patch", input: `*** Begin Patch\n*** Add File: app/host-load-${worker}-${step}.ts\n${lines}\n*** End Patch\n` },
      }
    }
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
  closeModel = () => model.close()
  // A sealed Codex in the scratch home, answered by the stand-in: a real send's way through the host, no account.
  mkdirSync(join(world.home, ".codex"), { recursive: true })
  writeFileSync(join(world.home, ".codex", "config.toml"), `openai_base_url = "${model.url}/v1"\nchatgpt_base_url = "${model.url}/backend-api"\n\n[features]\nplugins = false\n`)
  writeFileSync(join(world.home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "mako-host-load" }), { mode: 0o600 })
  // And a sealed Claude Code, through the settings its own login reads (`--harness claude`), as `pointAt` points it.
  mkdirSync(join(world.home, ".claude"), { recursive: true })
  writeFileSync(join(world.home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "mako-host-load", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } }), { mode: 0o600 })
  writeFileSync(join(world.home, ".claude.json"), "{}")
}

  const { directory, socket } = runtimeLocation(world.dataRoot)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(MAKO_|CLAUDE_|CODEX_HOME|CURSOR_|GROK_|XAI_)/.test(name)))
  const profileDir = values["cpu-prof"] ? resolve(values["cpu-prof"]) : record && !values["no-profile"] ? join(record, "profiles") : undefined
  if (profileDir) mkdirSync(profileDir, { recursive: true })
  // `--node-arg` passes options to the host's Node (a heap limit, `--heap-prof`); `--gc` traces its collections.
  // The host's own options first, as the app starts it (`hostCommand`): the program's first line isn't read when Node runs it.
  // `--heap-snapshots <dir>`: the host writes a heap snapshot there on SIGUSR2, after a full collection, as each send
  // `--snapshot-sends` names is answered ("20,80"), to tell what the host keeps per send from what it collects.
  const snapshots = values["heap-snapshots"] && resolve(values["heap-snapshots"])
  if (snapshots) mkdirSync(snapshots, { recursive: true })
  const nodeArgs = [...HOST_NODE_OPTIONS, ...(values["node-arg"] ?? []), ...(values.gc ? ["--trace-gc"] : []), ...(snapshots ? ["--heapsnapshot-signal=SIGUSR2"] : []),
    ...(record ? ["--import", join(import.meta.dirname, "lib/host-load-recorder.mjs")] : [])]
  // A recorded run's yardstick runs from before the host starts, every tick kept, so each stretch has its own.
  const yardstickOut = join(root, "yardstick.json")
  const startYardstick = () => {
    const started = spawn(process.execPath, [join(import.meta.dirname, "lib/host-load-yardstick.mjs"), yardstickOut, "300", ...(record ? ["series"] : [])], { stdio: ["ignore", "inherit", "inherit"] })
    children.push(started)
    return started
  }
  const earlyYardstick = record ? startYardstick() : undefined
  if (earlyYardstick) await delay(1_500)
  const phases: Phase[] = []
  const spawnedAt = Date.now()
  host = spawn("nice", ["-n", values.nice, process.execPath, ...nodeArgs, ...(profileDir ? ["--cpu-prof", "--cpu-prof-dir", profileDir, "--cpu-prof-interval", "1000"] : []), hostScript], {
    // Claude Code's config folder named outright: its login, and so its keychain item, are the world's own
    // (`Claude Code-credentials-<hash of the folder>`), never the person's.
    env: { ...env, HOME: world.home, TMPDIR: world.temporary, MAKO_DATA_ROOT: world.dataRoot, ...harness === "claude" && { CLAUDE_CONFIG_DIR: join(world.home, ".claude") },
      // A sealed OpenCode (`--harness opencode`): Anthropic's models only, through the stand-in, as `pointAt` points it.
      ...harness === "opencode" && model && {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: ["anthropic"], provider: { anthropic: { options: { baseURL: `${model.url}/v1`, apiKey: "mako-host-load" } } } }),
        OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
      // A sealed Grok (`--harness grok`): its home the world's, its key and every endpoint the stand-in's, as `pointAt` points it.
      ...harness === "grok" && model && {
        GROK_HOME: join(world.home, ".grok"), XAI_API_KEY: "mako-host-load", GROK_DISABLE_AUTOUPDATER: "1",
        GROK_XAI_API_BASE_URL: `${model.url}/v1`, GROK_CLI_CHAT_PROXY_BASE_URL: `${model.url}/v1`, GROK_MODELS_BASE_URL: `${model.url}/v1`,
      }, MAKO_WEB_SOCKET: socket, MAKO_PROD: "1", MAKO_TELEMETRY: "off", ...Object.fromEntries((values["host-env"] ?? []).map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)])), ...finCount > 0 && { MAKO_FIN_SLOTS: "8" }, ...workingCount > 0 && { MAKO_FIN_SLOTS: String(workingCount + 2) }, ...record && { MAKO_HOST_LOAD_RECORD: record }, ...cloud && { MAKO_CLOUD_URL: cloud.url } },
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
  const exited = new Promise<HostLoadExit>((done) => host!.once("exit", (code, signal) => done({ code, signal, timedOut: false })))
  const quitDeadline = () => delay(60_000).then((): HostLoadExit => ({ code: null, signal: null, timedOut: true }))
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
  const healthAt = Date.now()
  const client = randomUUID()
  const call = (channel: string, ...args: unknown[]) => invokeRuntime(socket, client, channel, args, 1, { timeoutMs: 600_000 })
  for (const deadline = Date.now() + 180_000; ; await delay(500)) {
    const listed = z.object({ ready: z.boolean() }).loose().parse(await call("mako:threads"))
    if (listed.ready) break
    if (Date.now() > deadline) throw new Error("the host hasn't read its catalog within three minutes")
  }
  const catalogAt = Date.now()
  // What a window draws first: the rail, and the worktrees' summaries.
  const rail = z.object({ threads: z.array(z.json()) }).loose().parse(await call("mako:threads")).threads.length
  const railAt = Date.now()
  if (record) await call("mako:worktree-summaries")
  const startedAt = Date.now()
  phases.push({ name: "start", from: spawnedAt, to: startedAt })
  const start = { healthMs: healthAt - spawnedAt, catalogMs: catalogAt - spawnedAt, railMs: railAt - spawnedAt, summariesMs: startedAt - spawnedAt, rail }
  // The same reads the burst asks, with nothing else going on: what each costs by itself, apart from what it waits behind.
  const alone = async (channel: string, ...args: unknown[]) => {
    const at = performance.now()
    await call(channel, ...args).catch(() => undefined)
    return Math.round((performance.now() - at) * 10) / 10
  }
  const listsAlone: number[] = []
  const quiet = record ? { railMs: await alone("mako:threads"), listMs: listsAlone } : undefined
  if (quiet) for (const tree of world.trees) for (let again = 0; again < 2; again += 1) listsAlone.push(await alone("mako:agents-list", { kind: "agent", session: tree.session }, { scope: "all" }))
  if (quiet) say(`alone: the rail ${quiet.railMs} ms; each Apex's list, twice, ${quiet.listMs.join(", ")} ms`)
  say(`host ready in ${Math.round(performance.now() - began)} ms: /health ${start.healthMs} ms after its spawn, its catalog ${start.catalogMs} ms, a rail of ${rail} ${start.railMs} ms`)
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
  let idle: { hostPercent: number; from: number; to: number; jobRuns: number; loopChecks: number; jobs: Record<string, number> } | undefined
  if (values.idle || values["idle-only"]) {
    // What woke the idle host: each recurring job's runs, and the event loop watch's checks, from `/health`.
    const wakeups = async () => {
      const probe = await probeRuntime(socket)
      const info = probe.state === "ready" ? probe.info : undefined
      return { jobs: new Map((info?.jobs ?? []).map((job) => [job.name, job.runs])), checks: info?.eventLoop?.delayMs.checks ?? 0 }
    }
    const cpuSeconds = () => {
      const time = spawnSync("ps", ["-o", "time=", "-p", hostPid], { encoding: "utf8" }).stdout.trim()
      return time.split(":").reduce((sum, part) => sum * 60 + Number(part), 0)
    }
    await delay(30_000)
    const [fromCpu, from, before] = [cpuSeconds(), Date.now(), await wakeups()]
    await delay(60_000)
    const [toCpu, to, after] = [cpuSeconds(), Date.now(), await wakeups()]
    const jobs = Object.fromEntries([...after.jobs].map(([name, runs]) => [name, runs - (before.jobs.get(name) ?? 0)] as const).filter(([, runs]) => runs > 0).sort((a, b) => b[1] - a[1]))
    const jobRuns = Object.values(jobs).reduce((sum, runs) => sum + runs, 0)
    idle = { hostPercent: Math.round(((toCpu - fromCpu) / ((to - from) / 1000)) * 1000) / 10, from, to, jobRuns, loopChecks: after.checks - before.checks, jobs }
    phases.push({ name: "baseline", from, to })
    say(`idle: the host used ${idle.hostPercent}% of a core; ${jobRuns} job runs and ${idle.loopChecks} event loop checks in 60 s`)
    for (const [name, runs] of Object.entries(jobs)) say(`  ${String(runs).padStart(4)} ${name}`)
  }
  if (values["idle-only"]) {
    clearInterval(footprint)
    clearInterval(series)
    host.kill("SIGTERM")
    // A host that crashed or didn't quit fails the idle run too: it once waited out the deadline and passed either way.
    const shutdown = await Promise.race([exited, quitDeadline()])
    if (shutdown.timedOut) host.kill("SIGKILL")
    if (values.out) writeFileSync(values.out, JSON.stringify({ scale: values.scale, host: hostScript, nodeArgs, idle, shutdown }, null, 2))
    const outcome = hostLoadOutcome(shutdown, [], values["report-only"])
    for (const failure of outcome.failures) say(`FAIL ${failure}`)
    await finish(outcome.code)
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
  const hintEvent = values["legacy-output"] ? undefined : z.object({ type: z.literal("view-hint"), hint: (await import("@mako/host/contracts/view-hints")).ViewHintSchema })
  const outputProbes: { following: Awaited<ReturnType<typeof followHostLoadOutputs>>; append(marker: string): void; writes: number }[] = []
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

    // One selected output dock per window; the other followed folders are app strips.
    const shown = world.appOutputs.filter(output => output.cwd === mine[0])
    if (!shown.length) continue
    const outputClient = randomUUID(), listeners = new Set<(event: HostEvent) => void>()
    let streamReady!: () => void
    const ready = new Promise<void>(resolve => { streamReady = resolve })
    const stop = subscribeRuntime(socket, outputClient, packet => {
      if (packet.channel === "ready") streamReady()
      if (packet.channel !== "event" || !hintEvent) return
      const event = hintEvent.safeParse(JSON.parse(packet.payload))
      if (event.success) for (const listener of listeners) listener(event.data)
    }, () => { windowFailures++ }, { history: true, live: WINDOW_LIVE_FORM })
    outputStreams.push(stop)
    let streamDeadline: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([ready, new Promise<never>((_resolve, reject) => {
        streamDeadline = setTimeout(() => reject(new Error("The output window's event stream did not become ready")), 30_000)
      })])
    } finally { clearTimeout(streamDeadline) }
    const bridge = createMakoBridge({
      invoke: async <Result>(channel: string, ...args: unknown[]) => {
        windowCalls++
        try {
          // SAFETY: this bridge calls the owned host's generated method contract, as its normal socket transport does.
          return await invokeRuntime(socket, outputClient, channel, args, 1, { timeoutMs: 30_000 }) as Result
        } catch (error) { windowFailures++; throw error }
      },
      onEvent: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
      onTerminalEvent: () => () => {}, pathForFile: () => null, resolveFileUrl: url => url,
    })
    const following = await followHostLoadOutputs(bridge, shown, values["legacy-output"])
    outputFollowers.push(following)
    await following.ready()
    const output = { following, writes: 0, append: (marker: string) => { for (const file of shown) appendFileSync(file.file, marker) } }
    outputProbes.push(output)
    await following.appended(`host-load window ${w} initial append\n`, () => output.append(`host-load window ${w} initial append\n`))
    timers.push(setInterval(() => { output.append(`host-load window ${w} tick ${++output.writes}\n`) }, 1_000))
  }
  // Focus moving between windows: each focus refreshes that window's summaries.
  timers.push(setInterval(() => ask("mako:worktree-summaries"), 10_000))

  // A message the person sends, timed from the call until its harness asks the model: what waits behind the load
  // (its checkpoint's Git reads, the loop) is in it, the harness's own start isn't (it's running already). Codex's,
  // unless `--harness claude`: harnesses wait on their turn's checkpoint in different places, so each is timed.
  const sends: [number, number | null][] = []
  const sendDetails: { tag: string; request: string; acceptedMs: number | null; modelMs: number | null }[] = []
  let conversation: string | undefined
  if (workingCount > 0) {
    // Each under a seeded Apex in proportion to its tree, in a checkout the churn edits too, never waking the Apex:
    // its harness is the seed's script, which a real host can't resume.
    const all = world.trees.reduce((sum, tree) => sum + tree.fins, 0)
    for (let i = 0, of = 0, within = world.trees[0]!.fins; i < workingCount; i += 1) {
      while (of < world.trees.length - 1 && (i / workingCount) * all >= within) within += world.trees[++of]!.fins
      const started = z.object({ refused: z.string().optional(), conversation: z.string().optional() }).loose().parse(await call("mako:agents-start", { kind: "agent", session: world.trees[of]!.session }, {
        brief: { objective: `BENCH-W${i} work on part ${i}.` }, harness: "codex", name: `work-${i}`, clientKey: `work-${i}`, cwd: fins[i % fins.length]!.path, mode: "background", wake: values.wake, queue: true,
      }))
      if (started.refused) throw new Error(`Working Fin ${i} was refused: ${JSON.stringify(started)}`)
      if (started.conversation) workingConversations.add(started.conversation)
    }
    say(`${workingCount} working Fins started; waiting for each to ask the model`)
    for (const deadline = Date.now() + 10 * 60_000; workSteps.size < workingCount; await delay(500))
      if (Date.now() > deadline) throw new Error(`only ${workSteps.size} of ${workingCount} working Fins asked the model in 10 minutes`)
  }
  if (values.send || finCount > 0) {
    conversation = randomUUID()
    // By default the send's checkout is one the Fins edit all through; `--send-quiet` takes one nothing edits but the send.
    const churned = (index: number) => world.checkouts[index]!.fin || index < scale.fins.length
    const quietAt = world.checkouts.findLastIndex((_, index) => !churned(index))
    const cwd = world.checkouts[values["send-quiet"] && quietAt >= 0 ? quietAt : 0]!.path
    await call("mako:live-start", harness, cwd, { conversationId: conversation, modeId: values["tool-heavy"] ? "access:full" : "access:ask", title: "Host load send", initialRequest: { id: randomUUID(), text: "BENCH-S0 start", attachments: [] } })
    for (const deadline = Date.now() + 180_000; !(values["tool-heavy"] ? completedTools : heardAt).has("S0"); await delay(100))
      if (Date.now() > deadline) throw new Error(`the bench's ${harness} never asked the stand-in model`)
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
  const yardstick = earlyYardstick ?? startYardstick()
  const probeOut = join(root, "probe.json")
  const prober = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "lib/host-load-probe.ts"), socket, probeOut, "mako:worktrees", ...z.tuple([z.string().regex(/^\d+$/), z.string().regex(/^\d+$/)]).parse(values["probe-every"].split(",")), "30000"], {
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
      await delay(Number(values["send-every"]))
      const tag = `S${n}`
      const began = performance.now()
      const request = randomUUID()
      let acceptedMs: number | null = null
      await call("mako:live-prompt", conversation, request, `BENCH-${tag} next`, []).then(() => { acceptedMs = Math.round((performance.now() - began) * 10) / 10 }, () => undefined)
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
      sendDetails.push({ tag, request, acceptedMs, modelMs })
      if (snapshots && snapshotAt.has(n)) await heapSnapshot(snapshots, `after send ${n}`)
    }
  })()
  say(`probing for ${values.seconds} s`)
  const probedFrom = Date.now()
  const reportsFrom = cloud?.reported?.()
  await delay(Number(values.seconds) * 1000)
  phases.push({ name: "steady", from: probedFrom, to: Date.now() })
  // The burst: every working Fin's turn ends in one moment, while a window opens the longest conversation and reads
  // it back a page at a time, and each seeded Apex's Fins are listed, as its own turn and its window's crew ask.
  let burst: { seconds: number; finsEnded: number; finsGated: number; openMs: number | null; pages: number; bytes: number; listMs: (number | null)[]; railMs: number | null } | undefined
  if (Number(values.burst) > 0) {
    const burstFrom = Date.now()
    gate.bursting = true
    // Its first read's milliseconds; below zero until it answers.
    const opened = { openMs: -1, pages: 0, bytes: 0 }
    const opening = (async () => {
      const long = world.long[0]
      if (!long) return
      // A window's read of history, whole: the answer comes in parts, each asked for by where the last one ended.
      const Part = z.object({ record: z.string(), data: z.string(), next: z.number().nullable() }).loose()
      const Window = z.object({ history: z.object({ token: z.string(), before: z.object({ blocks: z.number(), base: z.number() }).nullable() }).loose() }).loose()
      const read = async (input: LiveHistoryRead) => {
        let part = Part.parse(await call("mako:live-read", long.conversation, input))
        let text = part.data
        while (part.next !== null) {
          part = Part.parse(await call("mako:live-read", long.conversation, { kind: "part", record: part.record, offset: part.next }))
          text += part.data
        }
        opened.bytes += text.length
        return Window.safeParse(JSON.parse(text)).data
      }
      const at = performance.now()
      let view = await read({ kind: "snapshot" })
      opened.openMs = Math.round(performance.now() - at)
      for (; view?.history.before && opened.pages < 40 && Date.now() - burstFrom < Number(values.burst) * 1000; opened.pages += 1)
        view = await read({ kind: "earlier", token: view.history.token, before: view.history.before })
    })()
    const timed = async (work: () => Promise<void>) => {
      const at = performance.now()
      return work().then(() => Math.round(performance.now() - at), () => null)
    }
    const [railMs, ...listMs] = await Promise.all([
      timed(async () => { await call("mako:threads") }),
      ...world.trees.flatMap((tree) => [0, 1, 2].map(() => timed(async () => { await call("mako:agents-list", { kind: "agent", session: tree.session }, { scope: "all" }) }))),
    ])
    await opening.catch((error: Error) => say(`burst: the long conversation's read failed: ${error.message}`))
    await delay(Math.max(0, Number(values.burst) * 1000 - (Date.now() - burstFrom)))
    phases.push({ name: "burst", from: burstFrom, to: Date.now() })
    burst = { seconds: Number(values.burst), finsEnded: workDone.size, finsGated: gate.waiting.size, pages: opened.pages, bytes: opened.bytes, openMs: opened.openMs < 0 ? null : opened.openMs, listMs, railMs: railMs ?? null }
    say(`burst: ${burst.finsEnded} of ${workingCount} working Fins ended (${burst.finsGated} together); the long conversation opened in ${burst.openMs} ms and ${burst.pages} earlier pages (${burst.bytes} characters); lists ${listMs.join(", ")} ms`)
  }
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
  await Promise.all(outputProbes.map(async (output, index) => {
    const marker = `host-load window ${index} final append\n`
    await output.following.appended(marker, () => output.append(marker))
    await output.following.close()
  }))
  for (const release of outputStreams) release()
  const outputs = outputProbes.map(output => ({ ...output.following.readings(), writes: output.writes }))
  clearInterval(footprint)
  clearInterval(series)
  const sampled = (performance.now() - sampling) / 1_000
  churn.kill("SIGKILL")
  host.kill("SIGTERM")
  const shutdown = await Promise.race([exited, quitDeadline()])
  if (shutdown.timedOut) host.kill("SIGKILL")
  const quit = hostLoadOutcome(shutdown, [], true)
  if (quit.code) throw new Error(`Scratch host failed its quit: ${quit.failures.join("; ")}`)

  const probed = z.object({ health: z.array(z.tuple([z.number(), z.number().nullable()])), reads: z.array(z.tuple([z.number(), z.number().nullable()])) }).parse(JSON.parse(readFileSync(probeOut, "utf8")))
  const summary = (times: [number, number | null][]) => {
    const answered = times.map(([, ms]) => ms).filter((ms): ms is number => ms !== null).sort((a, b) => a - b)
    const at = (share: number) => answered[Math.min(answered.length - 1, Math.floor(share * answered.length))] ?? null
    const over = times.filter(([, ms]) => ms === null || ms > budget).length
    return { n: times.length, failed: times.length - answered.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), p999: at(0.999), max: answered.at(-1) ?? null, overBudget: over, overShare: times.length ? over / times.length : 1 }
  }
  // One profile per thread: the main thread's is numbered 0 (`CPU.<date>.<time>.<pid>.0.<n>.cpuprofile`).
  const profile = profileDir && readdirSync(profileDir).filter((name) => (record ? new RegExp(`\\.${hostPid}\\.0\\.\\d+\\.cpuprofile$`) : /\.\d+\.0\.\d+\.cpuprofile$/).test(name)).map((name) => join(profileDir, name)).sort().at(-1)
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
  // A recorded run: every hold with its function goes to `holds.json` beside the report, and the host's log is kept.
  let recorded: Omit<ReturnType<typeof recordedRun>, "every"> | undefined
  let sources: ReturnType<typeof bySource> | undefined
  let slowCommits: Record<string, { count: number; ms: number; worstMs: number }> | undefined
  const overBudget: string[] = []
  let threads: { threadId: number; busyShare: number; delayMs: { p50: number; p99: number; max: number }; profile?: ReturnType<typeof threadProfile> }[] | undefined
  if (record && profile && profileDir) {
    const series = SeriesSchema.safeParse(z.object({ series: z.json() }).loose().safeParse(JSON.parse(readFileSync(yardstickOut, "utf8"))).data?.series).data
    const { every, ...rest } = recordedRun({ recording: join(record, `main-${hostPid}.json`), profile, phases, ...series && { yardstick: series } })
    recorded = rest
    // The budget, judged beside the yardstick as every limit here is: a hold counts past the limit by more than the
    // yardstick's own worst wait over the same stretch, so a machine that stopped every process fails nothing. The
    // host's start and its stop are not judged: what they hold is said, and nobody is streaming through them.
    const judged = new Set(["baseline", "steady", "burst"])
    if (values["max-hold-ms"]) {
      const limit = Number(values["max-hold-ms"])
      const over = every.filter((hold) => judged.has(hold.phase) && hold.ms > limit + (hold.yardstickMs ?? 0)).sort((a, b) => b.ms - a.ms)
      if (over.length) overBudget.push(`${over.length} holds past ${limit} ms outside start and stop; the longest ${over[0]!.ms} ms in ${over[0]!.phase}, in ${over[0]!.top}`)
    }
    if (values["max-run-ms"]) {
      const limit = Number(values["max-run-ms"])
      const over = every.filter((hold) => judged.has(hold.phase) && (hold.cpuMs ?? 0) > limit).sort((a, b) => (b.cpuMs ?? 0) - (a.cpuMs ?? 0))
      if (over.length) overBudget.push(`${over.length} holds in which the thread computed past ${limit} ms; the longest ${over[0]!.cpuMs} ms in ${over[0]!.phase}, in ${over[0]!.top}`)
    }
    if (values["max-busy"]) {
      const steady = rest.phases.find((phase) => phase.name === "steady")
      if (steady && steady.busyShare > Number(values["max-busy"])) overBudget.push(`the thread was busy ${Math.round(steady.busyShare * 1000) / 10}% of the steady stretch, past ${Number(values["max-busy"]) * 100}%`)
    }
    // Whose commits were slow: a working Fin's, a seeded Apex's (which takes its Fins' roster at rest), the timed sends'.
    const seededApexes = new Set(world.trees.map((tree) => tree.conversation))
    const whose = (id: string) => workingConversations.has(id) ? "working Fin" : seededApexes.has(id) ? "seeded Apex" : id === conversation ? "timed sends" : "another"
    const slowBy = new Map<string, { count: number; ms: number; worstMs: number }>()
    for (const commit of rest.commits?.slowOnes ?? []) {
      const key = `${whose(commit.conversation)}, ${commit.running ? "turn running" : "at rest"}, ${commit.background ? "worker checkpoints" : "own checkpoints"}`
      const held = slowBy.get(key) ?? { count: 0, ms: 0, worstMs: 0 }
      slowBy.set(key, { count: held.count + 1, ms: Math.round(held.ms + commit.ms), worstMs: Math.max(held.worstMs, commit.ms) })
    }
    slowCommits = Object.fromEntries(slowBy)
    sources = bySource(join(record, `main-${hostPid}.json`), profile, phases)
    writeFileSync(join(record, "holds.json"), JSON.stringify(every))
    threads = readdirSync(record).filter((name) => name.startsWith(`thread-${hostPid}-`)).map((name) => {
      const thread = ThreadRecordingSchema.parse(JSON.parse(readFileSync(join(record, name), "utf8")))
      const own = readdirSync(profileDir).find((each) => new RegExp(`\\.${hostPid}\\.${thread.threadId}\\.\\d+\\.cpuprofile$`).test(each))
      return { threadId: thread.threadId, busyShare: Math.round((thread.activeMs / Math.max(1, thread.activeMs + thread.idleMs)) * 1000) / 1000, delayMs: thread.delayMs, ...own && { profile: threadProfile(join(profileDir, own)) } }
    })
    const log = join(world.dataRoot, "logs", "host.log")
    if (existsSync(log)) copyFileSync(log, join(record, "host.log"))
  }
  const report = {
    scale: values.scale, host: hostScript, seconds: Number(values.seconds), fins: fins.length, windows, windowCalls, windowFailures,
    ...record && { world: worldSaid, start, ...quiet && { quiet }, phases, working: { fins: workingCount, steps: [...workSteps.values()].reduce((sum, steps) => sum + steps, 0) }, ...burst && { burst }, ...recorded && { recorded }, ...sources && { sources }, ...slowCommits && { slowCommits }, ...threads && { threads } },
    measuredWindow: { from: probedFrom, to: probedTo }, outputs,
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
  failures.push(...overBudget)
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
  await finish(1)
}

/** What the account took of the host's Sessions reports over the probed window, a minute's worth. */
function accountRate(from: AccountReports, to: AccountReports, minutes: number) {
  const per = (key: keyof AccountReports) => Math.round(((to[key] - from[key]) / minutes) * 10) / 10
  return { frames: to.frames - from.frames, framesPerMin: per("frames"), rowsPerMin: per("rows"), gonePerMin: per("gone"), kbPerMin: Math.round(per("bytes") / 102.4) / 10 }
}

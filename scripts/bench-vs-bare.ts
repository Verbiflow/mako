import "./lib/scratch-git.mjs"
/**
 * What each step of Mako's pipeline costs against the same harness run by itself: `npm run bench:vs-bare`.
 *
 * One scripted answer (`scripted-model.ts`: no account, nothing leaves this machine) is run two ways and timed on one
 * clock, the machine's monotonic one, which every process here reads (`process.hrtime`):
 *
 * A. Bare. The harness's own CLI in a sealed scratch home, in its streaming print mode (Claude Code: `-p` with
 *    `--input-format stream-json --output-format stream-json --verbose --include-partial-messages`, the build Mako
 *    itself runs). Cold is a new process and its first message, warm a second message to that process, wake a new
 *    process resuming that session (`--resume`).
 * B. Through Mako. This checkout's host (`packages/host/dist/mako-host.js`) on a scratch home and data root, the bench
 *    attached to its socket as a window is (`subscribeRuntime` in the window's live form, `mako:live-start`,
 *    `mako:live-prompt`). Cold is a new conversation's first message, warm its second, wake a message to it once the
 *    host hibernated its provider. Two other conversations finish a short turn before anything is measured, so the
 *    host has launched the harness before, as an app in use has; a host's very first launch is slower and isn't a
 *    scenario here. Their next turns leave the measured conversation the oldest past the warm limit, which is what
 *    hibernates it. No window prewarms it (`mako:live-prewarm`, which a person's typing sets off), so wake is the
 *    whole wake.
 *    The host's side of each boundary is stamped by a module loaded into it (`lib/bench-vs-bare-probe.mjs`), which
 *    hears the host's diagnostics channels: `mako:host-call`, `mako:live-stage`, `mako:native-frame`,
 *    `mako:live-driver-event`, `mako:live-batch-emitted`, `mako:stream-write` and `mako:host-log` (provider launch
 *    phases, checkpoints, residency). The model's side is stamped here, where the scripted model runs. A second
 *    reader attaches in the compact form, as the gateway's link reads: it hears the batches and none of the text a
 *    window is told ahead of them (`LiveAhead`), so its row is the pace a phone and the journal get.
 * C. Under load. B again while `--others` conversations work on the same host, each streaming text at the same pace
 *    and writing a file every few seconds for as long as the measurement runs. The bare runs of that pass run beside
 *    the same load, so the machine is as busy for both.
 *
 * The answer: `--words` of text at `--pace` ms a token (past `LONG_ANSWER_CHARS` in one block), a `Write` into the
 * scratch workspace, then more text. Each table row is a boundary, in the order it was reached: when (ms after the
 * send, the median of `--runs`), how long since the row before, and the same boundary bare where it has one. The
 * last block ranks what Mako adds. Nothing printed is assumed: a row with no measurement prints `-`.
 *
 * D, the renderer (`--renderer`), is designed and not built. It needs a browser and the app's bundle, and is about as
 * much work again as A to C. The design: `--json` already keeps every batch a window received, as the host wrote it
 * and when. `scripts/audit-render-performance.tsx` mounts the production panel on the mock bridge under a React
 * `Profiler` and feeds `applyLiveBatch`; a `replay` mode there would take those batches at their recorded spacing
 * and, for each, time `applyLiveBatch` plus the store's projection (`projectAcp` in `src/state/live-projection.ts`)
 * with `performance.now` around the call, the commit from the `Profiler`'s `actualDuration`, and the paint as the
 * `requestAnimationFrame` after that commit, with a `PerformanceObserver` on `longtask` for tasks past 50 ms. Run as
 * `bench-transcript-ui.mjs` runs its page (Vite, then Chromium over CDP), it would add four rows after "received by
 * the client": applied and projected, committed, painted, and the long tasks. What the composer does before it
 * calls the host (`settingsForSend`, `saveMessage` in `src/state/acp-queue.ts`) is renderer time too and is likewise
 * not measured here.
 *
 *   npm run bench:vs-bare -- [--harness claude] [--runs 5] [--others 0,5,15] [--pace 20] [--words 340] [--files 300]
 *                            [--gap 1500] [--scenarios cold,warm,wake] [--json <file>] [--renderer]
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { cpus, loadavg, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { setTimeout as delay } from "node:timers/promises"
import { parseArgs } from "node:util"
import { z } from "zod"
import { HOST_NODE_OPTIONS } from "@mako/host/base/process-warnings"
import { LIVE_AHEAD_MS, LIVE_FRAME_MS } from "@mako/host/contracts/live-conversations"
import { LONG_ANSWER_CHARS, LONG_ANSWER_FLUSH_MS } from "@mako/host/conversations/answer-pace"
import { claudeRuntime } from "@mako/host/harnesses/claude/runtime"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import { invokeRuntime, probeRuntime, subscribeRuntime } from "@mako/host/transport/connection"
import { runtimeLocation } from "@mako/host/transport/service"
import { COMPACT_LIVE_FORM, WINDOW_LIVE_FORM } from "@mako/protocol/live-form"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { processesUsingSync, removeScratchSync } from "./lib/scratch-processes.mjs"
import { assertScratchEnvironment, scratchKeychain, seedScratchHome, type ScratchHome } from "./scratch-harness-home.ts"
import { pointAt, SCRIPTED_GETS } from "./scripted-harness-env.ts"
import { scriptedModel, words, type ScriptedReply } from "./scripted-model.ts"

const { values } = parseArgs({
  options: {
    harness: { type: "string", default: "claude" },
    runs: { type: "string", default: "5" },
    others: { type: "string", default: "0,5,15" },
    pace: { type: "string", default: "20" },
    words: { type: "string", default: "340" },
    files: { type: "string", default: "300" },
    gap: { type: "string", default: "1500" },
    scenarios: { type: "string", default: "cold,warm,wake" },
    json: { type: "string" },
    renderer: { type: "boolean", default: false },
  },
})
const Scenario = z.enum(["cold", "warm", "wake"])
type Scenario = z.infer<typeof Scenario>
const RUNS = z.coerce.number().int().min(1).parse(values.runs)
const Others = z.coerce.number().int().min(0)
const OTHERS = values.others.split(",").map((count) => Others.parse(count))
const PACE = z.coerce.number().int().min(1).parse(values.pace)
const WORDS = z.coerce.number().int().min(40).parse(values.words)
const FILES = z.coerce.number().int().min(1).parse(values.files)
const GAP_MS = z.coerce.number().int().min(0).parse(values.gap)
const SCENARIOS = values.scenarios.split(",").map((name) => Scenario.parse(name))
const say = (line = "") => process.stdout.write(`${line}\n`)
const note = (line: string) => process.stderr.write(`${line}\n`)
/** Milliseconds on the machine's monotonic clock, which the host's probe and every child share. */
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000

/* ------------------------------------------------------------------ harnesses */

/** How one harness runs by itself, streaming: what A needs of it. */
interface BareHarness {
  /** The CLI, as Mako's own driver finds it. */
  executable(env: NodeJS.ProcessEnv): string | undefined
  /** A process that takes messages on its input and streams its answer; `resume` continues that session in a new one. */
  args(session: string, resume: boolean): string[]
  /** A message, as a line of its input. */
  message(text: string): string
  /** What a line of its output says: answer text, or that the turn ended. */
  read(line: string): { text?: string; ended?: boolean }
  /** The tool call that writes `content` to `path`. */
  write(id: string, path: string, content: string): NonNullable<ScriptedReply["call"]>
  /** Mako's mode with no approvals, so the write runs unasked on both sides. */
  mode: string
}

const ClaudeLine = z.union([
  z.object({ type: z.literal("stream_event"), event: z.object({ type: z.literal("content_block_delta"), delta: z.object({ type: z.literal("text_delta"), text: z.string() }) }) }).transform((line) => ({ text: line.event.delta.text })),
  z.object({ type: z.literal("result") }).transform(() => ({ ended: true })),
])

/** A harness `pointAt` can point at the scripted model, with its bare run still to write. */
const UNWIRED = "its bare run isn't written: A needs its CLI's streaming print mode, its input line, a reader of its output and its tool call for a write (one `BARE` entry here), and B and C were only run with Claude"

const BARE = {
  claude: {
    executable: (env) => claudeRuntime(env)?.executable,
    args: (session, resume) => [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--dangerously-skip-permissions", ...(resume ? ["--resume", session] : ["--session-id", session]),
    ],
    message: (text) => `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`,
    read: (line) => {
      try { return ClaudeLine.safeParse(JSON.parse(line)).data ?? {} } catch { return {} }
    },
    write: (id, path, content) => ({ id, name: "Write", arguments: { file_path: path, content } }),
    mode: "bypassPermissions",
  },
  codex: { skip: UNWIRED },
  opencode: { skip: UNWIRED },
  grok: { skip: UNWIRED },
  cursor: { skip: "it can't be pointed at the scripted model: `pointAt` has no stand-in for Cursor's service" },
  devin: { skip: "its stand-in is another server (`scripted-windsurf.ts`), which this bench doesn't drive" },
} satisfies Record<string, BareHarness | { skip: string }>

/** A table's entry for a name that came from outside it, if it has one. */
function entry<Value>(table: Readonly<Record<string, Value>>, name: string): Value | undefined {
  return Object.hasOwn(table, name) ? table[name] : undefined
}

/* ------------------------------------------------------------------- the answer */

const VOCABULARY = "the stream of a long answer lands one word after another and each batch carries what a reader sees next while the host keeps its journal and the window paints every frame it can so nothing waits behind work that could run later".split(" ")
/** `count` words of prose in paragraphs, the same every run: `seed` only moves where it starts in the vocabulary. */
function prose(count: number, seed: number): string {
  let text = ""
  for (let index = 0; index < count; index += 1) {
    const word = VOCABULARY[(index * 7 + seed) % VOCABULARY.length]!
    const last = index === count - 1
    const paragraph = (index + 1) % 85 === 0
    const sentence = (index + 1) % 17 === 0
    text += `${index % 17 === 0 ? word[0]!.toUpperCase() + word.slice(1) : word}${last || sentence ? "." : ""}${last ? "" : paragraph ? "\n\n" : " "}`
  }
  return text
}
const FIRST = prose(WORDS, 3)
const SECOND = prose(Math.max(20, Math.round(WORDS / 4)), 11)
const TOKENS = [...words(FIRST), ...words(SECOND)]
const FIRST_TOKENS = words(FIRST).length
/** Where each token ends in the answer's text, so a reader's count of characters says which tokens it holds. */
const ENDS = TOKENS.reduce<number[]>((ends, token) => [...ends, (ends.at(-1) ?? 0) + token.length], [])
const LOAD_STEP = Array.from({ length: 120 }, (_, index) => `~load${(index + 1) % 8 === 0 ? "\n\n" : " "}`).join("")

const ModelDelta = z.union([
  z.object({ type: z.literal("content_block_delta"), delta: z.object({ type: z.literal("text_delta"), text: z.string() }) }).transform((event) => event.delta.text),
  z.object({ type: z.literal("response.output_text.delta"), delta: z.string() }).transform((event) => event.delta),
])

/** One measured turn as the model saw it: when it heard each request, and when it wrote each token. */
interface ModelTurn { tag: string; file: string; heard: number[]; tokens: number[] }

/* --------------------------------------------------------------- what a run keeps */

interface Mark { key: string; at: number }
interface Sample {
  side: "bare" | "mako"
  scenario: Scenario
  others: number
  run: number
  /** The send: the call to the host, or the process's start or the write to its input. */
  sent: number
  /** Each boundary reached, in ms after `sent`. */
  marks: Mark[]
  /** For each token of the answer, ms after `sent`: written by the model, out of the harness, at the reader. */
  model: number[]
  harness: number[]
  reader: number[]
  /** The same for a reader of the batches alone, as a phone's link and the journal get them; empty bare. */
  device: number[]
  deviceArrivals: number[]
  /** When each batch (or bare, each output chunk) carrying answer text reached the reader. */
  arrivals: number[]
  /** Model's last token before the write to the request carrying its result. */
  toolMs: number | undefined
  notes: Record<string, string | number | null>
  raw: z.infer<typeof ProbeLine>[]
  batches: { at: number; revision: number; bytes: number; characters: number }[]
}

const ProbeLine = z.object({
  t: z.number(), s: z.string(), c: z.string().optional(), q: z.string().optional(), r: z.number().optional(),
  kind: z.string().optional(), evidence: z.string().optional(), client: z.string().optional(), bytes: z.number().optional(),
  u: z.array(z.tuple([z.string(), z.string().nullable(), z.number(), z.number()])).optional(),
  scope: z.string().optional(), message: z.string().optional(), status: z.string().optional(), connection: z.string().optional(),
  fields: z.record(z.string(), z.json()).optional(),
}).loose()
const Update = z.object({ kind: z.string(), id: z.string().optional(), text: z.string().optional(), replace: z.boolean().optional() }).loose()
const BatchBody = z.object({ id: z.string(), revision: z.number(), updates: z.array(Update).optional() }).loose()
const AheadLine = z.object({ type: z.literal("live-ahead"), ahead: z.object({ revision: z.number(), more: z.string() }) })
const BatchLine = z.union([z.object({ type: z.literal("live-batch"), batch: BatchBody }).loose().transform((line) => line.batch), BatchBody])
const Words = z.string()
const Amount = z.number()
const Catalog = z.object({ ready: z.boolean() }).loose()
const LiveState = z.object({ status: z.string(), connection: z.string().optional() }).loose()
const PhaseFields = z.object({ conversation: z.string(), phase: z.string(), state: z.string() }).loose()
const CheckpointFields = z.object({ request: z.string(), kind: z.string().optional(), heldMs: z.number().nullable().optional(), savedMs: z.number().optional(), waitedMs: z.number().optional() }).loose()

/** How much answer text a reader holds, from the updates it was given: each block's length, appended to or replaced. */
class Held {
  private readonly blocks: { kind: string; id: string | undefined; length: number }[] = []
  take(kind: string, id: string | undefined, length: number, replace: boolean): void {
    if (kind === "user") return
    const last = this.blocks.at(-1)
    if (kind === "more") {
      if (last) last.length += length
      return
    }
    if (kind !== "text" && kind !== "thinking") {
      this.blocks.push({ kind, id, length: 0 })
      return
    }
    const block = id === undefined ? (last?.kind === kind && last.id === undefined ? last : undefined) : this.blocks.findLast((each) => each.kind === kind && each.id === id)
    if (!block) this.blocks.push({ kind, id, length })
    else block.length = replace ? length : block.length + length
  }
  get characters(): number {
    return this.blocks.reduce((sum, block) => sum + (block.kind === "text" ? block.length : 0), 0)
  }
}

/** For each token, when a reader first held all of it, given how many characters it held at each moment. */
function tokenTimes(held: readonly { at: number; characters: number }[]): number[] {
  const times: number[] = []
  let next = 0
  for (const { at, characters } of held) while (next < ENDS.length && characters >= ENDS[next]!) times[next++] = at
  return times
}

/* -------------------------------------------------------------------- cleanup */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-vs-bare-")))
const children = new Set<ChildProcess>()
const homes: ScratchHome[] = []
const closers: (() => void | Promise<void>)[] = []
let finishing: Promise<never> | undefined

async function stopChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, "exit")
  child.kill("SIGTERM")
  const timer = setTimeout(() => child.kill("SIGKILL"), graceMs)
  await exited.catch(() => undefined)
  clearTimeout(timer)
}

/** Stops everything this run started and removes its scratch, however the run ends. */
function finish(code: number): Promise<never> {
  finishing ??= (async () => {
    let failed = false
    const began = Date.now()
    await Promise.all([...children].map((child) => stopChild(child, 20_000)))
    for (const close of closers.reverse()) await Promise.resolve().then(close).catch(() => { failed = true })
    // What a stopped host or CLI left running in the scratch folders is this run's too: named, then ended.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const left = processesUsingSync(root)
      if (!left.length) break
      note(`still running in the scratch folder after its owner stopped: ${left.map(({ pid }) => pid).join(", ")}; ending ${attempt ? "them again" : "them"}`)
      for (const { pid } of left) try { process.kill(pid, "SIGKILL") } catch { /* It ended meanwhile. */ }
      await delay(500)
    }
    for (const home of homes) home.dispose()
    try { removeScratchSync(root) } catch (error) {
      failed = true
      note(`scratch kept: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (Date.now() - began > 15_000) note(`cleaning up took ${Math.round((Date.now() - began) / 1000)} s`)
    process.exit(code || (failed ? 1 : 0))
  })()
  return finishing
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => void finish(130))

/* ---------------------------------------------------------------------- setup */

function makeProject(path: string): string {
  mkdirSync(path, { recursive: true })
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Bench", "-c", "user.email=bench", ...args], { cwd: path, stdio: "ignore" })
  git("init", "-q")
  for (let index = 0; index < FILES; index += 1) {
    const folder = join(path, "src", `part${index % 20}`)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `file${index}.ts`), `export const value${index} = ${index}\n${"// filler line\n".repeat(40)}`)
  }
  git("add", "-A")
  git("commit", "-qm", "initial")
  return path
}

/** A scratch home with no sign-in of the person's in it, pointed at the scripted model. */
async function sealedHome(folder: string, harness: string, url: string): Promise<ScratchHome> {
  mkdirSync(folder, { recursive: true })
  const home = seedScratchHome(folder, {})
  homes.push(home)
  mkdirSync(join(folder, "tmp"), { recursive: true })
  home.env.TMPDIR = join(folder, "tmp")
  await pointAt(harness, { root: folder, home: home.home, project: folder, env: home.env, scrub: (text) => text }, url, home.env, "bench-vs-bare")
  assertScratchEnvironment(home.env, `bench:vs-bare ${harness}`)
  return home
}

/* ----------------------------------------------------------------------- main */

async function main(): Promise<number> {
  const harness = values.harness
  const bare = entry<BareHarness | { skip: string }>(BARE, harness)
  if (values.renderer) say("--renderer: not built. The design is in this script's header; A to C run as usual.")
  if (!bare) {
    say(`${harness}: skipped, Mako has no harness of that name`)
    return 0
  }
  if ("skip" in bare) {
    say(`${harness}: skipped, ${bare.skip}`)
    return 0
  }
  const installed = createHarnessHost(detachedHarnessContext(new NativeStores(false))).liveDrivers.list().find((driver) => driver.provider === harness)?.available(process.cwd())
  if (!installed) {
    say(`${harness}: skipped, it isn't installed here (npx tsx scripts/harnesses-installed.ts)`)
    return 0
  }
  const cli: BareHarness = bare
  const hostScript = resolve(import.meta.dirname, "../packages/host/dist/mako-host.js")
  if (!existsSync(hostScript)) throw new Error(`${hostScript} isn't built: npx tsgo -b packages/host`)

  /* The model: one for both sides, stamping what it hears and writes. */
  const turns = new Map<string, ModelTurn>()
  const steps = new Map<string, number>()
  let recording: ModelTurn | undefined
  let loadStopped = false
  const loadHeard = new Set<string>()
  let loadFolder = root
  const reply = (heard: string): ScriptedReply => {
    const tag = [...heard.matchAll(/VS([MLF])-(\w+)/g)].at(-1)
    if (!tag) return { text: "~untagged" }
    const [name, kind] = tag
    const step = steps.get(name) ?? 0
    steps.set(name, step + 1)
    if (kind === "F") return { text: "~ok" }
    if (kind === "L") {
      loadHeard.add(name)
      return loadStopped ? { text: "~stopped" } : { text: LOAD_STEP, pace: PACE, call: cli.write(`call_${name}_${step}`, join(loadFolder, `${name}.txt`), `step ${step}`) }
    }
    const turn = turns.get(name)
    if (!turn) return { text: "~unknown" }
    turn.heard.push(now())
    if (step === 0) return { text: FIRST, pace: PACE, call: cli.write(`call_${name}`, turn.file, "written by the bench") }
    return step === 1 ? { text: SECOND, pace: PACE } : { text: "~extra" }
  }
  const model = await scriptedModel({
    answers: SCRIPTED_GETS, aside: "~aside", reply,
    sent: (event) => {
      const text = ModelDelta.safeParse(event).data
      if (text !== undefined && !text.startsWith("~")) recording?.tokens.push(now())
    },
  })
  closers.push(() => model.close())
  let sequence = 0
  const turnFor = (project: string): ModelTurn => {
    const tag = `VSM-t${++sequence}`
    const turn: ModelTurn = { tag, file: join(project, `bench-out-${sequence}.txt`), heard: [], tokens: [] }
    turns.set(tag, turn)
    recording = turn
    return turn
  }
  const prompt = (turn: ModelTurn) => `${turn.tag} Explain what you are about to do, write the file, then say what you did.`
  const until = async (what: string, done: () => boolean | Promise<boolean>, timeoutMs = 180_000, everyMs = 25): Promise<void> => {
    for (const deadline = Date.now() + timeoutMs; !(await done()); await delay(everyMs)) if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
  }

  /* A: the harness by itself. */
  const bareHome = await sealedHome(join(root, "bare"), harness, model.url)
  const bareProject = makeProject(join(root, "bare", "project"))
  const executable = cli.executable(bareHome.env)
  if (!executable) throw new Error(`${harness}'s CLI wasn't found`)
  async function bareRun(others: number, run: number): Promise<Sample[]> {
    const samples: Sample[] = []
    const session = randomUUID()
    let child: ChildProcess | undefined
    let heard: { at: number; text?: string; ended?: boolean; first: boolean }[] = []
    const start = (resume: boolean): ChildProcess => {
      assertScratchEnvironment(bareHome.env, `bare ${harness}`)
      const started = spawn(executable!, cli.args(session, resume), { cwd: bareProject, env: bareHome.env, stdio: ["pipe", "pipe", "ignore"] })
      children.add(started)
      started.once("exit", () => children.delete(started))
      let pending = ""
      started.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
        const at = now()
        const lines = (pending + chunk).split("\n")
        pending = lines.pop() ?? ""
        lines.forEach((line, index) => heard.push({ at, first: index === 0, ...cli.read(line) }))
      })
      return started
    }
    for (const scenario of SCENARIOS) {
      if (scenario !== "cold" && !child) continue
      const turn = turnFor(bareProject)
      heard = []
      if (scenario !== "cold") await delay(GAP_MS)
      if (scenario === "wake") {
        child!.stdin!.end()
        await stopChild(child!, 5_000)
      }
      const sent = now()
      if (scenario !== "warm") child = start(scenario === "wake")
      child!.stdin!.write(cli.message(prompt(turn)))
      await until(`bare ${harness} to finish its ${scenario} turn`, () => heard.some((line) => line.ended))
      const held = new Held()
      const out = heard.flatMap((line) => {
        if (line.text === undefined) return []
        held.take("text", undefined, line.text.length, false)
        return [{ at: line.at, characters: held.characters }]
      })
      const harnessTimes = tokenTimes(out)
      const marks: Mark[] = []
      const mark = (key: string, at: number | undefined) => { if (at !== undefined) marks.push({ key, at: at - sent }) }
      mark("frame", heard[0]?.at)
      mark("modelHeard", turn.heard[0])
      mark("modelFirst", turn.tokens[0])
      mark("textFrame", harnessTimes[0])
      mark("received", harnessTimes[0])
      samples.push({
        side: "bare", scenario, others, run, sent, marks, model: turn.tokens.map((at) => at - sent), harness: harnessTimes.map((at) => at - sent), reader: harnessTimes.map((at) => at - sent), device: [], deviceArrivals: [],
        arrivals: heard.filter((line) => line.text !== undefined && line.first).map((line) => line.at - sent),
        toolMs: turn.heard[1] === undefined || turn.tokens[FIRST_TOKENS - 1] === undefined ? undefined : turn.heard[1] - turn.tokens[FIRST_TOKENS - 1]!,
        notes: { characters: held.characters, expected: ENDS.at(-1) ?? 0, wrote: existsSync(turn.file) ? "yes" : "no" }, raw: [], batches: [],
      })
    }
    if (child) {
      child.stdin!.end()
      await stopChild(child, 5_000)
    }
    return samples
  }

  /* B and C: through Mako, with `others` conversations at work beside it. */
  const MARK = "bbbbbbbb"
  async function pass(others: number): Promise<Sample[]> {
    const folder = join(root, `n${others}`)
    loadStopped = false
    const home = await sealedHome(folder, harness, model.url)
    scratchKeychain(home.home)
    const project = makeProject(join(folder, "project"))
    loadFolder = makeProject(join(folder, "load"))
    const dataRoot = join(folder, "data")
    const { directory, socket } = runtimeLocation(dataRoot)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const env = { ...home.env, MAKO_DATA_ROOT: dataRoot, MAKO_WEB_SOCKET: socket, MAKO_PROD: "1", MAKO_TELEMETRY: "off", BENCH_VS_BARE_MARK: MARK }
    assertScratchEnvironment(env, "bench:vs-bare host")
    const host = spawn(process.execPath, [...HOST_NODE_OPTIONS, "--import", join(import.meta.dirname, "lib/bench-vs-bare-probe.mjs"), hostScript], { env, stdio: ["ignore", "ignore", "pipe", "pipe"] })
    children.add(host)
    host.once("exit", () => children.delete(host))
    let stderr = ""
    host.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4_000) })
    let stopping = false
    const probe: z.infer<typeof ProbeLine>[] = []
    // SAFETY: the host was started with a fourth descriptor piped, which its probe writes to.
    createInterface({ input: host.stdio[3] as NodeJS.ReadableStream }).on("line", (line) => {
      const read = ProbeLine.safeParse(JSON.parse(line))
      if (read.success) probe.push(read.data)
    })
    try {
      await until("the host to answer /health", async () => {
        if (host.exitCode !== null) throw new Error(`the host exited (${host.exitCode}) before it was ready: ${stderr.trim().slice(-800)}`)
        return (await probeRuntime(socket, { timeoutMs: 2_000 }).catch(() => undefined))?.state === "ready"
      }, 90_000, 100)
      const client = randomUUID()
      const call = (channel: string, ...args: unknown[]) => invokeRuntime(socket, client, channel, args, 1, { timeoutMs: 300_000 })
      await until("the host to read its catalog", async () => Catalog.parse(await call("mako:threads")).ready, 180_000, 250)
      const received: Heard[] = []
      const batchesOnly: Heard[] = []
      let streaming = false
      const unsubscribe = subscribeRuntime(socket, client, (packet) => {
        const at = now()
        if (packet.channel === "ready") streaming = true
        else if (packet.channel === "event" && (packet.type === "live-batch" || packet.type === "live-ahead") && packet.conversation?.startsWith(MARK)) received.push({ at, conversation: packet.conversation, payload: packet.payload })
      }, (end) => { if (!stopping) note(`the bench's event stream ended: ${end.why}`) }, { history: true, live: WINDOW_LIVE_FORM })
      // A second reader that says the compact form, as the gateway's link does: it hears the batches and nothing ahead
      // of them, so its pace is the one a phone and the journal get.
      let reading = false
      const unsubscribeDevice = subscribeRuntime(socket, randomUUID(), (packet) => {
        const at = now()
        if (packet.channel === "ready") reading = true
        else if (packet.channel === "event" && packet.type === "live-batch" && packet.conversation?.startsWith(MARK)) batchesOnly.push({ at, conversation: packet.conversation, payload: packet.payload })
      }, () => undefined, { history: true, live: COMPACT_LIVE_FORM })
      await until("the bench's event streams", () => streaming && reading, 30_000)
      const state = async (id: string) => LiveState.parse(await call("mako:live-state", id))
      const idle = async (id: string) => (await state(id)).status !== "running" && (await state(id)).status !== "starting"

      const load = Array.from({ length: others }, (_, index) => ({ id: randomUUID(), tag: `VSL-n${others}i${index}` }))
      for (const each of load) await call("mako:live-start", harness, loadFolder, { conversationId: each.id, modeId: cli.mode, title: `Load ${each.tag}`, initialRequest: { id: randomUUID(), text: `${each.tag} keep working`, attachments: [] } })
      await until(`${others} other conversations to be streaming`, () => load.every((each) => (steps.get(each.tag) ?? 0) >= 2), 300_000, 200)
      if (others) note(`  ${others} other conversations are streaming and writing`)
      // Two conversations that finish a short turn first: the host has then launched this harness before, as an app in
      // use has, and their later turns push a measured conversation past the warm limit, so its provider hibernates.
      const fillers = [0, 1].map((index) => ({ id: randomUUID(), tag: `VSF-n${others}i${index}` }))
      for (const each of fillers) await call("mako:live-start", harness, loadFolder, { conversationId: each.id, modeId: cli.mode, title: `Filler ${each.tag}`, initialRequest: { id: randomUUID(), text: `${each.tag} say ok`, attachments: [] } })
      for (const each of fillers) await until("a filler conversation's first turn", async () => (steps.get(each.tag) ?? 0) >= 1 && await idle(each.id), 180_000, 200)

      const samples: Sample[] = []
      for (let run = 1; run <= RUNS; run += 1) {
        note(`  run ${run}/${RUNS} with ${others} others: bare`)
        samples.push(...await bareRun(others, run))
        note(`  run ${run}/${RUNS} with ${others} others: through Mako`)
        const id = `${MARK}${randomUUID().slice(8)}`
        let started = false
        for (const scenario of SCENARIOS) {
          if (scenario !== "cold" && !started) continue
          const notes: Sample["notes"] = {}
          if (scenario !== "cold") await delay(GAP_MS)
          if (scenario === "wake") {
            const asked = probe.length
            const askedAt = Date.now()
            for (const each of fillers) await call("mako:live-prompt", each.id, randomUUID(), `${each.tag} say ok again`, [])
            const hibernated = await until("the measured conversation's provider to hibernate", async () => (await state(id)).connection === "hibernated", 90_000, 200).then(() => true, () => false)
            if (!hibernated) {
              note(`  wake: the host didn't hibernate the conversation within 90 s (${(await state(id)).connection}); the wake send isn't measured this run`)
              continue
            }
            notes.hibernatedBecause = Words.safeParse(probe.slice(asked).find((line) => line.s === "log" && line.message === "provider hibernated" && line.fields?.conversation === id)?.fields?.reason).data ?? null
            notes.hibernatedAfterMs = Date.now() - askedAt
            await delay(GAP_MS)
          }
          const turn = turnFor(project)
          const request = randomUUID()
          const probeFrom = probe.length
          const receivedFrom = received.length
          const batchesFrom = batchesOnly.length
          const sent = now()
          if (scenario === "cold") await call("mako:live-start", harness, project, { conversationId: id, modeId: cli.mode, title: "Bench vs bare", initialRequest: { id: request, text: prompt(turn), attachments: [] } })
          else await call("mako:live-prompt", id, request, prompt(turn), [])
          const answered = now()
          started = true
          let looked = 0
          await until(`Mako's ${scenario} turn to stream its answer`, async () => {
            // Twice a second, so a start that failed says why rather than timing out.
            if (Date.now() - looked > 500) {
              looked = Date.now()
              const session = await state(id)
              if (session.status === "failed" || session.status === "closed") throw new Error(`Mako's ${scenario} turn didn't run: its session is ${session.status}: ${Words.safeParse(session.error).data ?? "no reason given"}`)
            }
            return turn.tokens.length >= TOKENS.length
          })
          await until(`Mako's ${scenario} turn to end`, () => idle(id), 120_000, 50)
          // The turn's last batches and its checkpoint's line are a moment behind its status.
          await until("the turn's checkpoint to be saved", () => probe.slice(probeFrom).some((line) => line.s === "log" && line.scope === "checkpoints" && line.fields?.request === request), 15_000, 50).catch(() => undefined)
          await delay(150)
          samples.push(makoSample({ scenario, others, run, sent, answered, turn, request, id, client, notes, lines: probe.slice(probeFrom), heard: received.slice(receivedFrom), batchesOnly: batchesOnly.slice(batchesFrom) }))
        }
        if (started) await call("mako:live-close", id).catch(() => undefined)
      }
      loadStopped = true
      unsubscribe()
      unsubscribeDevice()
      return samples
    } catch (error) {
      // What the host itself said last, for a pass that couldn't be measured.
      const log = join(dataRoot, "logs", "host.log")
      if (existsSync(log)) note(`the host's log ends:\n${readFileSync(log, "utf8").split("\n").filter((line) => !line.includes(" provider-startup phase ")).slice(-40).map((line) => line.slice(0, 320)).join("\n")}`)
      throw error
    } finally {
      stopping = true
      await stopChild(host, 30_000)
      // The next pass's host starts with none of this one's harness processes still at work.
      for (const { pid } of processesUsingSync(folder)) try { process.kill(pid, "SIGKILL") } catch { /* It ended meanwhile. */ }
    }
  }

  const all: Sample[] = []
  for (const others of OTHERS) {
    note(`pass: ${others} other conversations on the host (load ${loadavg()[0]!.toFixed(1)} on ${cpus().length} cores)`)
    const samples = await pass(others)
    all.push(...samples)
    report(harness, others, samples)
  }
  if (values.json) {
    writeFileSync(values.json, `${JSON.stringify({ harness, runs: RUNS, others: OTHERS, pace: PACE, tokens: TOKENS.length, characters: ENDS.at(-1), files: FILES, samples: all }, null, 1)}\n`)
    say(`every timestamp: ${values.json}`)
  }
  return 0
}

/* ------------------------------------------------------- one turn through Mako */

interface MakoTurn {
  scenario: Scenario; others: number; run: number; sent: number; answered: number; turn: ModelTurn; request: string; id: string; client: string
  notes: Sample["notes"]; lines: z.infer<typeof ProbeLine>[]
  /** What the window's stream carried, and what a stream that reads the batches alone did. */
  heard: Heard[]; batchesOnly: Heard[]
}
interface Heard { at: number; conversation: string; payload: string }

/**
 * What a reader of a conversation's stream held as each line arrived: its batches reduced, and, for a window, the text
 * said ahead of the next batch drawn over the batch it was said of (`LiveAhead`), as the window draws it.
 */
function readerOf(heard: readonly Heard[], sent: number) {
  const held = new Held()
  const batches: Sample["batches"] = []
  const arrivals: number[] = []
  const reader: { at: number; characters: number }[] = []
  let firstText: number | undefined
  let revision: number | undefined
  let shown = 0
  let ahead = 0
  for (const { at, payload } of heard) {
    const json: z.infer<ReturnType<typeof z.json>> = JSON.parse(payload)
    const said = AheadLine.safeParse(json).data?.ahead
    const line = said ? undefined : BatchLine.safeParse(json).data
    if (said) {
      // Read only against the batch it was said of, as a window reads it.
      if (said.revision !== revision || held.characters + said.more.length <= shown) continue
      ahead += 1
      shown = held.characters + said.more.length
    } else if (line) {
      for (const update of line.updates ?? []) held.take(update.kind, update.id, update.text?.length ?? 0, update.replace === true)
      revision = line.revision
      batches.push({ at: at - sent, revision: line.revision, bytes: Buffer.byteLength(payload), characters: held.characters })
      if (held.characters > 0) firstText ??= line.revision
      if (held.characters <= shown) continue
      shown = held.characters
    } else continue
    arrivals.push(at - sent)
    reader.push({ at, characters: shown })
  }
  return { batches, arrivals, reader, firstText, ahead }
}

function makoSample({ scenario, others, run, sent, answered, turn, request, id, client, notes, lines, heard, batchesOnly }: MakoTurn): Sample {
  const marks: Mark[] = []
  const mark = (key: string, at: number | undefined) => { if (at !== undefined) marks.push({ key, at: at - sent }) }
  const stage = (name: string, evidence?: string) => lines.find((line) => line.s === name && line.q === request && (evidence === undefined || line.evidence === evidence))
  mark("call", stage("call")?.t)
  mark("answered", answered)
  for (const name of ["submit", "admitted", "dispatching", "gate", "assembled"]) mark(name, stage(name)?.t)
  const submitted = stage("delivery", "submitted")?.t
  mark("submitted", submitted)
  mark("accepted", stage("delivery", "accepted")?.t)
  notes.gate = stage("gate")?.kind ?? null
  // The provider's launch, phase by phase, as the host's own trace logged it; `launch` is the whole of it.
  for (const line of lines) {
    const phase = line.s === "log" && line.scope === "provider-startup" ? PhaseFields.safeParse(line.fields).data : undefined
    if (!phase || phase.conversation !== id) continue
    if (phase.phase === "launch") mark(phase.state === "started" ? "launchStarted" : "launchDone", line.t)
    else if (phase.state === "done") mark(`launch:${phase.phase}`, line.t)
  }
  mark("woke", lines.find((line) => line.s === "log" && line.message === "provider woke" && line.fields?.conversation === id)?.t)
  const from = submitted ?? sent
  mark("frame", lines.find((line) => line.s === "frame" && line.t >= from)?.t)
  mark("modelHeard", turn.heard[0])
  mark("modelFirst", turn.tokens[0])
  // What the host decoded: each text update with the frame it was decoded from, the last one recorded before it.
  const decodedHeld = new Held()
  const decoded: { at: number; characters: number }[] = []
  const framed: { at: number; characters: number }[] = []
  let frameAt: number | undefined
  for (const line of lines) {
    if (line.t < from) continue
    if (line.s === "frame") frameAt = line.t
    if (line.s !== "decoded" || !line.u) continue
    const before = decodedHeld.characters
    for (const [kind, block, length, replace] of line.u) decodedHeld.take(kind, block ?? undefined, length, replace === 1)
    if (decodedHeld.characters === before) continue
    decoded.push({ at: line.t, characters: decodedHeld.characters })
    framed.push({ at: frameAt ?? line.t, characters: decodedHeld.characters })
  }
  const harnessTimes = tokenTimes(framed)
  mark("textFrame", harnessTimes[0])
  mark("decoded", tokenTimes(decoded)[0])
  // What the window was sent, and what a reader of the batches alone was (a phone's link, the journal).
  const window = readerOf(heard, sent)
  const device = readerOf(batchesOnly, sent)
  const { batches, arrivals, firstText } = window
  mark("batch", lines.find((line) => line.s === "batch" && line.r === firstText)?.t)
  mark("wrote", lines.find((line) => line.s === "wrote" && line.r === firstText && line.client?.endsWith(client))?.t)
  const readerTimes = tokenTimes(window.reader)
  const deviceTimes = tokenTimes(device.reader)
  mark("received", readerTimes[0])
  notes.aheadFrames = window.ahead
  const checkpoint = lines.map((line) => line.s === "log" && line.scope === "checkpoints" ? { message: line.message, fields: CheckpointFields.safeParse(line.fields).data } : undefined).filter((line) => line?.fields?.request === request)
  const saved = checkpoint.find((line) => line?.message === "a turn's checkpoint was saved")?.fields
  notes.checkpoint = saved?.kind ?? null
  notes.checkpointHeldMs = saved?.heldMs ?? null
  notes.checkpointSavedMs = saved?.savedMs ?? null
  notes.wentBeforeCheckpoint = checkpoint.find((line) => line?.message?.includes("before its checkpoint"))?.message ?? null
  notes.characters = batches.at(-1)?.characters ?? 0
  notes.deviceCharacters = device.batches.at(-1)?.characters ?? 0
  notes.deviceBatches = device.arrivals.length
  notes.expected = ENDS.at(-1) ?? 0
  notes.wrote = existsSync(turn.file) ? "yes" : "no"
  notes.loopHeld = lines.filter((line) => line.s === "log" && line.scope === "loop").length
  return {
    side: "mako", scenario, others, run, sent, marks: marks.sort((a, b) => a.at - b.at), model: turn.tokens.map((at) => at - sent), harness: harnessTimes.map((at) => at - sent), reader: readerTimes.map((at) => at - sent),
    device: deviceTimes.map((at) => at - sent), deviceArrivals: device.arrivals,
    arrivals, toolMs: turn.heard[1] === undefined || turn.tokens[FIRST_TOKENS - 1] === undefined ? undefined : turn.heard[1] - turn.tokens[FIRST_TOKENS - 1]!,
    notes, raw: lines.filter((line) => line.s !== "frame" && line.s !== "decoded"), batches,
  }
}

/* --------------------------------------------------------------------- report */

/** What each boundary is, and what the code does to reach it from the one before. `own`: the harness's or the model's time, which bare has too. */
interface Row { label: string; why: string; own?: true }
const ROWS = {
  call: { label: "1 call received by the host", why: "the window's HTTP call crosses the host's socket and its arguments are decoded (`transport/server.ts`)" },
  submit: { label: "  settings resolved, in order", why: "the method parses its arguments, `profiles.resolveLaunch` reads the folder and account, and `admitInOrder` waits for sends ahead" },
  admitted: { label: "2 admitted and journaled", why: "`LiveConversations.submit` fingerprints the request and `admit` commits it to the journal and emits its batch" },
  answered: { label: "  the call's answer reached the window", why: "the method's value is encoded and written back (not on the message's path)" },
  launchStarted: { label: "  provider launch begins", why: "`LiveLaunches.launch` makes the conversation's tools (`dependencies.tools`) and its thread environment before the driver starts; a wake reaches `wakeNow`" },
  launchDone: { label: "  provider launch ended", why: "the driver arms its transcript reader and patches the session ready, and admission checks the account again (`assertCurrent`)" },
  woke: { label: "  provider woke", why: "`LiveHibernation.wakeNow` binds the resumed session and flushes" },
  dispatching: { label: "  left the queue for its turn", why: "the launch's session lands on the conversation and is flushed; `LiveDispatch.drain` takes the queued message, marks it dispatching and journals it" },
  gate: { label: "3 checkpoint gate released", why: "`LiveCheckpoints.prepare` checks the workspace can be checkpointed (`assertAvailable`) and starts the capture" },
  assembled: { label: "4 prompt assembled, admission passed", why: "`drain`'s run reads control instructions, rules and context and joins Mako's note to the message" },
  submitted: { label: "5 handed to the harness process", why: "admission checks the account again (`ready`), the driver builds the input and tunes the session, and the handoff is journaled before the send" },
  accepted: { label: "  harness echoed the message", why: "the harness read its input and said so (`acknowledge`)", own: true },
  frame: { label: "6 first native message after the send", why: "the harness's first output of any kind", own: true },
  modelHeard: { label: "  harness asked the model", why: "the harness's own work from its input to its model request", own: true },
  modelFirst: { label: "  model wrote its first text token", why: "the scripted model's pace", own: true },
  textFrame: { label: "  first text token out of the harness", why: "the harness's own relay of the model's token to its output", own: true },
  decoded: { label: "7 first text token decoded", why: "the driver's loop runs its observers on the frame, then the decoder and the engine hand the update to the conversation" },
  batch: { label: "8 first batch with text emitted", why: `\`schedule\` flushes a turn's first words at once and later ones each ${LIVE_FRAME_MS} ms; the flush commits to the journal and builds the batch` },
  wrote: { label: "9 batch written to the window's stream", why: "the event is encoded once per live form (`encodeRuntimeEvent`) and written to each subscriber (`send`)" },
  received: { label: "10 received by the window", why: "the line crosses the socket and is assembled (`subscribeRuntime`)" },
} satisfies Record<string, Row>
/** Each phase of the driver's start the host's trace names (`ProviderLaunchTrace`), by what runs in it; Claude's driver is the one read for these. */
const PHASES = {
  "runtime-discovery": { why: "the harness's executable is found (`claudeRuntime`) and held to the oldest version Mako runs (`RuntimeFloor.before`)" },
  account: { why: "`admission.resolve` picks the account the launch runs on and its environment" },
  "mcp-preparation": { why: "`mcpSnapshot(cwd)` reads the folder's MCP servers for the launch" },
  configuration: { why: "the rest of `claudeSdkOptions`: the environment, the MCP servers, Mako's in-process server and the system prompt" },
  observation: { why: "the write-hold check (`personCodeRuns`), then `prepareApprovals` sets up the watch on native approvals" },
  spawn: { why: "the Agent SDK package is loaded on its first use and the CLI is spawned (`spawnClaudeProcess`)" },
  "sdk-initialization": { why: "the CLI boots and answers the SDK's initialize", own: true },
  "session-resume": { why: "`transcript.locate` finds the resumed session's transcript" },
  handshake: { why: "the harness process answers the driver's handshake", own: true },
  "session-open": { why: "the harness opens its session", own: true },
} satisfies Record<string, Omit<Row, "label">>
const row = (key: string): Row => entry<Row>(ROWS, key) ?? (key.startsWith("launch:")
  ? { label: `  launch: ${key.slice(7)}`, ...(entry<Omit<Row, "label">>(PHASES, key.slice(7)) ?? { why: "a phase of the driver's start (`ProviderLaunchTrace`)" }) }
  : { label: key, why: "" })
/** Rows that say when something off the message's path happened; they take no step of it. */
const BESIDE = new Set(["answered", "accepted", "frame"])

const median = (numbers: readonly number[]) => {
  const sorted = [...numbers].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : undefined
}
const quantile = (numbers: readonly number[], q: number) => {
  const sorted = [...numbers].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]! : undefined
}
const worst = (numbers: readonly number[]) => numbers.length ? Math.max(...numbers) : undefined
const ms = (value: number | undefined, width = 8) => (value === undefined ? "-" : value.toFixed(Math.abs(value) < 100 ? 1 : 0)).padStart(width)
const gaps = (times: readonly number[]) => times.slice(1).map((at, index) => at - times[index]!)
const defined = (numbers: readonly (number | undefined)[]) => numbers.flatMap((value) => value === undefined ? [] : [value])

function report(harness: string, others: number, samples: Sample[]): void {
  const ranked: { scenario: Scenario; label: string; added: number; why: string }[] = []
  for (const scenario of SCENARIOS) {
    const mako = samples.filter((sample) => sample.side === "mako" && sample.scenario === scenario)
    const bare = samples.filter((sample) => sample.side === "bare" && sample.scenario === scenario)
    say()
    say(`${harness}, ${scenario}, ${others} other conversations at work: ${mako.length} runs through Mako, ${bare.length} bare (ms after the send; median, and the worst run; a step is each run's own time since the row above on the message's path, so medians need not add up)`)
    if (!mako.length || !bare.length) {
      say("  not measured")
      continue
    }
    const at = (set: Sample[], key: string) => defined(set.map((sample) => sample.marks.find((each) => each.key === key)?.at))
    const keys = [...new Set(mako.flatMap((sample) => sample.marks.map((each) => each.key)))].sort((a, b) => (median(at(mako, a)) ?? 0) - (median(at(mako, b)) ?? 0))
    const path = keys.filter((key) => !BESIDE.has(key))
    /** In each run, how long after the boundary before it on the path this one was reached. */
    const step = (key: string) => defined(mako.map((sample) => {
      const here = sample.marks.find((each) => each.key === key)?.at
      const before = path[path.indexOf(key) - 1]
      const there = before === undefined ? 0 : sample.marks.find((each) => each.key === before)?.at
      return here === undefined || there === undefined ? undefined : here - there
    }))
    say(`  ${"boundary".padEnd(40)}${"bare".padStart(8)}${"Mako".padStart(8)}${"worst".padStart(8)}${"step".padStart(8)}${"worst".padStart(8)}${"diff".padStart(8)}  what Mako does to get here`)
    let ownMako = 0
    for (const key of keys) {
      const { label, why, own } = row(key)
      const bareAt = median(at(bare, key)), makoAt = median(at(mako, key))
      const stepped = BESIDE.has(key) ? undefined : median(step(key))
      say(`  ${label.padEnd(40)}${ms(bareAt)}${ms(makoAt)}${ms(worst(at(mako, key)))}${ms(stepped)}${ms(BESIDE.has(key) ? undefined : worst(step(key)))}${ms(bareAt === undefined || makoAt === undefined ? undefined : makoAt - bareAt)}  ${own ? `(the harness's own) ${why}` : why}`)
      if (stepped === undefined) continue
      if (own) ownMako += stepped
      else ranked.push({ scenario, label: label.trim(), added: stepped, why })
    }
    const ownBare = median(at(bare, "textFrame"))
    if (ownBare !== undefined) ranked.push({ scenario, label: "the harness's own steps, run by Mako rather than by itself", added: ownMako - ownBare, why: `its launch, its model request and its first token took ${ms(ownMako, 0)} ms in Mako's rows marked so, ${ms(ownBare, 0)} ms bare from the send to its first token` })
    const first = (set: Sample[]) => median(at(set, "received"))
    say(`  first token visible: bare ${ms(first(bare), 0)} ms, Mako ${ms(first(mako), 0)} ms, Mako adds ${ms((first(mako) ?? NaN) - (first(bare) ?? NaN), 0)} ms`)
    const each = (set: Sample[], read: (sample: Sample) => number[]) => set.flatMap(read)
    const lag = (set: Sample[], from: "model" | "harness", to: "harness" | "reader" | "device") => each(set, (sample) => defined(sample[to].map((at, index) => sample[from][index] === undefined || at === undefined ? undefined : at - sample[from][index]!)))
    const line = (name: string, numbers: number[]) => `  ${name.padEnd(54)}p50 ${ms(quantile(numbers, 0.5), 6)}  p95 ${ms(quantile(numbers, 0.95), 6)}  max ${ms(worst(numbers), 6)}  (${numbers.length} tokens)`
    say("  the stream, per token:")
    say(line("bare: model wrote it -> out of the harness", lag(bare, "model", "harness")))
    say(line("Mako: model wrote it -> host received it", lag(mako, "model", "harness")))
    say(line("Mako: host received it -> window received it", lag(mako, "harness", "reader")))
    say(line("Mako: model wrote it -> window received it", lag(mako, "model", "reader")))
    say(line("Mako: host received it -> reader of batches alone", lag(mako, "harness", "device")))
    const said = (key: string) => [...new Set(mako.map((sample) => String(sample.notes[key] ?? "none")))].join(", ")
    const number = (key: string) => median(defined(mako.map((sample) => Amount.safeParse(sample.notes[key]).data)))
    /** The longest wait for more of the answer while text was streaming: the write's own pause, between the two parts, is left out. */
    const longest = (set: Sample[], read: (sample: Sample) => number[], tokens: boolean) => worst(each(set, (sample) => {
      const times = read(sample)
      if (tokens) return [...gaps(times.slice(0, FIRST_TOKENS)), ...gaps(times.slice(FIRST_TOKENS))]
      const pause = sample.model[FIRST_TOKENS - 1], resumed = sample.model[FIRST_TOKENS]
      return pause === undefined || resumed === undefined ? gaps(times) : [...gaps(times.filter((at) => at < resumed)), ...gaps(times.filter((at) => at >= resumed))]
    }))
    say(`  longest gap while text streamed: between tokens bare ${ms(longest(bare, (sample) => sample.harness, true), 0)} ms; between tokens as the model wrote them ${ms(longest(mako, (sample) => sample.model, true), 0)} ms; between batches the window received ${ms(longest(mako, (sample) => sample.arrivals, false), 0)} ms (${ms(median(mako.map((sample) => sample.arrivals.length)), 0)} arrivals with new text a turn for ${TOKENS.length} tokens, ${ms(number("aheadFrames"), 0)} of them said ahead of a batch every ${LIVE_AHEAD_MS} ms); between batches a reader of the batches alone received ${ms(longest(mako, (sample) => sample.deviceArrivals, false), 0)} ms (${ms(number("deviceBatches"), 0)} text batches a turn; a long answer flushes each ${LONG_ANSWER_FLUSH_MS} ms past ${LONG_ANSWER_CHARS} characters)`)
    const tool = (set: Sample[]) => median(defined(set.map((sample) => sample.toolMs)))
    say(`  the write, from the model's last token before it to the request carrying its result: bare ${ms(tool(bare), 0)} ms, Mako ${ms(tool(mako), 0)} ms`)
    say(`  checkpoint: gate ${said("gate")} (${said("gate") === "held" ? "the message went at once and the agent's first write waited on the checkpoint" : "the message waited for its checkpoint"}); before-point ${said("checkpoint")}; held the workspace ${ms(number("checkpointHeldMs"), 0)} ms and was saved ${ms(number("checkpointSavedMs"), 0)} ms after it began; went ahead of it: ${said("wentBeforeCheckpoint")}`)
    if (scenario === "wake") say(`  hibernated because: ${said("hibernatedBecause")}, ${ms(number("hibernatedAfterMs"), 0)} ms after two other conversations were sent a short turn`)
    const whole = [...mako, ...bare].filter((sample) => sample.notes.characters !== sample.notes.expected || sample.notes.wrote !== "yes")
    say(whole.length ? `  CHECK: ${whole.length} turns did not deliver the whole answer or the file (${whole.map((sample) => `${sample.side} run ${sample.run}: ${sample.notes.characters}/${sample.notes.expected} characters, file ${sample.notes.wrote}`).join("; ")})` : `  every turn delivered all ${ENDS.at(-1)} characters and wrote its file; the host logged ${mako.reduce((sum, sample) => sum + (Amount.safeParse(sample.notes.loopHeld).data ?? 0), 0)} held-loop lines during them`)
  }
  say()
  say(`${harness}, ${others} other conversations: what Mako adds before the first token is visible, largest first (median ms)`)
  for (const entry of ranked.sort((a, b) => b.added - a.added)) say(`  ${ms(entry.added)}  ${entry.scenario.padEnd(5)} ${entry.label}: ${entry.why}`)
}

const code = await main().catch((error) => {
  note(error instanceof Error ? error.stack ?? error.message : String(error))
  return 1
})
await finish(code)

import "./lib/scratch-git.mjs"
// How long the basic things a person does to a conversation take, from their key to the window showing it and to
// the harness being in the new state: a message, a steer into a running turn, a Stop, a message to a session that
// was stopped or hibernated, a cut turn continued, an access change, a model, reasoning or fast change, and an
// approval's answer. It asserts nothing and runs locally only.
//
// A real `mako-host` runs on a scratch data root in a sealed home, and starts the real harness CLI against the
// scripted model (no account; nothing leaves this machine). This process is its window: it calls the host on its
// socket and reads the host's events as a window does. The host says where each action is inside it on three
// diagnostics topics (`conversations/live-stages.ts`), which the probe `bench:vs-bare` uses writes to a pipe this
// process reads (`lib/bench-host.ts`); the scripted model
// says when the harness asked it. Every mark is on one clock.
//
// Claude Code is also driven bare, over its own stream-json input, for the same actions where its protocol has
// them: that column is what a terminal costs. The other harnesses speak to Mako in the one protocol they have
// (Codex's app-server, ACP, OpenCode's server), so there is no second, bare way to drive them here.
//
//   npm run bench:actions -- [<harness>...] [--runs 5] [--json <file>]
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { once } from "node:events"
import { writeFile } from "node:fs/promises"
import { cpus, loadavg } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { setTimeout as delay } from "node:timers/promises"
import { parseArgs } from "node:util"
import { z } from "zod"
import type { JsonObject, JsonValue } from "@mako/host/contracts/json"
import { bundledClaudeExecutable } from "@mako/host/harnesses/claude/runtime"
import { invokeRuntime, subscribeRuntime } from "@mako/host/transport/connection"
import { sandboxed, type Sandbox } from "./harness-sandbox.ts"
import { removeScratchSync } from "./lib/scratch-processes.mjs"
import { benchHostReady, benchHostScript, benchNow, startBenchHost, type BenchHost, type ProbeLine } from "./lib/bench-host.ts"
import { pointAt, SCRIPTED_GETS } from "./scripted-harness-env.ts"
import { scriptedModel, type ScriptedReply } from "./scripted-model.ts"

const { values, positionals } = parseArgs({
  options: { runs: { type: "string", default: "5" }, json: { type: "string" } },
  allowPositionals: true,
})
const RUNS = Math.max(1, Number(values.runs))
/** A step this long after the one before it is listed at the end. */
const SLOW_MS = 15
/** How long the model's command sleeps, so a turn is still running when it's steered or stopped. */
const SLEEP_S = 6
const WAIT_MS = 60_000
/** How long a short message takes to type: what a session woken at the first key has before Send. */
const TYPING_MS = 1_500
/** The window's own wait on a host that refuses a steer as busy, and the refusals it reads as that (`src/state/acp-queue.ts`). */
const STEER_BUSY_MS = 2_000
const STEER_BUSY_STEP_MS = 50
const BUSY_STEER = /Resolve the previous provider action|Wait for this conversation to connect|is still ending the previous turn/i
/** The files in the project each harness works in. */
const FILES = 1500

type Call = NonNullable<ScriptedReply["call"]>
/** Each harness's shell tool as its model calls it, and the mode its turns run in so nothing asks (`probe-steer-semantics.ts`). */
const SHELLS = new Map<string, { call: (command: string, tools: Set<string>) => Call; full?: string }>([
  ["claude", { call: (command) => ({ id: `call_${randomUUID().slice(0, 8)}`, name: "Bash", arguments: { command, description: "Run it", timeout: 120_000 } }), full: "bypassPermissions" }],
  ["codex", {
    call: (command, tools) => tools.has("exec_command") || !tools.has("exec")
      ? { id: `call_${randomUUID().slice(0, 8)}`, name: "exec_command", arguments: { cmd: command, yield_time_ms: 60_000 } }
      : { id: `call_${randomUUID().slice(0, 8)}`, name: "exec", input: `text(JSON.stringify(await tools.exec_command(${JSON.stringify({ cmd: command, yield_time_ms: 60_000 })})))` },
    full: "access:full",
  }],
  ["grok", { call: (command) => ({ id: `call_${randomUUID().slice(0, 8)}`, name: "run_terminal_command", arguments: { command, description: "Run it" } }), full: "access:full" }],
  ["opencode", { call: (command) => ({ id: `call_${randomUUID().slice(0, 8)}`, name: "shell", arguments: { command } }) }],
])
/** Harnesses with no stand-in for their model here, and why. */
const SKIPPED = new Map([
  ["devin", "its stand-in (`scripted-windsurf.ts`) answers a turn but this bench's scripted steps are not written for it"],
  ["cursor", "its SDK runs only on Cursor's own model, which needs the person's account"],
])

const now = benchNow
const offered = (heard: string) => new Set([...heard.matchAll(/"name"\s*:\s*"([A-Za-z_][\w.-]*)"/g)].map((match) => match[1]!))

/** One moment of an action, wherever it was read. */
interface Mark { at: number; name: string }
interface Sample { action: string; marks: Mark[]; note?: string }

const Request = z.object({ id: z.string(), status: z.string() }).loose()
const Permission = z.object({ id: z.string(), options: z.array(z.object({ optionId: z.string(), kind: z.string().optional() }).loose()).optional() }).loose()
const BatchEvent = z.object({
  batch: z.object({
    id: z.string(), revision: z.number(),
    sessionChanges: z.object({ status: z.string().optional(), connection: z.string().optional(), currentMode: z.string().nullable().optional() }).loose().optional(),
    permissions: z.array(Permission).optional(),
    requests: z.array(Request).optional(), requestChanges: z.array(Request).optional(),
  }).loose(),
}).loose()
const Json = z.json()
const Settings = z.object({ model: z.string().optional(), options: z.record(z.string(), z.json()).optional() })
const Snapshot = z.object({
  session: z.object({
    status: z.string(), connection: z.string(), error: z.string().optional(), currentMode: z.string().nullable().optional(),
    modes: z.array(z.object({ id: z.string(), access: z.string().optional(), enforcement: z.string().optional() }).loose()),
    settings: Settings.optional(),
    configOptions: z.array(z.object({ id: z.string(), role: z.string().optional(), currentValue: z.json().optional(), options: z.array(z.object({ value: z.json() }).loose()).optional() }).loose()).optional(),
  }).loose(),
  permissions: z.array(Permission),
  requests: z.array(Request),
}).loose()
const Availability = z.record(z.string(), z.boolean())

/** What the window knows of one conversation, from the batches alone. */
interface View { status?: string; connection?: string; mode?: string | null; permissions: z.infer<typeof Permission>[]; requests: Map<string, string> }
interface Heard { at: number; revision: number; view: View; payload: string }

/** The host's window: its calls, and every batch as it arrives, folded into what each conversation shows. */
function openWindow(host: BenchHost) {
  const client = randomUUID()
  const views = new Map<string, View>()
  const heard = new Map<string, Heard[]>()
  const waiters = new Set<() => void>()
  const stop = subscribeRuntime(host.socket, client, (packet) => {
    const at = now()
    if (!("payload" in packet) || packet.type !== "live-batch") return
    const parsed = BatchEvent.safeParse(JSON.parse(packet.payload))
    if (!parsed.success) return
    const batch = parsed.data.batch
    const view = views.get(batch.id) ?? { permissions: [], requests: new Map<string, string>() }
    const next: View = { ...view, requests: new Map(view.requests) }
    if (batch.sessionChanges?.status !== undefined) next.status = batch.sessionChanges.status
    if (batch.sessionChanges?.connection !== undefined) next.connection = batch.sessionChanges.connection
    if (batch.sessionChanges?.currentMode !== undefined) next.mode = batch.sessionChanges.currentMode
    if (batch.permissions) next.permissions = batch.permissions
    if (batch.requests) next.requests = new Map(batch.requests.map((request) => [request.id, request.status]))
    for (const request of batch.requestChanges ?? []) next.requests.set(request.id, request.status)
    views.set(batch.id, next)
    heard.set(batch.id, [...heard.get(batch.id) ?? [], { at, revision: batch.revision, view: next, payload: packet.payload }])
    for (const wake of waiters) wake()
  }, () => undefined)
  return {
    stop,
    call: (channel: string, ...args: (JsonValue | undefined)[]) => invokeRuntime(host.socket, client, channel, args, 1, { timeoutMs: 600_000 }),
    view: (id: string) => views.get(id),
    /** The first batch since `since` that `shows` holds for. */
    async until(id: string, since: number, shows: (heard: Heard) => boolean, what: string, timeoutMs = WAIT_MS): Promise<Heard> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = heard.get(id)?.find((each) => each.at >= since && shows(each))
        if (found) return found
        if (Date.now() > deadline) throw new Error(`the window never saw ${what}`)
        let wake = () => {}
        const woke = new Promise<void>((done) => { wake = done })
        waiters.add(wake)
        await Promise.race([woke, delay(250)])
        waiters.delete(wake)
      }
    },
  }
}
type Window = ReturnType<typeof openWindow>

/** What a line of the host's probe is called in a table; undefined for one no table shows. */
function named(line: ProbeLine): string | undefined {
  if (line.s === "call" || line.s === "host-call") return line.channel === "mako:live-snapshot" ? undefined : `host: ${line.channel} arrived`
  if (line.s === "host-answer") return line.channel === "mako:live-snapshot" ? undefined : `host: ${line.channel} ${line.refused ? "refused" : "answered"}`
  if (line.s === "step") {
    if (line.phase === "begin") return `host: waits on ${line.step}`
    if (line.phase === "end") return `host: ${line.step} done`
    if (line.phase === "asked") return `host: asks ${line.step}`
    if (line.phase === "answered") return `harness: ${line.step} answered`
    if (line.phase === "refused") return `harness: ${line.step} refused`
    return `host: ${line.step}`
  }
  // A message's own stages (`LiveStage`), as `bench:vs-bare` reads them.
  if (line.s === "gate") return `host: the message's checkpoint lets it go (${line.kind})`
  if (line.s === "delivery") return `host: the driver says the message ${line.evidence}`
  if (line.s === "submit" || line.s === "admitted" || line.s === "dispatching" || line.s === "assembled") return `host: the message is ${line.s === "submit" ? "submitted" : line.s}`
  if (line.s === "session") return `harness says: ${line.status}/${line.connection}, mode ${line.mode ?? "none"}`
  if (line.s === "permission") return "harness says: an approval is asked"
  return undefined
}

const median = (numbers: number[]) => { const sorted = [...numbers].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : Number.NaN }
const ms = (value: number) => Number.isNaN(value) ? "-" : value >= 100 ? value.toFixed(0) : value.toFixed(1)

interface Row { step: string; at: number; since: number; after: string; min: number; max: number; n: number }
/** What one harness's run leaves in `--json`. */
interface HarnessResult { load: { cores: number; start: number; end: number }; tables: Record<string, Row[]>; bare: Record<string, Row[]>; samples: Record<string, Sample[]> }
/** A model, reasoning and fast selection as a message carries it. */
type Selection = z.infer<typeof Settings>
/** The selection a message changes to, and the composer's own to come back to. */
interface Retuning { changed: Selection; back: Selection }
/** A line a CLI printed, parsed; undefined when it isn't JSON. */
function safely(line: string): JsonValue | undefined {
  try { return Json.parse(JSON.parse(line)) } catch { return undefined }
}
/** Each step's time from the key, over the runs it was seen in, in the order the steps happen. */
function rows(samples: Sample[]): Row[] {
  const offsets = new Map<string, number[]>()
  for (const sample of samples) {
    const t0 = sample.marks[0]!.at
    const first = new Map<string, number>()
    for (const mark of sample.marks) if (!first.has(mark.name)) first.set(mark.name, mark.at - t0)
    for (const [name, at] of first) offsets.set(name, [...offsets.get(name) ?? [], at])
  }
  const ordered = [...offsets].map(([step, all]) => ({ step, at: median(all), min: Math.min(...all), max: Math.max(...all), n: all.length })).sort((a, b) => a.at - b.at)
  return ordered.map((row, index) => ({ ...row, since: index ? row.at - ordered[index - 1]!.at : 0, after: index ? ordered[index - 1]!.step : "" }))
}

function table(title: string, samples: Sample[], bare?: Sample[]): Row[] {
  console.log(`\n${title} (${samples.length} run${samples.length === 1 ? "" : "s"}; ms from the key, median [min to max]; +ms since the step above)`)
  if (!samples.length) { console.log("  not measured"); return [] }
  const all = rows(samples)
  const width = Math.max(...all.map((row) => row.step.length), 20)
  for (const row of all)
    console.log(`  ${row.step.padEnd(width)}  ${ms(row.at).padStart(7)}  [${ms(row.min)} to ${ms(row.max)}]  +${ms(row.since)}${row.n < samples.length ? `  (in ${row.n} of ${samples.length})` : ""}`)
  const notes = new Set(samples.flatMap((sample) => sample.note ?? []))
  for (const note of notes) console.log(`  note: ${note}`)
  if (bare?.length) {
    console.log(`  bare Claude Code over stream-json, the same action (${bare.length} runs):`)
    for (const row of rows(bare)) console.log(`    ${row.step.padEnd(width - 2)}  ${ms(row.at).padStart(7)}  [${ms(row.min)} to ${ms(row.max)}]`)
  } else if (bare) console.log("  bare: not measured")
  return all
}

/** The scripted model both the host's harness and the bare CLI ask: what each request carried, and when. */
async function model(harness: string) {
  const heard: { at: number; text: string }[] = []
  /** Tags whose turn runs a command first: the first conversation request carrying one gets the call. */
  const commands = new Map<string, string>()
  const shell = SHELLS.get(harness)!
  const server = await scriptedModel({
    reply: (text) => {
      heard.push({ at: now(), text })
      for (const [tag, command] of commands) {
        if (!text.includes(tag)) continue
        commands.delete(tag)
        return { text: "Running it.", call: shell.call(command, offered(text)) }
      }
      return { text: "Done." }
    },
    answers: SCRIPTED_GETS,
  })
  return {
    url: server.url,
    close: () => server.close(),
    runs: (tag: string, command: string) => { commands.set(tag, command) },
    /** When a conversation request since `since` first carried `text`. */
    async hears(text: string, since: number, timeoutMs = WAIT_MS): Promise<number> {
      for (const deadline = Date.now() + timeoutMs; ; await delay(2)) {
        const found = heard.find((each) => each.at >= since && each.text.includes(text))
        if (found) return found.at
        if (Date.now() > deadline) throw new Error(`the model never heard ${text}`)
      }
    },
    heardSince: (since: number) => heard.filter((each) => each.at >= since),
  }
}
type Model = Awaited<ReturnType<typeof model>>

interface Stand {
  /** Ends its host as a quit does, so its harnesses end with it: for a run that is interrupted. */
  kill: () => Promise<void>
  harness: string
  sandbox: Sandbox
  host: BenchHost
  win: Window
  model: Model
  samples: Map<string, Sample[]>
}

/** One timed action: `act` takes the key's time and answers the marks this process read itself. */
async function timed(stand: Stand, action: string, id: string, act: (t0: number) => Promise<{ marks: Mark[]; batches?: [string, Heard][]; note?: string }>): Promise<void> {
  const t0 = now()
  let result: Awaited<ReturnType<typeof act>>
  try {
    result = await act(t0)
  } catch (error) {
    console.log(`  ${stand.harness} ${action}: not measured this run: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const until = now()
  // The probe's lines trail the marks by a moment on their pipe.
  await delay(150)
  const lines = stand.host.probe.filter((line) => line.t >= t0 && line.t <= until + 5 && line.c === id)
  const marks: Mark[] = [{ at: t0, name: "window: the key" }, ...result.marks]
  for (const line of lines) {
    const name = named(line)
    if (name) marks.push({ at: line.t, name })
  }
  for (const [what, batch] of result.batches ?? []) {
    marks.push({ at: batch.at, name: `window: receives ${what}` })
    const left = lines.find((line) => line.s === "batch" && line.r === batch.revision)
    if (left) marks.push({ at: left.t, name: `host: the batch with ${what} leaves` })
  }
  marks.sort((a, b) => a.at - b.at)
  stand.samples.set(action, [...stand.samples.get(action) ?? [], { action, marks, ...result.note && { note: result.note } }])
}

const settled = (view: View | undefined) => view?.status !== "running" && ![...view?.requests.values() ?? []].some((status) => status === "dispatching" || status === "queued")

async function snapshot(stand: Stand, id: string) {
  return Snapshot.parse(await stand.win.call("mako:live-snapshot", id))
}

/** Waits, by the snapshot, until the conversation's turn is over and nothing waits: between timed actions only. */
async function quiet(stand: Stand, id: string, what: string): Promise<z.infer<typeof Snapshot>> {
  for (const deadline = Date.now() + WAIT_MS; ; await delay(100)) {
    const current = await snapshot(stand, id)
    if (current.session.status === "failed") throw new Error(`${what}: the session failed: ${current.session.error ?? "no reason given"}`)
    if (current.session.status !== "running" && current.session.status !== "starting" && !current.requests.some((request) => request.status === "dispatching" || request.status === "queued") && !current.permissions.length) return current
    if (Date.now() > deadline) throw new Error(`${what}: the conversation never settled (${current.session.status}/${current.session.connection})`)
  }
}

async function startConversation(stand: Stand, modeId: string | undefined): Promise<string> {
  const id = randomUUID()
  await stand.win.call("mako:live-start", stand.harness, stand.sandbox.project, { conversationId: id, ...modeId && { modeId } })
  await quiet(stand, id, "the start")
  return id
}

/** Starts a turn whose model runs a sleeping command, and answers once the command is under way. */
async function sleepingTurn(stand: Stand, id: string, tag: string, tuning: Selection | undefined): Promise<string> {
  const request = randomUUID()
  stand.model.runs(tag, `sleep ${SLEEP_S} && echo SLEPT-${tag}`)
  const sent = now()
  await stand.win.call("mako:live-prompt", id, request, `${tag} run the command you are given, then say done.`, [], tuning)
  await stand.model.hears(tag, sent)
  // The model's reply carries the call; the harness needs a moment to start it.
  await delay(900)
  return request
}

async function benchHarness(harness: string, results: Map<string, HarnessResult>): Promise<void> {
  const shell = SHELLS.get(harness)!
  await sandboxed("mako-bench-actions", harness, async (sandbox) => {
    // Interrupted, the sandbox goes with what ran in it (`interrupted`).
    const gone = () => removeScratchSync(sandbox.root)
    started.add(gone)
    const stand = await raise(harness, sandbox)
    if (!stand) return
    const { win, samples } = stand
    const bare: Map<string, Sample[]> = new Map()
    let failure: string | undefined
    // Other work on the machine slows every step here: a run says how loaded it was, so two runs can be compared.
    const load = { cores: cpus().length, start: loadavg()[0]!, end: 0 }
    try {
      const id = await startConversation(stand, shell.full)
      const opened = await snapshot(stand, id)
      const modes = opened.session.modes
      const live = modes.filter((mode) => mode.enforcement !== "launch")
      const tier = (access: string | undefined) => ["plan", "chat", "ask", "edits", "auto", "full"].indexOf(access ?? "")
      const asks = live.filter((mode) => tier(mode.access) >= 2).sort((a, b) => tier(a.access) - tier(b.access))[0]
      const other = live.find((mode) => mode.id !== asks?.id && mode.id !== opened.session.currentMode && tier(mode.access) >= 2 && mode.access !== "full")
      const home = opened.session.currentMode ?? shell.full
      console.log(`${harness}: modes ${modes.map((mode) => `${mode.id}${mode.access ? ` (${mode.access}${mode.enforcement === "launch" ? ", at launch" : ""})` : ""}`).join(", ") || "none"}; settings ${JSON.stringify(opened.session.settings ?? {})}`)
      // As a window sends it: every message carries the selection the composer shows (`settingsForSend`).
      const retuned = retuning(harness, opened)
      const selection = retuned?.back ?? (opened.session.settings?.model ? opened.session.settings : undefined)

      // A first turn, untimed: the harness's own first-request work isn't any action's.
      const warm = now()
      await win.call("mako:live-prompt", id, randomUUID(), "BENCH-WARM say done.", [], selection)
      await stand.model.hears("BENCH-WARM", warm)
      await quiet(stand, id, "the first turn")

      for (let run = 1; run <= RUNS; run += 1) {
        const n = `${harness.toUpperCase()}-${run}`
        await timed(stand, "1. message to a warm session", id, async (t0) => {
          const request = randomUUID()
          const call = win.call("mako:live-prompt", id, request, `BENCH-P${n} say done.`, [], selection)
          const [answered, heardAt, shown] = await Promise.all([call.then(now), stand.model.hears(`BENCH-P${n}`, t0), win.until(id, t0, (each) => each.view.requests.has(request), "the message")])
          return { marks: [{ at: answered, name: "window: the call answers" }, { at: heardAt, name: "model: asked with the message" }], batches: [["the message admitted", shown]] }
        })
        await quiet(stand, id, "a message's turn")

        // 5. The selection, changed with a message as the window carries it, and the same selection again.
        if (retuned) {
          for (const [action, tuning] of [["5a. message carrying a changed model/reasoning/fast selection", retuned.changed], ["5b. message carrying the same selection again", retuned.changed]] as const) {
            await timed(stand, action, id, async (t0) => {
              const tag = `BENCH-${action.slice(0, 2).toUpperCase()}${n}`
              const call = win.call("mako:live-prompt", id, randomUUID(), `${tag} say done.`, [], tuning)
              const [answered, heardAt] = await Promise.all([call.then(now), stand.model.hears(tag, t0)])
              return { marks: [{ at: answered, name: "window: the call answers" }, { at: heardAt, name: "model: asked with the message" }], note: `selection ${JSON.stringify(tuning)}` }
            })
            await quiet(stand, id, "a retuned turn")
          }
          // Back to the composer's selection, untimed, so every other message carries one the process already has.
          const back = now()
          await win.call("mako:live-prompt", id, randomUUID(), `BENCH-5C${n} say done.`, [], selection)
          await stand.model.hears(`BENCH-5C${n}`, back)
          await quiet(stand, id, "the selection restored")
        }

        // 4. Access, on an idle session and back.
        if (asks && other) {
          for (const target of [other.id, asks.id]) {
            await timed(stand, "4a. access changed on an idle session", id, async (t0) => {
              const call = win.call("mako:live-mode", id, target)
              const [answered, shown] = await Promise.all([call.then(now), win.until(id, t0, (each) => each.view.mode === target, `mode ${target}`)])
              return { marks: [{ at: answered, name: "window: the call answers" }], batches: [["the new mode", shown]] }
            })
          }
        }

        // 6. An approval's answer, in the mode that asks.
        if (asks) {
          if (win.view(id)?.mode !== asks.id) await win.call("mako:live-mode", id, asks.id)
          const tag = `BENCH-A${n}`
          const file = join(sandbox.project, `approved-${run}.txt`)
          stand.model.runs(tag, `echo approved > ${file} && echo WROTE-${tag}`)
          const sent = now()
          await win.call("mako:live-prompt", id, randomUUID(), `${tag} run the command you are given, then say done.`, [], selection)
          const asked = await win.until(id, sent, (each) => each.view.permissions.length > 0, "an approval", 20_000).catch(() => undefined)
          if (!asked) {
            console.log(`  ${harness} 6. approval: ${asks.id} asked nothing for a shell write here; not measured`)
            await quiet(stand, id, "an unasked turn").catch(() => undefined)
          } else {
            const permission = asked.view.permissions[0]!
            const allow = permission.options?.find((option) => /allow/i.test(`${option.kind} ${option.optionId}`) && !/always/i.test(`${option.kind} ${option.optionId}`)) ?? permission.options?.find((option) => /allow/i.test(`${option.kind} ${option.optionId}`)) ?? permission.options?.[0]
            // A person reads the card first.
            await delay(400)
            await timed(stand, "6. approval answered", id, async (t0) => {
              const call = win.call("mako:live-permission", id, permission.id, { kind: "choice", optionId: allow?.optionId ?? null })
              const [answered, gone, ran] = await Promise.all([call.then(now), win.until(id, t0, (each) => !each.view.permissions.some((each) => each.id === permission.id), "the card go"),
                (async () => { for (const deadline = Date.now() + 20_000; !existsSync(file); await delay(2)) if (Date.now() > deadline) throw new Error("the approved command never ran"); return now() })()])
              // What `answerLiveApproval` awaits after its own answer: the receipt's snapshot, read back.
              const receipt = await win.call("mako:live-snapshot", id).then(now)
              return { marks: [{ at: answered, name: "window: the call answers" }, { at: ran, name: "harness: the approved command ran" }, { at: receipt, name: "window: the receipt's snapshot, read back after the answer, arrives" }], batches: [["the card gone", gone]] }
            })
            await quiet(stand, id, "an approved turn")
          }
          if (home && win.view(id)?.mode !== home && live.some((mode) => mode.id === home)) await win.call("mako:live-mode", id, home)
        }

        // 1. A steer into a running turn.
        {
          const tag = `BENCH-S${n}`
          await sleepingTurn(stand, id, tag, selection)
          const turn = [...win.view(id)?.requests ?? []].find(([, status]) => status === "dispatching")?.[0]
          if (turn) await timed(stand, "1b. steer into a running turn", id, async (t0) => {
            const steer = randomUUID()
            const words = `BENCH-STEER${n}`
            // As the window sends it (`attemptSteer`): a host busy with the turn's checkpoint or another steer refuses,
            // and the window asks again every `STEER_BUSY_STEP_MS` for up to `STEER_BUSY_MS`.
            const tries: Mark[] = []
            const call = (async () => {
              for (const by = Date.now() + STEER_BUSY_MS; ; await delay(STEER_BUSY_STEP_MS)) {
                try {
                  await win.call("mako:live-action", id, { kind: "steer", id: steer, requestId: turn, text: `${words} say steered.`, attachments: [] })
                  return now()
                } catch (error) {
                  if (!(error instanceof Error) || !BUSY_STEER.test(error.message) || Date.now() > by) throw error
                  tries.push({ at: now(), name: `window: the host is busy, it asks again in ${STEER_BUSY_STEP_MS} ms` })
                }
              }
            })()
            const drawn = win.until(id, t0, (each) => each.payload.includes(words), "the steer's words").catch(() => undefined)
            const [answered, heardAt] = await Promise.all([call, stand.model.hears(words, t0, (SLEEP_S + 20) * 1000)])
            const shown = await drawn
            // The command still had seconds to run when the steer was sent: heard well inside them, it didn't wait for it.
            const cut = heardAt - t0 < (SLEEP_S - 2.5) * 1000
            const batches: [string, Heard][] = shown ? [["the steer's words", shown]] : []
            return { marks: [...tries, { at: answered, name: "window: the call answers" }, { at: heardAt, name: "model: asked with the steer" }], batches,
              note: cut ? "the model heard the steer before the command ended" : `the model heard the steer only once the ${SLEEP_S} s command returned` }
          })
          await quiet(stand, id, "a steered turn")
        }

        // 2. A Stop, then 3. the next message and a cut turn continued.
        for (const after of ["message", "typed", "continue"] as const) {
          const tag = `BENCH-T${after === "message" ? "M" : after === "typed" ? "K" : "C"}${n}`
          const stopped = await sleepingTurn(stand, id, tag, selection)
          await timed(stand, "2. stop a running turn", id, async (t0) => {
            const call = win.call("mako:live-cancel", id)
            const [answered, shown] = await Promise.all([call.then(now), win.until(id, t0, (each) => each.view.status !== undefined && each.view.status !== "running" && settled(each.view), "the turn stopped")])
            return { marks: [{ at: answered, name: "window: the call answers" }], batches: [["the turn stopped", shown]] }
          })
          await quiet(stand, id, "a stopped turn")
          const resting = win.view(id)?.connection
          if (after === "message") {
            await timed(stand, "3a. message after a Stop", id, async (t0) => {
              const words = `BENCH-R${n}`
              const call = win.call("mako:live-prompt", id, randomUUID(), `${words} say done.`, [], selection)
              const [answered, heardAt] = await Promise.all([call.then(now), stand.model.hears(words, t0)])
              return { marks: [{ at: answered, name: "window: the call answers" }, { at: heardAt, name: "model: asked with the message" }], note: `after the Stop the session was ${resting}` }
            })
          } else if (after === "typed") {
            // The first key of the next message wakes a session its Stop ended (`noteComposing`); Send follows the typing.
            await win.call("mako:live-prewarm", id)
            await delay(TYPING_MS)
            await timed(stand, "3a2. message after a Stop, the session woken at the first key", id, async (t0) => {
              const words = `BENCH-K${n}`
              const call = win.call("mako:live-prompt", id, randomUUID(), `${words} say done.`, [], selection)
              const [answered, heardAt] = await Promise.all([call.then(now), stand.model.hears(words, t0)])
              return { marks: [{ at: answered, name: "window: the call answers" }, { at: heardAt, name: "model: asked with the message" }], note: `after the Stop the session was ${resting}; Send came ${TYPING_MS} ms after the first key` }
            })
          } else {
            await timed(stand, "3b. a cut turn continued", id, async (t0) => {
              const call = win.call("mako:live-continue-turn", id, randomUUID(), { reason: "handed-off", continues: stopped })
              const answered = await call.then(now)
              for (const deadline = Date.now() + WAIT_MS; !stand.model.heardSince(t0).length; await delay(2)) if (Date.now() > deadline) throw new Error("the model never heard the continuation")
              return { marks: [{ at: answered, name: "window: the call answers" }, { at: stand.model.heardSince(t0)[0]!.at, name: "model: asked to continue" }], note: `after the Stop the session was ${resting}` }
            })
          }
          await quiet(stand, id, "the turn after a Stop")
        }
      }

      // 3. and 4. on a hibernated session: the host keeps two idle sessions warm, so a third puts the oldest to sleep.
      await hibernated(stand, id, shell.full, selection, asks?.id, other?.id)

      if (harness === "claude") await bareClaude(sandbox, stand.model, bare, asks?.id ?? "default", other?.id ?? "acceptEdits")
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    } finally {
      win.stop()
      await stand.kill()
      await stand.model.close()
      started.delete(stand.kill)
      started.delete(gone)
    }
    load.end = loadavg()[0]!
    const tables: Record<string, Row[]> = {}
    /** Each action's twin in the bare run. */
    const pairs = new Map([
      ["1. message to a warm session", "message"], ["1b. steer into a running turn", "steer"], ["2. stop a running turn", "stop"],
      ["4a. access changed on an idle session", "access"], ["5a. message carrying a changed model/reasoning/fast selection", "retune"], ["6. approval answered", "approval"],
      ["3a. message after a Stop", "stop"],
    ])
    console.log(`\n=== ${harness} (load average ${load.start.toFixed(1)} at its start, ${load.end.toFixed(1)} at its end, on ${load.cores} cores) ===`)
    if (failure) console.log(`${harness}: stopped early, what was measured follows: ${failure}`)
    for (const action of [...samples.keys()].sort()) {
      const pair = pairs.get(action)
      const all = table(`${harness}: ${action}`, samples.get(action) ?? [], harness === "claude" && pair ? bare.get(pair) ?? [] : undefined)
      tables[action] = all
      for (const row of all) if (row.since >= SLOW_MS) slow.push({ harness, action, step: row.step, after: row.after, ms: row.since })
    }
    if (harness !== "claude") console.log(`\n${harness}: no bare column: Mako drives it over the one protocol it has, so there is no second way to script the same actions here.`)
    results.set(harness, { load, tables, bare: Object.fromEntries([...bare].map(([action, each]) => [action, rows(each)])), samples: Object.fromEntries(samples) })
  })
}

/** The other selection a message can carry on this harness, and the one to come back to; undefined where the bench knows none. */
function retuning(harness: string, opened: z.infer<typeof Snapshot>): Retuning | undefined {
  const settings = opened.session.settings
  // Claude Code's reasoning level and fast lane, which its SDK session takes as flag settings.
  if (harness === "claude")
    return { changed: { ...settings, options: { ...settings?.options, effort: "high", fast: true } }, back: { ...settings, options: { ...settings?.options, effort: "medium", fast: false } } }
  const option = opened.session.configOptions?.find((each) => each.role === "reasoning" && (each.options?.length ?? 0) > 1)
  if (!option) return undefined
  const current = option.currentValue ?? option.options![0]!.value
  const next = option.options!.find((each) => JSON.stringify(each.value) !== JSON.stringify(current))?.value
  if (next === undefined) return undefined
  return { changed: { ...settings, options: { ...settings?.options, [option.id]: next } }, back: { ...settings, options: { ...settings?.options, [option.id]: current } } }
}

/** A checkout with history and `FILES` files, so each turn's checkpoint reads a real tree. */
function stage(sandbox: Sandbox): void {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: sandbox.project, env: sandbox.env, stdio: "ignore" })
  git("init", "-q")
  for (let index = 0; index < FILES; index += 1) {
    const folder = join(sandbox.project, "src", `part${index % 40}`)
    if (index < 40) mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `file${index}.ts`), `export const value${index} = ${index}\n${"// filler line\n".repeat(40)}`)
  }
  git("add", "-A")
  git("-c", "user.name=Bench", "-c", "user.email=bench@localhost", "commit", "-qm", "initial")
}

async function raise(harness: string, sandbox: Sandbox): Promise<Stand | undefined> {
  stage(sandbox)
  const env: NodeJS.ProcessEnv = { ...sandbox.env }
  const served = await model(harness)
  await pointAt(harness, sandbox, served.url, env, "mako-bench-actions")
  const host = startBenchHost({ dataRoot: join(sandbox.root, "mako"), env })
  // As a quit ends it, so its harnesses end with it; killed only when it doesn't go.
  const kill = async () => {
    if (host.child.exitCode !== null || host.child.signalCode !== null) return
    const exited = once(host.child, "exit")
    host.child.kill("SIGTERM")
    const timer = setTimeout(() => host.child.kill("SIGKILL"), 15_000)
    await exited.catch(() => undefined)
    clearTimeout(timer)
  }
  started.add(kill)
  await benchHostReady(host)
  const win = openWindow(host)
  if (!Availability.parse(await win.call("mako:harness-availability"))[harness]) {
    console.log(`${harness}: skipped, not installed`)
    win.stop()
    await kill()
    started.delete(kill)
    await served.close()
    return undefined
  }
  return { kill, harness, sandbox, host, win, model: served, samples: new Map() }
}

async function hibernated(stand: Stand, first: string, full: string | undefined, selection: Selection | undefined, asks: string | undefined, other: string | undefined): Promise<void> {
  const { win } = stand
  const ids = [first]
  try {
    for (let extra = 0; extra < 2; extra += 1) {
      const id = await startConversation(stand, full)
      const sent = now()
      await win.call("mako:live-prompt", id, randomUUID(), `BENCH-H${extra} say done.`, [], selection)
      await stand.model.hears(`BENCH-H${extra}`, sent)
      await quiet(stand, id, "a helper's turn")
      ids.push(id)
    }
  } catch (error) {
    console.log(`  ${stand.harness} hibernated actions: not measured: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const asleep = async () => {
    for (const deadline = Date.now() + 30_000; ; await delay(100)) {
      for (const id of ids) if ((await snapshot(stand, id)).session.connection === "hibernated") return id
      if (Date.now() > deadline) return undefined
    }
  }
  for (let run = 1; run <= RUNS; run += 1) {
    const id = await asleep()
    if (!id) { console.log(`  ${stand.harness} hibernated actions: no session went to sleep under the warm limit; not measured`); return }
    const n = `${stand.harness.toUpperCase()}-${run}`
    const target = run % 2 ? other : asks
    if (target) {
      await timed(stand, "4b. access changed on a hibernated session", id, async (t0) => {
        const call = win.call("mako:live-mode", id, target)
        const [answered, shown] = await Promise.all([call.then(now), win.until(id, t0, (each) => each.view.mode === target, `mode ${target}`)])
        // Long enough for a wake to show, were there one.
        await delay(300)
        return { marks: [{ at: answered, name: "window: the call answers" }], batches: [["the new mode", shown]] }
      })
      if (full) await win.call("mako:live-mode", id, full).catch(() => undefined)
    }
    if (run % 2) {
      await timed(stand, "3c. message to a hibernated session", id, async (t0) => {
        const words = `BENCH-W${n}`
        const call = win.call("mako:live-prompt", id, randomUUID(), `${words} say done.`, [], selection)
        const [answered, heardAt] = await Promise.all([call.then(now), stand.model.hears(words, t0)])
        return { marks: [{ at: answered, name: "window: the call answers" }, { at: heardAt, name: "model: asked with the message" }] }
      })
    } else {
      await timed(stand, "3d. typing wakes a hibernated session (prewarm)", id, async (t0) => {
        const call = win.call("mako:live-prewarm", id)
        const [answered, shown] = await Promise.all([call.then(now), win.until(id, t0, (each) => each.view.connection === "connected" && each.view.status === "ready", "the session awake")])
        return { marks: [{ at: answered, name: "window: the call answers" }], batches: [["the session awake", shown]] }
      })
      const sent = now()
      await win.call("mako:live-prompt", id, randomUUID(), `BENCH-X${n} say done.`, [], selection)
      await stand.model.hears(`BENCH-X${n}`, sent)
    }
    await quiet(stand, id, "a woken turn")
  }
}

const ControlResponse = z.object({ type: z.literal("control_response"), response: z.object({ request_id: z.string(), subtype: z.string() }).loose() }).loose()
const ControlRequest = z.object({ type: z.literal("control_request"), request_id: z.string(), request: z.object({ subtype: z.string(), input: z.json().optional(), tool_use_id: z.string().optional() }).loose() }).loose()
const Result = z.object({ type: z.literal("result") }).loose()

/**
 * Claude Code alone, as a terminal's own front end drives it: the bundled CLI on its stream-json input and output,
 * with the control requests the Agent SDK sends (`interrupt`, `set_permission_mode`, `set_model`,
 * `apply_flag_settings`) and its permission prompts answered on the same stream.
 */
async function bareClaude(sandbox: Sandbox, served: Model, bare: Map<string, Sample[]>, asks: string, other: string): Promise<void> {
  const executable = bundledClaudeExecutable()
  if (!executable) { console.log("  claude bare: the Agent SDK's bundled CLI isn't installed; not measured"); return }
  const env = { ...sandbox.env, CLAUDE_CONFIG_DIR: join(sandbox.home, ".claude"), ANTHROPIC_BASE_URL: served.url, ANTHROPIC_API_KEY: "mako-bench-actions-bare" }
  let child: ChildProcessWithoutNullStreams | undefined
  const waiting = new Map<string, (at: number) => void>()
  let asked: ((request: z.infer<typeof ControlRequest>) => void) | undefined
  let ended: (() => void) | undefined
  const kill = () => { child?.kill("SIGKILL") }
  started.add(kill)
  const open = (mode: string) => {
    child = spawn(executable, ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--permission-mode", mode, "--allow-dangerously-skip-permissions", "--permission-prompt-tool", "stdio"], { cwd: sandbox.project, env, stdio: ["pipe", "pipe", "pipe"] })
    child.stderr.resume()
    createInterface({ input: child.stdout }).on("line", (line) => {
      const at = now()
      const message = safely(line)
      if (message === undefined) return
      const response = ControlResponse.safeParse(message)
      if (response.success) { waiting.get(response.data.response.request_id)?.(at); waiting.delete(response.data.response.request_id); return }
      const request = ControlRequest.safeParse(message)
      if (request.success) { asked?.(request.data); return }
      if (Result.safeParse(message).success) ended?.()
    })
  }
  const write = (message: JsonObject) => child!.stdin.write(`${JSON.stringify(message)}\n`)
  const control = (request: JsonObject): Promise<number> => {
    const request_id = randomUUID()
    const answered = new Promise<number>((done, fail) => {
      waiting.set(request_id, done)
      setTimeout(() => fail(new Error(`Claude Code never answered ${String(request.subtype)}`)), 30_000).unref()
    })
    write({ type: "control_request", request_id, request })
    return answered
  }
  const say = (text: string) => write({ type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: text } })
  const turnEnd = () => new Promise<void>((done) => { ended = done })
  const record = (action: string, t0: number, marks: Mark[]) => bare.set(action, [...bare.get(action) ?? [], { action, marks: [{ at: t0, name: "the key" }, ...marks].sort((a, b) => a.at - b.at) }])
  try {
    open("bypassPermissions")
    await control({ subtype: "initialize" })
    let end = turnEnd()
    const warm = now()
    say("BARE-WARM say done.")
    await served.hears("BARE-WARM", warm)
    await end
    for (let run = 1; run <= RUNS; run += 1) {
      try {
        end = turnEnd()
        let t0 = now()
        say(`BARE-P${run} say done.`)
        record("message", t0, [{ at: await served.hears(`BARE-P${run}`, t0), name: "model: asked with the message" }])
        await end

        t0 = now()
        const flags = await control({ subtype: "apply_flag_settings", settings: { effortLevel: run % 2 ? "high" : "medium", fastMode: Boolean(run % 2) } })
        end = turnEnd()
        say(`BARE-M${run} say done.`)
        record("retune", t0, [{ at: flags, name: "harness: apply_flag_settings answered" }, { at: await served.hears(`BARE-M${run}`, t0), name: "model: asked with the message" }])
        await end

        for (const mode of [other, asks]) {
          t0 = now()
          record("access", t0, [{ at: await control({ subtype: "set_permission_mode", mode }), name: "harness: set_permission_mode answered" }])
        }

        const file = join(sandbox.project, `bare-approved-${run}.txt`)
        served.runs(`BARE-A${run}`, `echo approved > ${file}`)
        const prompted = new Promise<z.infer<typeof ControlRequest>>((done) => { asked = (request) => { if (request.request.subtype === "can_use_tool") done(request) } })
        end = turnEnd()
        say(`BARE-A${run} run the command you are given, then say done.`)
        const prompt = await Promise.race([prompted, delay(20_000).then(() => undefined)])
        if (prompt) {
          await delay(400)
          t0 = now()
          write({ type: "control_response", response: { subtype: "success", request_id: prompt.request_id, response: { behavior: "allow", updatedInput: prompt.request.input ?? {}, ...prompt.request.tool_use_id && { toolUseID: prompt.request.tool_use_id } } } })
          for (const deadline = Date.now() + 20_000; !existsSync(file); await delay(2)) if (Date.now() > deadline) throw new Error("the approved command never ran")
          record("approval", t0, [{ at: now(), name: "harness: the approved command ran" }])
        }
        await end
        await control({ subtype: "set_permission_mode", mode: "bypassPermissions" })

        served.runs(`BARE-S${run}`, `sleep ${SLEEP_S} && echo SLEPT-BARE-S${run}`)
        end = turnEnd()
        let sent = now()
        say(`BARE-S${run} run the command you are given, then say done.`)
        await served.hears(`BARE-S${run}`, sent)
        await delay(900)
        t0 = now()
        say(`BARE-STEER${run} say steered.`)
        record("steer", t0, [{ at: await served.hears(`BARE-STEER${run}`, t0, (SLEEP_S + 20) * 1000), name: `model: asked with the steer (it waits for the ${SLEEP_S} s command)` }])
        await end

        served.runs(`BARE-T${run}`, `sleep ${SLEEP_S} && echo SLEPT-BARE-T${run}`)
        end = turnEnd()
        sent = now()
        say(`BARE-T${run} run the command you are given, then say done.`)
        await served.hears(`BARE-T${run}`, sent)
        await delay(900)
        t0 = now()
        const interrupted = await control({ subtype: "interrupt" })
        await end
        const over = now()
        end = turnEnd()
        say(`BARE-R${run} say done.`)
        record("stop", t0, [{ at: interrupted, name: "harness: interrupt answered" }, { at: over, name: "harness: the turn's result" }, { at: await served.hears(`BARE-R${run}`, over), name: "model: asked with the next message (sent at the result)" }])
        await end
      } catch (error) {
        console.log(`  claude bare run ${run}: ${error instanceof Error ? error.message : String(error)}`)
        break
      }
    }
  } finally {
    kill()
    started.delete(kill)
  }
}

/**
 * What the run started that outlives a turn of its own code: each host, the bare CLI and each sandbox. A finished run ends each as it goes; one interrupted ends them all here, processes
 * first, so nothing it started is left running or on disk.
 */
const started = new Set<() => void | Promise<void>>()
async function interrupted(signal: string): Promise<void> {
  for (const end of [...started].reverse()) {
    try { await end() } catch { /* the rest still go */ }
  }
  console.log(`bench:actions: stopped by ${signal}; everything it started is ended and removed`)
  process.exit(1)
}

const slow: { harness: string; action: string; step: string; after: string; ms: number }[] = []
const results = new Map<string, HarnessResult>()
const wanted = positionals.length ? positionals : [...SHELLS.keys(), ...SKIPPED.keys()]
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => void interrupted(signal))
// A fault of the bench's own ends what it started too, saying what it was.
process.once("uncaughtException", (error) => void interrupted(`its own error: ${error.message}`))
process.once("unhandledRejection", (reason) => void interrupted(`its own error: ${reason instanceof Error ? reason.message : String(reason)}`))
// Refused before anything starts when the host isn't built.
benchHostScript()
{
  for (const harness of wanted) {
    const skipped = SKIPPED.get(harness)
    if (skipped || !SHELLS.has(harness)) { console.log(`${harness}: skipped, ${skipped ?? "no such harness here"}`); continue }
    try {
      await benchHarness(harness, results)
    } catch (error) {
      console.log(`${harness}: stopped early: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.log(`\nSteps ${SLOW_MS} ms or more after the step before them, largest first:`)
  for (const each of slow.sort((a, b) => b.ms - a.ms)) console.log(`  ${ms(each.ms).padStart(7)} ms  ${each.harness}: ${each.action}: ${each.step}  (after ${each.after})`)
  if (!slow.length) console.log("  none")
  if (values.json) await writeFile(values.json, JSON.stringify({ runs: RUNS, slow, results: Object.fromEntries(results) }, null, 1) + "\n")
}

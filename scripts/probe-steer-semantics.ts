import "./lib/scratch-git.mjs"
// What "steer" and "stop" do on each real harness, through Mako's own live
// driver, in a sealed home against the scripted model (no account; nothing
// leaves this machine). The model runs one shell command that sleeps
// `SLEEP_S` seconds, then answers. `STEER_AFTER_MS` into the command Mako
// either steers (`driver.steering.steer`) or stops (`driver.cancel`), and the
// probe reads, from what the model is asked next and when:
//
// - steer: when the harness took it; whether the command was cut short (the
//   next request came before the sleep could end, without its output);
//   whether that next request already carries the message (the next step) or
//   it came only after the turn (turn end);
// - stop: how long until the turn is no longer running, and whether the
//   command's output ever reached the model;
// - lands: what Mako does with a message the person sends into the turn
//   (`SteerCapability.landing`: the harness's own steer, that steer when it's
//   confirmed within `STEER_LANDS_MS`, else a stop and the message sent as the
//   next one), and how long until the model heard it.
//
// Cursor has no stand-in for its model: `--cursor` runs it on the person's
// sign-in, copied into a scratch home, against its real model. `--lands` runs
// only that kind, and fails a message the model hears only once the command
// returned: with its output, or after the sleep would have ended. That's what
// a message waiting behind the turn does, 11 s after it was sent; one landed
// in the turn is heard in under a second. CI runs it on the harnesses it
// installs.
//
//   npx tsx --tsconfig tsconfig.app.json scripts/probe-steer-semantics.ts [<harness>...] [--cursor] [--lands] [--evidence <dir>]
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { installClaude } from "@mako/host/harnesses/claude/index"
import { installCodex } from "@mako/host/harnesses/codex/index"
import { installDevin } from "@mako/host/harnesses/devin/index"
import { installGrok } from "@mako/host/harnesses/grok/index"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { installOpenCode } from "@mako/host/harnesses/opencode/index"
import { admitted } from "./fixtures/admitted-start.ts"
import { sealedDrivers } from "./fixtures/sealed-drivers.ts"
import { sandboxed, type Sandbox } from "./harness-sandbox.ts"
import { pointAt, SCRIPTED_GETS } from "./scripted-harness-env.ts"
import { scriptedModel, type ScriptedReply } from "./scripted-model.ts"
import { scriptedWindsurf } from "./scripted-windsurf.ts"

const args = process.argv.slice(2)
const evidenceAt = args.indexOf("--evidence")
const evidence = evidenceAt === -1 ? undefined : args.splice(evidenceAt, 2)[1]
const cursor = args.includes("--cursor")
const named = args.filter((arg) => !arg.startsWith("--"))

const SLEEP_S = 15
const STEER_AFTER_MS = 4000
/** What only the command's output says: its own text, which the history echoes, says `$((40+2))`. */
const DONE = "SLEPT-42"
const ECHO_DONE = "SLEPT-$((40+2))"

type Call = NonNullable<ScriptedReply["call"]>
/** Each harness's shell tool, as its model calls it, and the mode its turn runs in so no approval stops it. */
const SHELLS = new Map<string, { call: (command: string, tools: Set<string>) => Call; mode?: string }>([
  ["claude", { call: (command) => ({ id: "call_sleep", name: "Bash", arguments: { command, description: "Sleep", timeout: 120_000 } }), mode: "bypassPermissions" }],
  ["codex", {
    call: (command, tools) => tools.has("exec_command") || !tools.has("exec")
      ? { id: "call_sleep", name: "exec_command", arguments: { cmd: command, yield_time_ms: 60_000 } }
      : { id: "call_sleep", name: "exec", input: `text(JSON.stringify(await tools.exec_command(${JSON.stringify({ cmd: command, yield_time_ms: 60_000 })})))` },
    mode: "access:full",
  }],
  ["grok", { call: (command) => ({ id: "call_sleep", name: "run_terminal_command", arguments: { command, description: "Sleep" } }), mode: "access:full" }],
  ["opencode", { call: (command) => ({ id: "call_sleep", name: "shell", arguments: { command } }) }],
  ["devin", { call: (command) => ({ id: "call_sleep", name: "exec", arguments: { command } }), mode: "bypass" }],
])

/** Every name a request carries, its tools' among them, on any wire and in Codex's frames alike: enough to tell which shell tool it offers. */
function offered(heard: string): Set<string> {
  return new Set([...heard.matchAll(/"name"\s*:\s*"([A-Za-z_][\w.-]*)"/g)].map((match) => match[1]!))
}

/** One model request after the command: when, and what it carried; `tail` is what its tool results said, kept for the evidence. */
interface Heard { at: number; steered: boolean; slept: boolean; tail: string }
interface Probe {
  harness: string
  kind: "steer" | "stop" | "baseline" | "lands"
  /** Milliseconds from the command's start. */
  commandStarted: number
  acted?: number
  answered?: number
  outcome?: string
  heard: Heard[]
  turnEnded?: number
  events: LiveDriverEvent[]
}

async function probe(harness: string, kind: Probe["kind"], sandbox: Sandbox, driver: ProviderLiveDriver): Promise<Probe> {
  const shell = SHELLS.get(harness)!
  const nonce = `STEER-${randomUUID().slice(0, 8)}`
  const command = `sleep ${SLEEP_S} && echo ${ECHO_DONE}`
  const result: Probe = { harness, kind, commandStarted: 0, heard: [], events: [] }
  let began = 0
  let asked = 0
  const reply = (heard: string): ScriptedReply => {
    asked++
    if (asked === 1) {
      began = Date.now()
      return { text: "Running it.", call: shell.call(command, offered(heard)) }
    }
    result.heard.push({ at: Date.now() - began, steered: heard.includes(nonce), slept: heard.includes(DONE), tail: [...heard.matchAll(/"type":"(?:function_call_output|custom_tool_call_output|tool_result)"/g)].map((match) => heard.slice(match.index, match.index + 700)).join("\n") })
    return { text: heard.includes(nonce) ? `Heard ${nonce}.` : "Done." }
  }
  const model = harness === "devin" ? await scriptedWindsurf({ reply }) : await scriptedModel({ reply, answers: SCRIPTED_GETS })
  const env = { ...sandbox.env }
  await pointAt(harness, sandbox, model.url, env, `steer-probe-${kind}`)
  if (harness === "claude") Object.assign(env, { CLAUDE_CONFIG_DIR: join(sandbox.home, ".claude"), ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: `steer-probe-${kind}` })
  for (const key of ["HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "CODEX_HOME"] as const)
    if (env[key] && !env[key].startsWith(sandbox.home)) throw new Error(`${harness}'s ${key} is outside its sealed home; nothing was started`)
  const id = randomUUID()
  const emit = (event: LiveDriverEvent) => {
    result.events.push(event)
    if (event.type === "live-permission") {
      const option = event.request.options?.find((candidate) => /allow/i.test(`${candidate.kind} ${candidate.optionId}`)) ?? event.request.options?.[0]
      if (option) void Promise.resolve(driver.permission(id, event.request.id, { kind: "choice", optionId: option.optionId }, { assertCurrent() {}, report() {} })).catch(() => {})
    }
  }
  const session = () => result.events.findLast((event) => event.type === "live-session")?.session
  if (kind === "lands") return hosted(harness, driver, sandbox, env, shell.mode, nonce, result, () => began, model.close)
  try {
    await driver.start(sandbox.project, admitted(harness, {
      conversationId: id, emit,
      ...shell.mode && { modeId: shell.mode },
      mcpSnapshot: async () => ({ cwd: sandbox.project, generatedAt: Date.now(), servers: [], providers: [] }),
    }, { env }))
    void driver.prompt(id, "Run the sleep command, then say done.", [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
    const startBy = Date.now() + 60_000
    while (!began && Date.now() < startBy) await delay(50)
    if (!began) throw new Error(`${harness} never asked the stand-in`)
    await delay(STEER_AFTER_MS)
    result.acted = Date.now() - began
    if (kind === "steer") {
      const steering = driver.steering
      if (steering.kind !== "supported") throw new Error(`${harness} declares no steering: ${steering.reason}`)
      const runId = session()?.nativeRunId
      if (!runId) throw new Error(`${harness}'s turn named no run`)
      const answer = await steering.steer(id, { id: randomUUID(), expectedRunId: runId, text: `${nonce}: before you answer, say you heard this.`, attachments: [] })
        .then((taken) => taken.kind === "accepted" ? "accepted" : `not accepted: ${taken.reason}`, (error) => `threw: ${error instanceof Error ? error.message : String(error)}`)
      result.answered = Date.now() - began
      result.outcome = answer
    } else if (kind === "stop") {
      await driver.cancel(id)
      result.answered = Date.now() - began
      result.outcome = "stop sent"
    }
    const settleBy = Date.now() + 90_000
    let quiet = Date.now(), seen = result.events.length
    while (Date.now() < settleBy) {
      if (result.events.length !== seen) { seen = result.events.length; quiet = Date.now() }
      const status = session()?.status
      if (status !== "running" && status !== "starting") {
        result.turnEnded ??= Date.now() - began
        if (Date.now() - quiet > 3000) break
      }
      await delay(100)
    }
  } finally {
    await Promise.resolve(driver.close(id)).catch(() => {})
    await model.close()
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      await writeFile(join(evidence, `${harness}-${kind}.json`), sandbox.scrub(JSON.stringify(result, null, 1)))
    }
  }
  return result
}

/**
 * The person's message into the running turn through Mako's own host (`LiveConversations.act`), which lands it by the
 * harness's `landing`: its own steer, that steer once confirmed within `STEER_LANDS_MS`, or a stop and the message as
 * the next one (whose process a harness that ends it on Stop opens again). Read from what the model is asked next.
 */
async function hosted(harness: string, raw: ProviderLiveDriver, sandbox: Sandbox, env: NodeJS.ProcessEnv, modeId: string | undefined, nonce: string, result: Probe, began: () => number, close: () => Promise<void>): Promise<Probe> {
  const driver: ProviderLiveDriver = { ...raw, start: (cwd, options) => raw.start(cwd, admitted(harness, { ...options, mcpSnapshot: options.mcpSnapshot ?? (async () => ({ cwd, generatedAt: Date.now(), servers: [], providers: [] })) }, { env })) }
  const root = await mkdtemp(join(tmpdir(), "mako-steer-probe-host-"))
  let owner: LiveConversations | undefined
  const id = randomUUID(), first = randomUUID()
  try {
    // The probe's turns run where no approval stops them (`SHELLS`' modes); one that asks is allowed, as the driver-level runs do.
    // Its session is the probe's own, made here: a stop that ended the process resumes it, as the app's host would.
    owner = new LiveConversations({ root, appPath: root, driver: (provider) => provider === harness ? driver : undefined, history: async () => null, resumeVerdict: async () => ({ kind: "resumable", record: "same" }), emit: (event) => {
      if (event.type !== "live-batch") return
      const pending = owner?.snapshot(id)?.permissions.find((permission) => !permission.gone)
      const option = pending?.options?.find((candidate) => /allow/i.test(`${candidate.kind} ${candidate.optionId}`)) ?? pending?.options?.[0]
      if (pending && option) void owner?.permission(id, pending.id, { kind: "choice", optionId: option.optionId }).catch(() => {})
    } })
    await owner.start(harness, sandbox.project, { conversationId: id, ...modeId && { modeId } })
    owner.submit(id, first, "Run the sleep command, then say done.")
    const startBy = Date.now() + 60_000
    while (!began() && Date.now() < startBy) await delay(50)
    if (!began()) {
      const held = owner.snapshot(id)
      throw new Error(`${harness} never asked the stand-in: session ${held?.session.status}/${held?.session.connection} ${held?.session.error ?? ""}; requests ${held?.requests.map((request) => `${request.status}${request.error ? ` (${request.error})` : ""}`).join(", ")}`)
    }
    await delay(STEER_AFTER_MS)
    for (let i = 0; !owner.snapshot(id)?.requests.find((request) => request.id === first)?.nativeRun && i < 100; i++) await delay(20)
    result.acted = Date.now() - began()
    const receipt = await owner.act(id, { kind: "steer", id: randomUUID(), requestId: first, text: `${nonce}: before you answer, say you heard this.`, attachments: [] })
    result.answered = Date.now() - began()
    const steering = raw.steering
    result.outcome = `${steering.kind === "supported" ? steering.landing ?? "native" : "none"}, ${receipt.state.kind}`
    const settleBy = Date.now() + 90_000
    while (Date.now() < settleBy && !result.heard.some((heard) => heard.steered)) await delay(50)
    result.turnEnded = Date.now() - began()
    if (process.env["PROBE_DEBUG"]) {
      const held = owner.snapshot(id)
      console.log(JSON.stringify({ session: { status: held?.session.status, connection: held?.session.connection, error: held?.session.error, lastStop: held?.session.lastStop }, requests: held?.requests.map((request) => ({ text: request.text.slice(0, 40), status: request.status, error: request.error, interruption: request.interruption?.reason })) }, null, 1))
    }
  } finally {
    owner?.stop()
    await Promise.resolve(raw.close(id)).catch(() => {})
    await close()
    await rm(root, { recursive: true, force: true }).catch(() => {})
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      await writeFile(join(evidence, `${harness}-lands.json`), sandbox.scrub(JSON.stringify({ ...result, events: [] }, null, 1)))
    }
  }
  return result
}

/** The probe in one line: when it was taken, whether the command was cut short, when the model heard it. */
function verdict(run: Probe): string {
  const seconds = (ms: number | undefined) => ms === undefined ? "never" : `${(ms / 1000).toFixed(1)} s`
  const next = run.heard[0]
  const cut = next ? !next.slept && next.at < SLEEP_S * 1000 : undefined
  if (run.kind === "baseline")
    return `no message: next request at ${seconds(next?.at)}, ${next?.slept ? "with the command's output" : "without the command's output"}; turn ended ${seconds(run.turnEnded)}`
  if (run.kind === "stop")
    return `stop at ${seconds(run.acted)}: answered ${seconds(run.answered)}, turn ended ${seconds(run.turnEnded)}; the command ${run.heard.some((heard) => heard.slept) ? "finished and its output reached the model" : "never reported its output"}`
  if (run.kind === "lands") {
    const index = run.heard.findIndex((candidate) => candidate.steered)
    const heard = run.heard[index]
    const waited = !heard || heard.at >= SLEEP_S * 1000 || run.heard.slice(0, index + 1).some((candidate) => candidate.slept)
    return `${waited ? "FAILED, not heard while the command ran: " : ""}sent at ${seconds(run.acted)} (${run.outcome}): the model heard it ${heard ? `at ${seconds(heard.at)}, ${seconds(heard.at - run.acted!)} after it was sent, ${heard.slept ? "with" : "without"} the command's output` : "never"}`
  }
  const firstSteered = run.heard.findIndex((heard) => heard.steered)
  const where = firstSteered === -1 ? "never in this turn" : firstSteered === 0 ? "in the very next model request" : `in model request ${firstSteered + 1} after the command`
  return `steer at ${seconds(run.acted)}: ${run.outcome} at ${seconds(run.answered)}; next request at ${seconds(next?.at)}, command ${cut === undefined ? "not seen" : cut ? "cut short" : "ran to its end"}; the model heard it ${where}; turn ended ${seconds(run.turnEnded)}`
}

const drivers = sealedDrivers([installClaude, installCodex, installOpenCode, installGrok, installDevin])
const harnesses = named.length ? named : cursor ? [] : [...SHELLS.keys()]
const kinds = args.includes("--lands") ? ["lands"] as const : ["baseline", "steer", "stop", "lands"] as const
const lines: string[] = []
for (const harness of harnesses) {
  const driver = drivers.get(harness)
  if (!driver || !SHELLS.has(harness)) throw new Error(`${harness} has no probe here: ${[...SHELLS.keys()].join(", ")}`)
  if (!driver.available(process.cwd())) {
    lines.push(`${harness}: skipped, not installed`)
    continue
  }
  for (const kind of kinds) {
    // Codex's app-server serves every conversation of its engine and outlives one's close, so its scratch folder can
    // still be in use as the run ends: what the run read stands either way.
    let run: Probe | undefined
    let failed: unknown
    try {
      await sandboxed("mako-steer-probe", harness, async (sandbox) => { run = await probe(harness, kind, sandbox, driver).catch((error) => { failed = error; return undefined }) })
    } catch (error) {
      failed ??= error
    }
    if (!run) lines.push(`${harness} ${kind}: FAILED ${failed instanceof Error ? failed.message : String(failed)}`)
    if (run) lines.push(`${harness} ${kind}: ${verdict(run)}`)
    console.log(lines.at(-1))
  }
}

if (cursor) {
  const { readPersonSignIns, seedScratchHome } = await import("./scratch-harness-home.ts")
  const { removeScratch } = await import("./lib/scratch-processes.mjs")
  const { installCursor } = await import("@mako/host/harnesses/cursor/index")
  const root = await realpath(await mkdtemp(join(tmpdir(), "mako-steer-probe-cursor-")))
  const scratch = seedScratchHome(root, { cursor: readPersonSignIns().cursor }, { trusted: [join(root, "project")] })
  try {
    await mkdir(join(root, "project", ".git"), { recursive: true })
    const driver = sealedDrivers([installCursor]).get("cursor")!
    for (const kind of args.includes("--lands") ? ["lands", "lands-held"] as const : ["steer", "stop", "lands", "steer-held", "lands-held"] as const) {
      const run = await cursorProbe(kind, driver, join(root, "project"), scratch.env)
      lines.push(`cursor ${kind}: ${run}`)
      console.log(lines.at(-1))
    }
  } finally {
    scratch.dispose()
    await removeScratch(root)
  }
}

/**
 * Cursor on its real model: asked to run the sleep, steered, stopped or sent a message the way Mako lands the
 * person's (`land`) while it runs, read from its events alone. `-held`: the sleep runs in a subagent, which Cursor
 * holds a steer through until it returns.
 */
async function cursorProbe(kind: "steer" | "stop" | "lands" | "steer-held" | "lands-held", driver: ProviderLiveDriver, project: string, env: NodeJS.ProcessEnv): Promise<string> {
  const held = kind.endsWith("-held")
  const sleepS = held ? 60 : SLEEP_S
  if (kind === "lands" || kind === "lands-held") return cursorHosted(held, sleepS, driver, project, env)
  const id = randomUUID()
  const nonce = `STEER-${randomUUID().slice(0, 8)}`
  const events: { at: number; event: LiveDriverEvent }[] = []
  const began = Date.now()
  const emit = (event: LiveDriverEvent) => events.push({ at: Date.now() - began, event })
  const updates = () => events.flatMap(({ at, event }) => (event.type === "live-update" ? [event.update] : event.type === "live-updates" ? event.updates : []).map((update) => ({ at, update })))
  const session = () => events.findLast(({ event }) => event.type === "live-session")?.event
  const status = () => { const last = session(); return last?.type === "live-session" ? last.session : undefined }
  // The model's words come in pieces: the nonce is answered once what it wrote so far holds it.
  const answeredAt = () => {
    let written = ""
    for (const { at, update } of updates()) {
      if (update.kind !== "text") continue
      written += update.text
      if (written.includes(nonce)) return { at }
    }
    return undefined
  }
  try {
    await driver.start(project, admitted("cursor", { conversationId: id, emit, mcpSnapshot: async () => ({ cwd: project, generatedAt: Date.now(), servers: [], providers: [] }) }, { env }))
    const command = `sleep ${sleepS} && echo ${ECHO_DONE}`
    void driver.prompt(id, held
      ? `Start one subagent with your task tool and have it run exactly this shell command in the foreground and wait for it: \`${command}\`. Wait for the subagent to finish, then reply with one short sentence.`
      : `Run exactly this shell command in the foreground and wait for it: \`${command}\`. Then reply with one short sentence.`, [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
    const toolBy = Date.now() + 90_000
    let toolAt: number | undefined
    while (Date.now() < toolBy && toolAt === undefined) {
      toolAt = updates().find(({ update }) => update.kind === "tool" && (held ? /task|subagent|sleep/i : /sleep/).test(JSON.stringify(update)))?.at
      await delay(100)
    }
    if (toolAt === undefined) return "FAILED the model never ran the sleep"
    await delay(STEER_AFTER_MS)
    const acted = Date.now() - began
    let outcome: string
    const words = `${nonce}: reply with exactly this word and nothing else: ${nonce}`
    if (kind === "steer" || kind === "steer-held") {
      const steering = driver.steering
      const runId = status()?.nativeRunId
      if (steering.kind !== "supported" || !runId) return "FAILED no steering or no run"
      outcome = await steering.steer(id, { id: randomUUID(), expectedRunId: runId, text: words, attachments: [] })
        .then((taken) => taken.kind === "accepted" ? "accepted" : `not accepted: ${taken.reason}`, (error) => `threw: ${error instanceof Error ? error.message : String(error)}`)
    } else {
      await driver.cancel(id)
      outcome = "stop sent"
    }
    const answered = Date.now() - began
    const settleBy = Date.now() + 180_000
    let ended: number | undefined
    while (Date.now() < settleBy) {
      const now = status()?.status
      // A landed message runs a turn of its own, after the one it stopped: it's over once the model answered it.
      const answeredIt = answeredAt() !== undefined
      if (now !== "running" && now !== "starting" && (!kind.startsWith("lands") || answeredIt || Date.now() - began - acted > 60_000)) { ended = Date.now() - began; break }
      await delay(100)
    }
    const toolDone = updates().find(({ update }) => update.kind === "tool" && JSON.stringify(update).includes("sleep") && /completed|failed|canceled/.test(update.status ?? ""))
    const heard = answeredAt()
    const s = (ms: number | undefined) => ms === undefined ? "never" : `${((ms - toolAt!) / 1000).toFixed(1)} s`
    const after = heard ? `, ${((heard.at - acted) / 1000).toFixed(1)} s after it was sent` : ""
    return `${kind} at ${s(acted)} into the command: ${outcome} at ${s(answered)}; the command ended at ${s(toolDone?.at)}${toolDone && toolDone.at - toolAt < sleepS * 1000 ? " (cut short)" : ""}; ${kind !== "stop" ? `the model answered it at ${s(heard?.at)}${after}; ` : ""}turn ended at ${s(ended)}`
  } finally {
    await Promise.resolve(driver.close(id)).catch(() => {})
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      await writeFile(join(evidence, `cursor-${kind}.json`), JSON.stringify(events, null, 1))
    }
  }
}

/**
 * The person's message into a running Cursor turn through Mako's own host, which lands it by `confirm`: Cursor's own
 * steer when it confirms delivery within `STEER_LANDS_MS`, else a stop and the message as the next one. Read from the
 * conversation's transcript as the host keeps it, polled.
 */
async function cursorHosted(held: boolean, sleepS: number, raw: ProviderLiveDriver, project: string, env: NodeJS.ProcessEnv): Promise<string> {
  const driver: ProviderLiveDriver = { ...raw, start: (cwd, options) => raw.start(cwd, admitted("cursor", { ...options, mcpSnapshot: options.mcpSnapshot ?? (async () => ({ cwd, generatedAt: Date.now(), servers: [], providers: [] })) }, { env })) }
  const root = await mkdtemp(join(tmpdir(), "mako-steer-probe-host-"))
  const owner = new LiveConversations({ root, appPath: root, driver: (provider) => provider === "cursor" ? driver : undefined, history: async () => null, resumeVerdict: async () => ({ kind: "resumable", record: "same" }), emit: () => {} })
  const id = randomUUID(), first = randomUUID()
  const nonce = `STEER-${randomUUID().slice(0, 8)}`
  const blocks = () => owner.snapshot(id)?.blocks ?? []
  try {
    await owner.start("cursor", project, { conversationId: id })
    const command = `sleep ${sleepS} && echo ${ECHO_DONE}`
    owner.submit(id, first, held
      ? `Start one subagent with your task tool and have it run exactly this shell command in the foreground and wait for it: \`${command}\`. Wait for the subagent to finish, then reply with one short sentence.`
      : `Run exactly this shell command in the foreground and wait for it: \`${command}\`. Then reply with one short sentence.`)
    const toolBy = Date.now() + 90_000
    while (Date.now() < toolBy && !blocks().some((block) => block.type === "tool" && (held ? /task|subagent|sleep/i : /sleep/).test(JSON.stringify(block)))) await delay(100)
    if (Date.now() >= toolBy) return "FAILED the model never ran the sleep"
    await delay(STEER_AFTER_MS)
    const sent = Date.now()
    const receipt = await owner.act(id, { kind: "steer", id: randomUUID(), requestId: first, text: `${nonce}: reply with exactly this word and nothing else: ${nonce}`, attachments: [] })
    const answered = Date.now() - sent
    const heardBy = Date.now() + 120_000
    let heard: number | undefined
    while (Date.now() < heardBy && heard === undefined) {
      if (blocks().some((block) => block.type === "text" && block.text.includes(nonce))) heard = Date.now() - sent
      else await delay(50)
    }
    const restarted = owner.snapshot(id)?.requests.find((request) => request.id === first)?.interruption?.reason === "steered"
    const s = (ms: number | undefined) => ms === undefined ? "never" : `${(ms / 1000).toFixed(1)} s`
    return `lands${held ? "-held" : ""}: ${receipt.state.kind} ${s(answered)} after it was sent, ${restarted ? "its turn stopped and the message sent next" : "Cursor's own steer"}; the model answered it ${s(heard)} after it was sent`
  } finally {
    owner.stop()
    await Promise.resolve(raw.close(id)).catch(() => {})
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

console.log(`\n${lines.join("\n")}`)
process.exit(lines.some((line) => line.includes("FAILED")) ? 1 : 0)

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
//   command's output ever reached the model.
//
// Cursor has no stand-in for its model: `--cursor` runs it on the person's
// sign-in, copied into a scratch home, against its real model.
//
//   npx tsx scripts/probe-steer-semantics.ts [<harness>...] [--cursor] [--evidence <dir>]
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
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
  kind: "steer" | "stop" | "baseline"
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

/** The probe in one line: when it was taken, whether the command was cut short, when the model heard it. */
function verdict(run: Probe): string {
  const seconds = (ms: number | undefined) => ms === undefined ? "never" : `${(ms / 1000).toFixed(1)} s`
  const next = run.heard[0]
  const cut = next ? !next.slept && next.at < SLEEP_S * 1000 : undefined
  if (run.kind === "baseline")
    return `no message: next request at ${seconds(next?.at)}, ${next?.slept ? "with the command's output" : "without the command's output"}; turn ended ${seconds(run.turnEnded)}`
  if (run.kind === "stop")
    return `stop at ${seconds(run.acted)}: answered ${seconds(run.answered)}, turn ended ${seconds(run.turnEnded)}; the command ${run.heard.some((heard) => heard.slept) ? "finished and its output reached the model" : "never reported its output"}`
  const firstSteered = run.heard.findIndex((heard) => heard.steered)
  const where = firstSteered === -1 ? "never in this turn" : firstSteered === 0 ? "in the very next model request" : `in model request ${firstSteered + 1} after the command`
  return `steer at ${seconds(run.acted)}: ${run.outcome} at ${seconds(run.answered)}; next request at ${seconds(next?.at)}, command ${cut === undefined ? "not seen" : cut ? "cut short" : "ran to its end"}; the model heard it ${where}; turn ended ${seconds(run.turnEnded)}`
}

const drivers = sealedDrivers([installClaude, installCodex, installOpenCode, installGrok, installDevin])
const harnesses = named.length ? named : cursor ? [] : [...SHELLS.keys()]
const lines: string[] = []
for (const harness of harnesses) {
  const driver = drivers.get(harness)
  if (!driver || !SHELLS.has(harness)) throw new Error(`${harness} has no probe here: ${[...SHELLS.keys()].join(", ")}`)
  if (!driver.available(process.cwd())) {
    lines.push(`${harness}: skipped, not installed`)
    continue
  }
  for (const kind of ["baseline", "steer", "stop"] as const) {
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
    for (const kind of ["steer", "stop"] as const) {
      const run = await cursorProbe(kind, driver, join(root, "project"), scratch.env)
      lines.push(`cursor ${kind}: ${run}`)
      console.log(lines.at(-1))
    }
  } finally {
    scratch.dispose()
    await removeScratch(root)
  }
}

/** Cursor on its real model: asked to run the sleep, steered or stopped while it runs, read from its events alone. */
async function cursorProbe(kind: "steer" | "stop", driver: ProviderLiveDriver, project: string, env: NodeJS.ProcessEnv): Promise<string> {
  const id = randomUUID()
  const nonce = `STEER-${randomUUID().slice(0, 8)}`
  const events: { at: number; event: LiveDriverEvent }[] = []
  const began = Date.now()
  const emit = (event: LiveDriverEvent) => events.push({ at: Date.now() - began, event })
  const updates = () => events.flatMap(({ at, event }) => (event.type === "live-update" ? [event.update] : event.type === "live-updates" ? event.updates : []).map((update) => ({ at, update })))
  const session = () => events.findLast(({ event }) => event.type === "live-session")?.event
  const status = () => { const last = session(); return last?.type === "live-session" ? last.session : undefined }
  try {
    await driver.start(project, admitted("cursor", { conversationId: id, emit, mcpSnapshot: async () => ({ cwd: project, generatedAt: Date.now(), servers: [], providers: [] }) }, { env }))
    void driver.prompt(id, `Run exactly this shell command in the foreground and wait for it: \`sleep ${SLEEP_S} && echo ${ECHO_DONE}\`. Then reply with one short sentence.`, [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
    const toolBy = Date.now() + 90_000
    let toolAt: number | undefined
    while (Date.now() < toolBy && toolAt === undefined) {
      toolAt = updates().find(({ update }) => update.kind === "tool" && JSON.stringify(update).includes("sleep"))?.at
      await delay(100)
    }
    if (toolAt === undefined) return "FAILED the model never ran the sleep"
    await delay(STEER_AFTER_MS)
    const acted = Date.now() - began
    let outcome: string
    if (kind === "steer") {
      const steering = driver.steering
      const runId = status()?.nativeRunId
      if (steering.kind !== "supported" || !runId) return "FAILED no steering or no run"
      outcome = await steering.steer(id, { id: randomUUID(), expectedRunId: runId, text: `${nonce}: reply with exactly this word and nothing else: ${nonce}`, attachments: [] })
        .then((taken) => taken.kind === "accepted" ? "accepted" : `not accepted: ${taken.reason}`, (error) => `threw: ${error instanceof Error ? error.message : String(error)}`)
    } else {
      await driver.cancel(id)
      outcome = "stop sent"
    }
    const answered = Date.now() - began
    const settleBy = Date.now() + 120_000
    let ended: number | undefined
    while (Date.now() < settleBy) {
      const now = status()?.status
      if (now !== "running" && now !== "starting") { ended = Date.now() - began; break }
      await delay(100)
    }
    const toolDone = updates().find(({ update }) => update.kind === "tool" && JSON.stringify(update).includes("sleep") && /completed|failed|canceled/.test(update.status ?? ""))
    const heard = updates().find(({ update }) => update.kind !== "user" && JSON.stringify(update).includes(nonce))
    const s = (ms: number | undefined) => ms === undefined ? "never" : `${((ms - toolAt!) / 1000).toFixed(1)} s`
    return `${kind} at ${s(acted)} into the command: ${outcome} at ${s(answered)}; the command ended at ${s(toolDone?.at)}${toolDone && toolDone.at - toolAt < SLEEP_S * 1000 ? " (cut short)" : ""}; ${kind === "steer" ? `the model answered it at ${s(heard?.at)}; ` : ""}turn ended at ${s(ended)}`
  } finally {
    await Promise.resolve(driver.close(id)).catch(() => {})
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      await writeFile(join(evidence, `cursor-${kind}.json`), JSON.stringify(events, null, 1))
    }
  }
}

console.log(`\n${lines.join("\n")}`)
process.exit(lines.some((line) => line.includes("FAILED")) ? 1 : 0)

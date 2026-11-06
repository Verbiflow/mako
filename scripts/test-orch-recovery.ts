import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ThreadPage, ThreadRef } from "@mako/sessions"
import { followHostLog } from "@mako/host/base/host-log"
import type { z } from "zod"
import type { InterruptionReason, LiveRequest } from "@mako/host/contracts/live-conversations"
import { LiveRequestSchema } from "@mako/host/conversations/live-journal"
import { BRIEF_AGAIN } from "@mako/host/contracts/children"
import { finResumedText, RESUMED_OPENS } from "@mako/host/contracts/resume-account"
import { continueTurnPrompt, opensContinuation, RESTART_CHAIN, savedContinuation, strandedTurn } from "@mako/host/contracts/turn-continuation"
import type { AgentsDeps } from "@mako/host/conversations/agents"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { AgentsWorld, type Heard, type Script } from "./lib/agents-world.ts"

/**
 * Fins come back from anything that cuts them (`npm run test:orch-recovery`),
 * each host its own process, killed as a crash or a power loss kills it:
 *
 * - loop: a Fin's turn is cut by SIGKILL again and again. Mako continues it
 *   `RESTART_CHAIN` times, then stops, and its Apex is asked, with what cut it
 *   and why Mako stopped; its Apex's Continue lets it finish.
 * - apex: SIGKILL mid-turn of the Apex itself, whose Fins' work rests on it:
 *   the next host continues its turn as a Fin's.
 * - quit: Mako quits mid-turn of the Apex: the next host continues it, though
 *   the person never turned on continuing their own turns after a restart.
 * - power: the Mac goes off under a CLI its Apex's shell linked (the host and
 *   the run's process both gone). Its Apex is asked; Continue resumes its
 *   session in Mako, with the account of what landed in its checkout meanwhile.
 *
 * - raced: a Fin's turn is cut by SIGKILL, and as the next host reads what moved in its checkout, slowly, its Apex
 *   stops it, the person writes to it, or that host dies too: a stopped Fin hears nothing, no continuation follows the
 *   person's words, and one cut in its read goes on the host after, once. And a linked run's Continue with a Stop while
 *   its session opens: it waits under the Stop.
 *
 * Every continuation carries the account a resumed Fin reads (`finResumedText`).
 */
const SCENARIOS = ["loop", "apex", "quit", "power"] as const
type Scenario = (typeof SCENARIOS)[number] | "raced"
const RUN_MS = 60_000
const HARNESS = "claude"
const SECOND_PART = "Now the second part."

interface State {
  apex: string
  run?: { pid: number; nativeId: string }
}

type Line = Heard | { kind: "log"; message: string }

const statePath = (root: string) => join(root, "state.json")
const heardPath = (root: string) => join(root, "heard.ndjson")
const readState = (root: string): State => JSON.parse(readFileSync(statePath(root), "utf8"))
const lines = (root: string): Line[] => existsSync(heardPath(root)) ? readFileSync(heardPath(root), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []

async function until(what: string, done: () => boolean, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** The Sessions the catalog lists, kept in a file so the next host lists the same ones. */
function fileCatalog(root: string): AgentsDeps["catalog"] {
  const refs = (): ThreadRef[] => (existsSync(join(root, "catalog.json")) ? JSON.parse(readFileSync(join(root, "catalog.json"), "utf8")) : [])
  return {
    nativePath: (identity) => refs().find((ref) => ref.harness === identity.harness && ref.nativeId === identity.nativeId)?.path,
    ref: (path) => refs().find((ref) => ref.path === path),
    page: async (path): Promise<ThreadPage | null> => {
      const ref = refs().find((each) => each.path === path)
      return ref ? { ref, entries: [], start: 0, total: 0, hasEarlier: false } : null
    },
    activity: () => ({}),
    subscribe: () => () => {},
    announce: () => {},
  }
}

// ── One host, run as its own process ──

async function host(root: string, scenario: Scenario, first: boolean): Promise<void> {
  const write = (line: Line) => appendFileSync(heardPath(root), `${JSON.stringify(line)}\n`)
  const die = (why: string) => {
    write({ kind: "log", message: `killed: ${why}` })
    process.kill(process.pid, "SIGKILL")
  }
  const finish = join(root, "finish")
  const state = () => (existsSync(statePath(root)) ? readState(root) : undefined)
  let world: AgentsWorld
  followHostLog((line) => {
    if (line.scope !== "agents") return
    write({ kind: "log", message: line.message })
    if (line.message !== "start admitted" || !first) return
    if (scenario === "apex") die("mid-turn of the Apex")
    // A quit, as the person's Quit or an update ends Mako: every turn is cut and left for the next host.
    if (scenario === "quit") setTimeout(() => void world.close().then(() => process.exit(0)), 100)
  })
  const script: Script = async (turn) => {
    const apex = turn.conversation === state()?.apex
    if (apex) {
      if (turn.text === "Start the work.") {
        await turn.world.agents.start(turn.caller, { brief: { objective: "Work it out." }, harness: HARNESS, name: "worker", clientKey: "worker", cwd: root })
        // The Apex goes on with its own part, which the cut stops.
        if (scenario !== "loop") await new Promise(() => {})
        return "Started it."
      }
      if (turn.text.includes(FROM_AGENTS) && turn.text.includes("cut short")) {
        writeFileSync(finish, "")
        // Asked twice at once, as two windows of one Apex can: it goes on once.
        const answer = (clientKey: string) => turn.world.agents.answer(turn.caller, { to: scenario === "power" ? "cli" : "worker", answer: "Continue", clientKey })
        await Promise.all([answer("continue"), answer("continue-again")])
        return "Continued it."
      }
      return opensContinuation(turn.text) ? "Picked up where I was." : "Noted."
    }
    if (scenario === "loop" && !existsSync(finish)) return new Promise(() => {})
    return scenario === "power" ? "Carried on." : "Worked it out."
  }
  const store = () => world.store
  world = new AgentsWorld({
    root,
    script,
    catalog: fileCatalog(root),
    heard: (heard) => {
      write(heard)
      // A Fin's turn of the loop is cut as soon as its harness takes it, until its Apex decides.
      if (scenario === "loop" && heard.kind === "prompt" && heard.conversation !== state()?.apex && !existsSync(finish)) die("mid-turn of the Fin")
      if (scenario === "raced" && heard.text.includes(SECOND_PART)) die("mid-turn of the Fin")
    },
  })
  if (scenario === "raced" && !first) {
    setInterval(() => {
      if (!existsSync(join(root, "git-reached"))) return
      const conversation = world.live.summaries().map((summary) => summary.session.id).find((id) => id !== state()?.apex)
      const pending = conversation ? world.live.snapshot(conversation)?.requests.find((request) => request.continues?.auto && request.status === "dispatching") : undefined
      if (!pending) return
      writeFileSync(join(root, "killed-in-read"), pending.id)
      die("in its read of what moved")
    }, 10)
    return void (await new Promise(() => {}))
  }
  if (first) {
    const apex = await world.apex(HARNESS, "full")
    if (scenario === "raced") {
      writeFileSync(statePath(root), JSON.stringify({ apex: apex.conversation } satisfies State))
      const started = await world.agents.start(apex.caller, { brief: { objective: "Work it out." }, harness: HARNESS, name: "worker", clientKey: "worker", cwd: repository(join(root, "checkout")) })
      assert.ok(!("refused" in started), JSON.stringify(started))
      await until("its brief's turn to end", () => world.agents.diagnostics().running === 0 && store().edges().all.some((edge) => store().reportsOf(edge.child, 0).length > 0))
      await world.agents.send(apex.caller, { to: "worker", text: SECOND_PART, clientKey: "second" })
      await new Promise((resolve) => setTimeout(resolve, RUN_MS))
      return
    }
    if (scenario === "power") {
      // A CLI its shell ran, followed by its process; then the Mac goes off, taking both.
      const shell = spawn("/bin/sh", ["-c", "sleep 60"], { detached: true, stdio: "ignore" })
      shell.unref()
      const nativeId = "cli-session"
      const checkout = repository(join(root, "checkout"))
      const at = new Date().toISOString()
      writeFileSync(join(root, "catalog.json"), JSON.stringify([{ harness: HARNESS, nativeId, path: join(root, "cli", `${nativeId}.jsonl`), cwd: checkout, startedAt: at, updatedAt: at }]))
      writeFileSync(statePath(root), JSON.stringify({ apex: apex.conversation, run: { pid: shell.pid!, nativeId } } satisfies State))
      const linked = await world.agents.link(apex.caller, { harness: HARNESS, session: nativeId, pid: shell.pid!, name: "cli" })
      assert.ok(!("refused" in linked), JSON.stringify(linked))
      die("the power went")
    }
    writeFileSync(statePath(root), JSON.stringify({ apex: apex.conversation } satisfies State))
    world.say(apex.conversation, "Start the work.")
    await new Promise((resolve) => setTimeout(resolve, RUN_MS))
    return
  }
  const done = () => store().edges().all.length > 0 && store().edges().all.every((edge) => store().reportsOf(edge.child, 0).at(-1)?.status === "done") && store().undeliveredReports().length === 0
  await until("the Fins to finish", done, RUN_MS - 10_000)
  await world.settle()
  writeFileSync(join(root, "settled.json"), JSON.stringify({ reports: store().edges().all.flatMap((edge) => store().reportsOf(edge.child, 0).map((report) => ({ id: report.id, status: report.status, summary: report.summary }))) }))
  await world.close()
}

function run(args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", import.meta.filename, "--host", ...args], { stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
    const timer = setTimeout(() => child.kill("SIGKILL"), RUN_MS + 30_000)
    child.on("exit", (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stderr })
    })
  })
}

// ── The scenarios ──

async function scenario(base: string, which: Scenario): Promise<void> {
  const root = join(base, which)
  mkdirSync(root, { recursive: true })
  const opened = await run([root, which, "first"])
  if (which === "quit") assert.equal(opened.code, 0, `the first host quits (${opened.signal ?? opened.code}): ${opened.stderr.slice(-800)}`)
  else assert.equal(opened.signal, "SIGKILL", `the first host is killed (${opened.code}): ${opened.stderr.slice(-800)}`)
  let kills = 1
  let last = opened
  for (let attempt = 0; attempt < RESTART_CHAIN + 3; attempt += 1) {
    if (which === "power" && attempt === 0) {
      try { process.kill(readState(root).run!.pid, "SIGKILL") } catch {}
      // While the Mac was off, someone else's commit landed in its checkout.
      writeFileSync(join(root, "checkout", "header.ts"), "fixed\n")
      scratchGit(join(root, "checkout"), ["add", "header.ts"])
      scratchGit(join(root, "checkout"), ["commit", "-q", "-m", "Fix the header"], new Date(Date.now() + 5_000))
    }
    last = await run([root, which, "next"])
    if (last.signal !== "SIGKILL") break
    kills += 1
  }
  assert.equal(last.code, 0, `${which}: the last host settles (${last.signal ?? last.code}): ${last.stderr.slice(-1500)}`)
  const heard = lines(root)
  const state = readState(root)
  const prompts = heard.filter((line): line is Heard => line.kind === "prompt")
  const apex = prompts.filter((prompt) => prompt.conversation === state.apex)
  const fin = prompts.filter((prompt) => prompt.conversation !== state.apex)
  const settled: { reports: { id: string; status: string; summary: string }[] } = JSON.parse(readFileSync(join(root, "settled.json"), "utf8"))
  const digests = apex.filter((prompt) => prompt.text.includes(FROM_AGENTS))
  switch (which) {
    case "loop": {
      assert.equal(kills, 1 + RESTART_CHAIN, `its turn was continued ${RESTART_CHAIN} times, each cut too, and then not again`)
      // Cut at its brief each time, with nothing to say its harness had it: each goes as the brief again, never a bare Continue.
      const continued = fin.filter((prompt) => prompt.text.includes(BRIEF_AGAIN))
      assert.equal(continued.length, RESTART_CHAIN + 1, "Mako's continuations, then the one its Apex asked for")
      assert.equal(fin.filter((prompt) => opensContinuation(prompt.text)).length, 0, "and none of them bare")
      const asked = digests.find((prompt) => prompt.text.includes("cut short"))
      assert.ok(asked, "its Apex is asked once Mako stops continuing it")
      assert.match(asked.text, /Mako stopped without closing: a crash, a force quit, or this Mac shutting down or losing power/, "with what cut it")
      assert.match(asked.text, new RegExp(`Mako continued it ${RESTART_CHAIN} times in a row and each was cut short too, so it stopped trying`), "and why it didn't go on")
      assert.match(asked.text, /options: Continue \(recommended\) · Stop/, "answered with one call")
      assert.equal(settled.reports.at(-1)?.summary, "Worked it out.", "its Apex's Continue let it finish")
      break
    }
    case "apex":
    case "quit": {
      const picked = apex.filter((prompt) => opensContinuation(prompt.text))
      assert.equal(picked.length, 1, `the Apex's own cut turn was continued once (${which})`)
      assert.match(picked[0]!.text, /Mako closed before you finished the previous turn/)
      assert.equal(settled.reports.at(-1)?.status, "done", "and its Fin finished")
      break
    }
    case "power": {
      const asked = digests.find((prompt) => prompt.text.includes("cut short"))
      assert.ok(asked, "its Apex is asked about a run the power took")
      assert.match(asked.text, /Its process ended while Mako wasn't running: a quit, a crash, or this Mac shutting down or restarting/, "with what ended it")
      const resumed = fin.find((prompt) => opensContinuation(prompt.text))
      assert.ok(resumed, "Continue resumed its session in Mako")
      assert.ok(resumed.text.startsWith(continueTurnPrompt("provider-exited", "mako")), "with the words of a process that stopped")
      assert.equal(fin.filter((prompt) => opensContinuation(prompt.text)).length, 1, "once, though Continue was answered twice at once")
      assert.ok(resumed.text.includes(`${RESUMED_OPENS}a cut`), "beneath them, the account of a resume")
      assert.match(resumed.text, /Fix the header/, "naming what landed in its checkout meanwhile")
      assert.equal(settled.reports.at(-1)?.summary, "Carried on.", "and its turn there reports how it went")
      break
    }
  }
  console.log(`${which}: ok (${kills} ${kills === 1 ? "cut" : "cuts"})`)
}

/** The next host of a cut Fin, its `git` waiting for a word: what's done meanwhile crosses the read of what moved since the cut. */
async function raced(base: string, how: "stop" | "person" | "crash"): Promise<void> {
  const root = join(base, `raced-${how}`)
  mkdirSync(root, { recursive: true })
  const killed = await run([root, "raced", "first"])
  assert.equal(killed.signal, "SIGKILL", `the first host is killed (${killed.code}): ${killed.stderr.slice(-800)}`)
  const gate = join(root, "git-gate")
  const reached = join(root, "git-reached")
  const shim = join(root, "bin")
  mkdirSync(shim)
  const real = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim()
  // `rev-parse --local-env-vars` is scratch-git's own, as a host's process starts: only what the host reads waits.
  writeFileSync(join(shim, "git"), `#!/bin/sh\ncase "$*" in *--local-env-vars*) exec "${real}" "$@";; esac\n[ -e "${gate}" ] && touch "${reached}"\nwhile [ -e "${gate}" ]; do sleep 0.02; done\nexec "${real}" "$@"\n`, { mode: 0o755 })
  writeFileSync(gate, "")
  const path = process.env.PATH
  process.env.PATH = `${shim}:${path}`
  if (how === "crash") {
    const again = await run([root, "raced", "next"])
    assert.equal(again.signal, "SIGKILL", `the next host dies in its read (${again.code}): ${again.stderr.slice(-800)}`)
    // A kill by the timeout in `run` is a SIGKILL too: only this says the host died where it was meant to.
    assert.ok(existsSync(join(root, "killed-in-read")), `the next host died with its continuation in the read, not of the timeout: ${again.stderr.slice(-800)}`)
    rmSync(gate)
  }
  const heard: Heard[] = []
  const world = new AgentsWorld({ root, script: async () => "ok", catalog: fileCatalog(root), heard: (line) => void heard.push(line) })
  try {
    const apex = readState(root).apex
    const told = () => heard.filter((line) => line.conversation !== apex)
    if (how === "crash") {
      await until("the third host to send the continuation", () => told().some((line) => opensContinuation(line.text)))
      await new Promise((resolve) => setTimeout(resolve, 500))
      assert.equal(told().filter((line) => opensContinuation(line.text)).length, 1, "a continuation cut in its read goes on the next host, once")
      assert.ok(told()[0]!.text.includes(`${RESUMED_OPENS}a cut`), "with the account of what moved")
      console.log("raced (crash): ok")
      return
    }
    await until("the next host to read what moved", () => existsSync(reached))
    if (how === "stop") {
      const stopped = await world.agents.stop(world.caller(apex), { child: "worker", reason: "enough" })
      assert.ok("stopped" in stopped, JSON.stringify(stopped))
    } else world.say(fin(world, apex), "The person's words.")
    rmSync(gate)
    if (how === "stop") {
      await new Promise((resolve) => setTimeout(resolve, 800))
      assert.deepEqual(told().map((line) => line.text.slice(0, 50)), [], "a Fin stopped during the read hears nothing")
    } else {
      await until("the person's words to go", () => told().some((line) => line.text.includes("The person's words.")))
      await new Promise((resolve) => setTimeout(resolve, 800))
      const after = told().slice(told().findIndex((line) => line.text.includes("The person's words.")) + 1)
      assert.deepEqual(after.filter((line) => opensContinuation(line.text)).map((line) => line.text.slice(0, 50)), [], "no continuation follows the person's words")
    }
    console.log(`raced (${how}): ok`)
  } finally {
    process.env.PATH = path
    rmSync(gate, { force: true })
    await world.close()
  }
}

/**
 * The power scenario's linked CLI, its Apex answering Continue, and a Stop while its resumed session opens, before it
 * has a conversation for the Stop to reach: the continuation waits under that Stop, and nothing goes.
 */
async function racedOpen(base: string): Promise<void> {
  const root = join(base, "raced-open")
  mkdirSync(root, { recursive: true })
  const killed = await run([root, "power", "first"])
  assert.equal(killed.signal, "SIGKILL", `the first host is killed (${killed.code}): ${killed.stderr.slice(-800)}`)
  try { process.kill(readState(root).run!.pid, "SIGKILL") } catch {}
  const apex = readState(root).apex
  const heard: Heard[] = []
  let opening: (() => void) | undefined
  let answered: Promise<unknown> | undefined
  const world = new AgentsWorld({
    root,
    catalog: fileCatalog(root),
    heard: (line) => void heard.push(line),
    preparing: (options) => (options.resume ? new Promise<void>((resolve) => { opening = resolve }) : undefined),
    script: async (turn) => {
      if (turn.conversation === apex && turn.text.includes(FROM_AGENTS) && turn.text.includes("cut short")) answered = turn.world.agents.answer(turn.caller, { to: "cli", answer: "Continue", clientKey: "continue" })
      return "ok"
    },
  })
  try {
    await until("its session to open", () => opening !== undefined)
    const stopped = await world.agents.stop(world.caller(apex), { child: "cli", reason: "enough" })
    assert.ok("stopped" in stopped, JSON.stringify(stopped))
    opening!()
    await answered
    await new Promise((resolve) => setTimeout(resolve, 500))
    const told = heard.filter((line) => line.conversation !== apex)
    assert.deepEqual(told.map((line) => line.text.slice(0, 50)), [], "nothing reaches a Fin stopped as its session opened")
    const fin = world.live.summaries().map((summary) => summary.session.id).find((id) => id !== apex)
    const waits = fin ? world.live.snapshot(fin)?.requests.find((request) => opensContinuation(request.text)) : undefined
    assert.deepEqual([waits?.status, waits?.pause], ["held", "stop"], "the continuation waits under the Stop, as any message does")
    console.log("raced (opening): ok")
  } finally {
    opening?.()
    await world.close()
  }
}

/** The Fin's conversation in a world with one Fin. */
function fin(world: AgentsWorld, apex: string): string {
  const conversation = world.live.summaries().map((summary) => summary.session.id).find((id) => id !== apex)
  assert.ok(conversation, "its Fin's conversation")
  return conversation
}

/** Which cut turns nothing picks up: a quit's or a crash's, unless a continuation is scheduled, sent, or something waits behind it. */
function strandedTurns(): void {
  const CUT = "00000000-0000-4000-8000-000000000001"
  const AFTER = "00000000-0000-4000-8000-000000000002"
  type Fields = Partial<z.input<typeof LiveRequestSchema>>
  const request = (fields: Fields): LiveRequest => LiveRequestSchema.parse({ id: AFTER, text: "Work it out.", attachments: [], status: "queued", ...fields })
  const cut = (status: "interrupted" | "uncertain", reason: InterruptionReason, more: Fields = {}) => request({ id: CUT, status, interruption: { reason, at: 1 }, ...more })
  const after = (more: Fields) => request({ id: AFTER, text: "Next.", ...more })
  assert.equal(strandedTurn([cut("interrupted", "host-quit")])?.id, CUT, "a quit's cut")
  assert.equal(strandedTurn([cut("uncertain", "host-crashed")])?.id, CUT, "a crash's, which reads as uncertain")
  assert.equal(strandedTurn([cut("interrupted", "stopped")]), undefined, "a Stop is someone's choice")
  assert.equal(strandedTurn([cut("interrupted", "connection-lost", { interruption: { reason: "connection-lost", at: 1, autoContinue: { at: 2 } } })]), undefined, "Mako's continuation is scheduled")
  assert.equal(strandedTurn([cut("interrupted", "host-quit"), after({ status: "completed", continues: { requestId: CUT, reason: "host-quit", auto: true } })]), undefined, "a continuation was sent")
  assert.equal(strandedTurn([cut("interrupted", "host-quit"), after({})]), undefined, "a message waits behind it")
  assert.equal(strandedTurn([cut("interrupted", "signed-out"), after({ status: "held", signIn: { harness: "claude", account: "a", credential: "c", at: 1 } })])?.id, CUT, "what waits on a sign-in nobody will make doesn't hide it")
  assert.equal(strandedTurn([cut("interrupted", "steered")]), undefined, "a steer's cut has its message next")
  const account = finResumedText({ how: "cut", at: 1, reason: "Mako quit", now: 61_000, checkout: [], branches: [] })
  assert.ok(account.startsWith(`${RESUMED_OPENS}a cut 1 minute ago]`))
  assert.deepEqual(savedContinuation(`${continueTurnPrompt("host-crashed", "mako")}\n\n${account}`), { reason: "host-quit", sender: "mako" }, "a continuation with its account beneath still reads as one")
  console.log("stranded turns: ok")
}

/** A scratch repository with one commit, made before the cut. */
function repository(folder: string): string {
  mkdirSync(folder, { recursive: true })
  scratchGit(folder, ["init", "-q", "-b", "main"])
  scratchGit(folder, ["config", "user.email", "t@example.com"])
  scratchGit(folder, ["config", "user.name", "Test"])
  writeFileSync(join(folder, "header.ts"), "broken\n")
  scratchGit(folder, ["add", "."])
  scratchGit(folder, ["commit", "-q", "-m", "Before the cut"], new Date(Date.now() - 60_000))
  return folder
}

function scratchGit(cwd: string, args: string[], date?: Date): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...(date && { GIT_AUTHOR_DATE: date.toISOString(), GIT_COMMITTER_DATE: date.toISOString() }) } }).trim()
}

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter((each): each is Scenario => SCENARIOS.some((known) => known === each))
  const base = mkdtempSync(join(tmpdir(), "mako-orch-recovery-"))
  let failed = false
  try {
    strandedTurns()
    for (const which of only.length ? only : SCENARIOS) {
      try {
        await scenario(base, which)
      } catch (error) {
        failed = true
        console.error(`${which}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      }
    }
    if (!only.length || process.argv.includes("raced"))
      for (const how of ["stop", "person", "crash"] as const) {
        try {
          await raced(base, how)
        } catch (error) {
          failed = true
          console.error(`raced (${how}): ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
        }
      }
    if (!only.length || process.argv.includes("raced"))
      try {
        await racedOpen(base)
      } catch (error) {
        failed = true
        console.error(`raced (opening): ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      }
  } finally {
    if (!failed) rmSync(base, { recursive: true, force: true })
    else console.error(`stores kept in ${base}`)
  }
  if (failed) process.exit(1)
  console.log("orch recovery: ok")
}

if (process.argv[2] === "--host") {
  const scenarioName = [...SCENARIOS, "raced" as const].find((each) => each === process.argv[4])
  if (!scenarioName) throw new Error(`No scenario ${process.argv[4]}`)
  await host(process.argv[3]!, scenarioName, process.argv[5] === "first")
} else await main()

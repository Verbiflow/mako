import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NativeAgentObservation } from "@mako/host/contracts/native-agents"
import type { PullReading } from "@mako/host/contracts/pull-waits"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { AgentsWorld, type Script } from "./lib/agents-world.ts"

/**
 * What a Fin's turn's end says when the Fin made no report in it (`npm run test:fin-turn-ends`), on a scratch host with
 * scripted harnesses. Each case is one the person hit on 2026-11-16:
 * - queue-rules armed Claude Code's Monitor on its pull requests' CI and ended its turn: Mako wrote "done" for it, and,
 *   since a Monitor is ambient and Claude's level leaves it out, could put its session to sleep, which ends the Monitor.
 *   A Fin whose harness holds work that wakes it (a background command, a Monitor, a subagent) is at work on it, and
 *   its session stays up; once that work settles and the harness's turn reports, that's its result.
 * - If the harness's process ends with that work pending, the work ended with it: the Fin's end says so at once.
 * - fin-models, woken by the pull-request watch on #868, pushed a fix and ended its turn saying it would report when CI
 *   settled, with nothing watching the new run. Mako wrote "done". A Fin whose word is progress hasn't said it's done:
 *   its Apex hears at once that it ended unfinished, as its question with its last words, never as "done".
 */
const root = mkdtempSync(join(tmpdir(), "mako-fin-turn-ends-"))
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(10)
  }
}

const monitor = (state: NativeAgentObservation["state"]): NativeAgentObservation =>
  ({ nativeId: "monitor-ci", title: "CI checks on #783", work: "monitor", ambient: true, background: true, stoppable: true, state })

/** A world whose Fins run `script`, and what the Apex heard and how each Fin stands. */
async function world(name: string, script: Script, options: { readPull?: () => Promise<PullReading | null> } = {}) {
  const w = new AgentsWorld({ root: join(root, name), script, backgroundOutlivesTurn: ["claude"], ...options })
  const apex = await w.apex("claude", "full")
  const start = async (fin: string, objective: string) => {
    const started = await w.agents.start(apex.caller, { brief: { objective }, name: fin, harness: "claude", cwd: w.root, clientKey: fin })
    assert.ok(!("refused" in started), JSON.stringify(started))
    await until(`${fin}'s first turn`, () => w.prompts.some((prompt) => prompt.text.includes(`You're fin:${fin}`)))
    return started.child!
  }
  const conversationOf = (child: string) => w.store.thread(ThreadIdSchema.parse(child))!.sessions.flatMap((session) => w.store.conversationsOf(session))[0]!
  const state = async (fin: string) => {
    const listed = await w.agents.list(apex.caller, {})
    assert.ok("children" in listed)
    return listed.children.find((child) => child.name === fin)!
  }
  const reports = (child: string) => w.store.reportsOf(child)
  const heard = () => w.prompts.filter((prompt) => prompt.conversation === apex.conversation).map((prompt) => prompt.text).join("\n")
  return { w, apex, start, conversationOf, state, reports, heard }
}

/** The harness starts a turn of its own (a Monitor's event, a background command settling), as Claude Code does. */
async function harnessTurn(w: AgentsWorld, conversation: string, during: () => Promise<void>): Promise<void> {
  const session = w.live.snapshot(conversation)!.session
  w.live.observe({ type: "live-session", session: { ...session, status: "running", nativeRunId: "own-turn" } })
  await during()
  w.live.observe({ type: "live-update", id: conversation, update: { kind: "text", text: "CI passed on #783; reported." } })
  w.live.observe({ type: "live-session", session: { ...w.live.snapshot(conversation)!.session, status: "ready" } })
}

async function monitorArmed(): Promise<void> {
  let child = ""
  const f = await world("monitor", async (turn) => {
    if (!turn.text.includes("You're fin:")) return "ok"
    // It arms a Monitor on its PR's CI, as queue-rules did, says it will act on its events, and reports nothing.
    turn.world.live.observe({ type: "live-agent", id: turn.conversation, agent: monitor({ kind: "working" }) })
    return "Monitor is armed for #783. Each failed check is reported as it happens; I'll fix and re-push from those events."
  })
  child = await f.start("queue", "Get #783 green")
  await f.w.settle()
  const conversation = f.conversationOf(child)
  const waiting = await f.state("queue")
  assert.equal(waiting.state.kind, "working", `a Fin whose Monitor runs is at work on it: ${JSON.stringify(waiting.state)}`)
  assert.match(JSON.stringify(waiting), /Waiting for a monitor it left running/, "and says on what")
  assert.deepEqual(f.reports(child), [], "its turn's end wrote no result")
  assert.doesNotMatch(f.heard(), /"queue"/, "nor woke its Apex")
  // Mako keeps the session that holds it up: closing it would end the Monitor, and nothing would wake the Fin.
  assert.equal(f.w.live.hibernateIfIdle(conversation, "idle"), false, "a session holding an armed Monitor isn't put to sleep")
  // The Monitor's event starts the harness's turn; the Fin reports from it, and that's its result.
  await harnessTurn(f.w, conversation, async () => {
    f.w.live.observe({ type: "live-agent", id: conversation, agent: monitor({ kind: "completed" }) })
    await f.w.agents.report(f.w.caller(conversation), { status: "done", summary: "#783 is green at 1a2b3c4.", clientKey: "green" })
  })
  await f.w.settle()
  const done = await f.state("queue")
  assert.equal(done.state.kind, "ended", JSON.stringify(done.state))
  assert.match(f.heard(), /"queue" \(Claude\) done: #783 is green at 1a2b3c4\./, "its Apex hears the result it reported")
  assert.deepEqual(f.reports(child).map((report) => [report.status, report.implicit ?? false]), [["done", false]], "and nothing Mako wrote for it")
  console.log("monitor: working while it runs, the session kept up, the result from the turn its event started")
  await f.w.close()
}

async function monitorDied(): Promise<void> {
  const f = await world("monitor-died", async (turn) => {
    if (!turn.text.includes("You're fin:")) return "ok"
    turn.world.live.observe({ type: "live-agent", id: turn.conversation, agent: monitor({ kind: "working" }) })
    return "Monitor is armed; I'll act on its events."
  })
  const child = await f.start("queue", "Get #783 green")
  await f.w.settle()
  const conversation = f.conversationOf(child)
  assert.equal((await f.state("queue")).state.kind, "working")
  // Its harness's process goes, taking the Monitor with it.
  f.w.live.observe({ type: "live-session", session: { ...f.w.live.snapshot(conversation)!.session, status: "failed", connection: "disconnected", error: "The Claude Code process exited" } })
  await until("its end to be said", () => f.reports(child).length > 0)
  const [report] = f.reports(child)
  assert.equal(report!.status, "failed", JSON.stringify(report))
  assert.match(report!.summary, /process ended while it waited on a monitor it left running \(The Claude Code process exited\)/)
  await f.w.settle()
  assert.match(f.heard(), /"queue" \(Claude\) failed: Its Claude process ended while it waited on a monitor/, "its Apex hears it at once")
  console.log(`monitor died: "${report!.summary}"`)
  await f.w.close()
}

async function promiseAfterWake(): Promise<void> {
  const URL = "https://github.com/acme/app/pull/868"
  let pull: PullReading = { state: "open", url: URL, author: "fin-bot", checks: [{ name: "gate", state: "running" }], reviews: [] }
  const f = await world("woken", async (turn) => {
    if (turn.text.includes("You're fin:")) {
      await turn.world.agents.report(turn.caller, { status: "progress", summary: "Pushed; CI runs.", waitingOn: [{ kind: "pull-request", ref: "acme/app#868", until: "checks" }], clientKey: "pushed" })
      return "Waiting on #868's checks."
    }
    // Woken by Mako's note on #868, it pushes a fix and ends its turn on a promise, with no report: fin-models.
    return "I've pushed a fix and CI is running again on it. I'll report the result when the new run settles."
  }, { readPull: async () => pull })
  const child = await f.start("models", "Get #868 green")
  await f.w.settle()
  assert.deepEqual(f.reports(child).map((report) => [report.status, report.implicit ?? false]), [["progress", false]], "progress on #868's checks: its first turn's end is quiet")
  // The pull-request watch reads a failed check and sends the Fin its note.
  pull = { ...pull, checks: [{ name: "gate", state: "failed", at: Date.now() - 1000 }] }
  await f.w.agents.pulls.tick()
  await f.w.settle(300)
  assert.ok(f.w.prompts.some((prompt) => prompt.text.startsWith("Mako: PR acme/app#868")), "Mako's note woke it")
  const [report] = f.reports(child).filter((each) => each.implicit)
  assert.ok(report, "its turn's end is said")
  assert.equal(report!.status, "needs-input", `not "done": it never said it was ${JSON.stringify(report)}`)
  assert.match(report!.question ?? "", /Its last words: "I've pushed a fix and CI is running again on it\. I'll report the result when the new run settles\."/)
  assert.match(f.heard(), /"models" \(Claude\) is asking: It ended its turn without a result/, "its Apex hears it at once")
  assert.doesNotMatch(f.heard(), /"models" \(Claude\) done/)
  console.log("promise after a wake: its Apex's question, with its last words, not a result")
  await f.w.close()
}

async function unfinished(): Promise<void> {
  const f = await world("unfinished", async (turn) => {
    if (turn.text.includes("You're fin:")) {
      await turn.world.agents.report(turn.caller, { status: "progress", summary: "Half the suites run.", clientKey: "half" })
      return "I'll report when the local suites settle."
    }
    return "ok"
  })
  const child = await f.start("suites", "Run every suite")
  await f.w.settle()
  const [report] = f.reports(child).filter((each) => each.implicit)
  assert.ok(report, "its turn's end is said")
  assert.equal(report!.status, "needs-input", `not "done": it never said it was ${JSON.stringify(report)}`)
  assert.equal(report!.question, `It ended its turn without a result, and nothing it waits on will wake it. Its last words: "I'll report when the local suites settle.". How should it go on?`)
  assert.equal(report!.summary, "I'll report when the local suites settle.")
  assert.match(f.heard(), /"suites"/, "its Apex hears it")
  assert.doesNotMatch(f.heard(), /"suites" \(Claude\) done/, "never as done")
  assert.equal((await f.state("suites")).state.kind, "blocked")
  console.log("unfinished: a silent end after progress nothing watches is its Apex's question, not a result")
  await f.w.close()
}

async function finishedWithoutReport(): Promise<void> {
  // A Fin that never reported progress and answers: its reply is its result, as before.
  const f = await world("plain", async (turn) => turn.text.includes("You're fin:") ? "Labels finished." : "ok")
  const child = await f.start("labels", "Label everything")
  await f.w.settle()
  assert.deepEqual(f.reports(child).map((report) => [report.status, report.summary]), [["done", "Labels finished."]])
  console.log("plain answer: still its result")
  await f.w.close()
}

try {
  const only = process.argv.slice(2)
  const cases = { monitorArmed, monitorDied, promiseAfterWake, unfinished, finishedWithoutReport }
  for (const [name, run] of Object.entries(cases)) if (!only.length || only.includes(name)) await run()
} finally {
  rmSync(root, { recursive: true, force: true })
}

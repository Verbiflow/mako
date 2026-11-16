import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NativeAgentObservation } from "@mako/host/contracts/native-agents"
import { HELD_WORK_CEILING_MS } from "@mako/host/contracts/background-work"
import { childWord } from "@mako/host/contracts/children"
import { readFinReports } from "@mako/host/contracts/fin-reports"
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
 * - Claude can drop a Monitor that timed out, or that TaskStop ended, saying nothing: the driver settles it unknown, and
 *   the Fin ended without a result. Work nothing says the end of is believed for `HELD_WORK_CEILING_MS`, no longer.
 * - An unfinished Fin keeps what was to start after it waiting, until it reports done.
 * - fin-models, woken by the pull-request watch on #868, pushed a fix and ended its turn saying it would report when CI
 *   settled, with nothing watching the new run. Mako wrote its promise as its result, and its row said "Done". A Fin
 *   whose word is progress hasn't said it's done: it reads "Ended without a result" in the list, its row and the
 *   digest, never done, and its Apex hears at once, with its last words, and sends it on or takes the reply. Nobody is
 *   asked, so nothing reaches the person's Inbox.
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
async function world(name: string, script: Script, options: { readPull?: () => Promise<PullReading | null>; apexAnswerMs?: number; now?: () => number; later?: (ms: number, run: () => void) => () => void } = {}) {
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

async function monitorDropped(): Promise<void> {
  const f = await world("monitor-dropped", async (turn) => {
    if (!turn.text.includes("You're fin:")) return "ok"
    turn.world.live.observe({ type: "live-agent", id: turn.conversation, agent: monitor({ kind: "working" }) })
    return "Monitor is armed for #783; I'll fix and re-push from its events."
  })
  const child = await f.start("queue", "Get #783 green")
  await f.w.settle()
  const conversation = f.conversationOf(child)
  assert.equal((await f.state("queue")).state.kind, "working")
  // Claude dropped it from its level with no notification and no turn: the driver settles it, its end unknown.
  f.w.live.observe({ type: "live-agent", id: conversation, agent: monitor({ kind: "unknown", reason: "Claude no longer lists this task and did not say how it ended." }) })
  await until("its end to be said", () => f.reports(child).length > 0)
  const [report] = f.reports(child)
  assert.deepEqual([report!.status, report!.unfinished], ["failed", true], JSON.stringify(report))
  assert.equal(report!.summary, `A monitor it left running ended without waking it. Nothing it waits on will wake it. Its last words: "Monitor is armed for #783; I'll fix and re-push from its events."`)
  assert.equal(childWord((await f.state("queue")).state), "Ended without a result", "never waiting forever, never done")
  await f.w.settle()
  assert.match(f.heard(), /1 ended without a result [^\n]*:\n {2}• "queue" \(Claude\): A monitor it left running ended without waking it\./, "its Apex hears it at once")
  console.log(`monitor dropped: "${report!.summary}"`)
  await f.w.close()
}

async function monitorPastCeiling(): Promise<void> {
  let offset = 0
  const timers: { ms: number; run: () => void }[] = []
  const f = await world("monitor-stale", async (turn) => {
    if (!turn.text.includes("You're fin:")) return "ok"
    turn.world.live.observe({ type: "live-agent", id: turn.conversation, agent: monitor({ kind: "working" }) })
    return "Monitor is armed; I'll act on its events."
  }, { now: () => Date.now() + offset, later: (ms, run) => (timers.push({ ms, run }), () => {}) })
  const child = await f.start("queue", "Get #783 green")
  await f.w.settle()
  assert.equal((await f.state("queue")).state.kind, "working")
  const ceiling = timers.find((timer) => timer.ms > HELD_WORK_CEILING_MS)
  assert.ok(ceiling, "its end is looked at again past the ceiling")
  // Nothing was heard of the Monitor since: past the ceiling it's no longer believed.
  offset = HELD_WORK_CEILING_MS + 60_000
  ceiling!.run()
  const [report] = f.reports(child)
  assert.deepEqual([report?.status, report?.unfinished], ["failed", true], JSON.stringify(report))
  assert.match(report!.summary, /^Nothing was heard of a monitor it left running in 6 hours, so Mako no longer counts on it\. Nothing it waits on will wake it\. Its last words: "Monitor is armed; I'll act on its events\."$/)
  console.log("monitor past the ceiling: no longer believed; it ended without a result")
  await f.w.close()
}

async function unfinishedHoldsAfter(): Promise<void> {
  const f = await world("holds-after", async (turn) => {
    if (turn.text.includes("You're fin:suites")) {
      await turn.world.agents.report(turn.caller, { status: "progress", summary: "Half the suites run.", clientKey: "half" })
      await turn.world.hold(turn.conversation)
      return "I'll report when the local suites settle."
    }
    if (turn.text.includes("Go on")) {
      await turn.world.agents.report(turn.caller, { status: "done", summary: "Every suite passes.", clientKey: "all" })
      return "Every suite passes."
    }
    return turn.text.includes("You're fin:deploy") ? "Deployed." : "ok"
  })
  const child = await f.start("suites", "Run every suite")
  const deploy = await f.w.agents.start(f.apex.caller, { brief: { objective: "Deploy it" }, name: "deploy", after: ["suites"], clientKey: "deploy", cwd: f.w.root })
  assert.ok(!("refused" in deploy) && deploy.state === "queued", JSON.stringify(deploy))
  const started = () => f.w.store.edges().all.some((edge) => edge.name === "deploy")
  f.w.release(f.conversationOf(child))
  await f.w.settle()
  assert.equal(childWord((await f.state("suites")).state), "Ended without a result")
  assert.equal(started(), false, "what was to start after it doesn't start")
  assert.equal(f.w.store.queuedSpawns().length, 1, "and isn't dropped: it ended without a result, it didn't fail")
  assert.match(f.heard(), /• "suites" \(Claude\): Nothing it waits on will wake it\.[^\n]*\n {4}Still waiting to start after it: deploy \(they start once it reports done; agents_stop on it drops them\)\./, "its Apex hears what waits on it")
  assert.doesNotMatch(f.heard(), /It didn't start/)
  // Its Apex sends it on; it finishes, and what waited starts.
  const sent = await f.w.agents.send(f.apex.caller, { to: "suites", text: "Go on", clientKey: "go-on" })
  assert.ok(!("refused" in sent), JSON.stringify(sent))
  await until("deploy to start once suites finished", started)
  await f.w.settle()
  assert.equal((await f.state("suites")).state.kind, "ended")
  assert.equal(childWord((await f.state("suites")).state), "Done")
  console.log("unfinished holds after: what was to start after it waits, and starts once it reports done")
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
  assert.equal(report!.unfinished, true, `never its promise as its result: ${JSON.stringify(report)}`)
  assert.match(report!.summary, /^Nothing it waits on will wake it\. Its last words: "I've pushed a fix and CI is running again on it\. I'll report the result when the new run settles\."/)
  assert.equal(report!.question, undefined, "and asks nobody")
  assert.equal(childWord((await f.state("models")).state), "Ended without a result", "its row never says done")
  assert.match(f.heard(), /1 ended without a result [^\n]*:\n {2}• "models" \(Claude\): Nothing it waits on will wake it\. Its last words: "I've pushed a fix/, "its Apex hears it at once")
  console.log("promise after a wake: \"Ended without a result\", its Apex woken with its last words")
  await f.w.close()
}

async function unfinished(): Promise<void> {
  const f = await world("unfinished", async (turn) => {
    if (turn.text.includes("You're fin:")) {
      await turn.world.agents.report(turn.caller, { status: "progress", summary: "Half the suites run.", clientKey: "half" })
      return "I'll report when the local suites settle."
    }
    return "ok"
  }, { apexAnswerMs: 50 })
  const child = await f.start("suites", "Run every suite")
  await f.w.settle()
  const [report] = f.reports(child).filter((each) => each.implicit)
  assert.ok(report, "its turn's end is said")
  assert.deepEqual([report!.status, report!.unfinished], ["failed", true], "kept as failed, so an older build never reads it as done")
  assert.equal(report!.summary, `Nothing it waits on will wake it. Its last words: "I'll report when the local suites settle."`)
  assert.equal(report!.question, undefined, "a question would reach the person's Inbox once its Apex left it")
  // Its Apex's digest says it apart from what finished, its card the same.
  assert.match(f.heard(), /1 ended without a result \(agents_send sends one on; or take its reply as its result\):\n {2}• "suites" \(Claude\): Nothing it waits on will wake it\. Its last words: "I'll report when the local suites settle\."/, "its Apex hears it at once, its last words with it")
  assert.doesNotMatch(f.heard(), /finished:|"suites" \(Claude\) (done|failed)/, "never as finished, done or failed")
  const wake = f.w.prompts.find((prompt) => prompt.conversation === f.apex.conversation && prompt.text.includes('"suites"'))!
  assert.deepEqual(readFinReports(wake.text).reports.map((card) => [card.status, card.unfinished]), [["failed", true]], "its card says it too")
  // agents_list: its state and its report.
  const listed = await f.state("suites")
  assert.deepEqual(listed.state, { kind: "ended", outcome: "failed", unfinished: true, reason: `Nothing it waits on will wake it. Its last words: "I'll report when the local suites settle."` })
  assert.equal(childWord(listed.state), "Ended without a result", "its row, the phone's and its strip say so")
  assert.equal(listed.report?.unfinished, true)
  // Its Apex leaves it past the window an ask has: nothing goes to the person.
  await pause(200)
  await f.w.settle()
  assert.equal(f.w.agents.personAsk(f.apex.conversation), undefined, "nothing waits on the person")
  assert.ok(!f.reports(child).some((each) => each.for === "person"), "and nothing was escalated to them")
  console.log("unfinished: a silent end after progress nothing watches reads \"Ended without a result\" everywhere, wakes its Apex with its last words and asks nobody")
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
  const cases = { monitorArmed, monitorDied, monitorDropped, monitorPastCeiling, promiseAfterWake, unfinished, unfinishedHoldsAfter, finishedWithoutReport }
  for (const [name, run] of Object.entries(cases)) if (!only.length || only.includes(name)) await run()
} finally {
  rmSync(root, { recursive: true, force: true })
}

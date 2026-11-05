import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { ReportSchema, type Notice } from "@mako/host/contracts/agents"
import { AgentWakes, FROM_AGENTS, RESULT_COALESCE_MS, WAKE_COALESCE_MS, WAKES_PER_MINUTE, type AgentWakesDeps, type ParentReady } from "@mako/host/conversations/agent-wakes"
import { readFinReports } from "@mako/host/contracts/fin-reports"
import { AgentsWorld, HARNESSES, type Script } from "./lib/agents-world.ts"

/**
 * An Apex's Fins' news is a producer into the Apex's own queue (`npm run
 * test:wake-queue`), step two of the one delivery queue: the queue keeps each
 * digest durably and sends it once, so nothing about it lives only in memory.
 * Covered, against the engine's own rules with fake conversations: a burst is
 * one digest, held for its window; a notice joins the digest still unsent; a
 * result the Apex waited for is held only briefly; a busy Apex's digest waits
 * for its turn's end; a stopped Fin's is paused for its resume; a running turn
 * that takes a step's message hears a notice now, and one it refuses joins the
 * digest; past the minute's budget a digest waits for it; a notice heard twice
 * is one; a withdrawn notice leaves the digest, and the last one takes it
 * back; a notice no longer current leaves it. Then, on each of the six
 * scripted harnesses, a host killed by SIGKILL while a digest gathers its
 * burst: the next host sends it once, each report in it once.
 */
const root = mkdtempSync(join(tmpdir(), "mako-wake-queue-"))
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(10)
  }
}

interface Entry { id: string; text: string; notices: Notice[]; hold: { at: number } | "paused" | undefined; sent?: number; canceled?: boolean }

/** One Apex conversation as the queue would hold it, and every call the producer made. */
function fakes(ready: () => ParentReady, now: () => number, steer: (text: string) => Promise<boolean> | false = () => false, current: (notice: Notice) => boolean = () => true) {
  const entries: Entry[] = []
  const delivered: string[] = []
  const open = () => entries.find((entry) => entry.sent === undefined && !entry.canceled)
  const deps: AgentWakesDeps = {
    ready,
    open: () => { const entry = open(); return entry && { id: entry.id, notices: entry.notices } },
    admit: (_conversation, id, text, notices, _actor, hold) => { if (!entries.some((entry) => entry.id === id)) entries.push({ id, text, notices: [...notices], hold }) },
    rewrite: (_conversation, id, text, notices) => {
      const entry = entries.find((candidate) => candidate.id === id && candidate.sent === undefined && !candidate.canceled)
      if (!entry) return false
      if (!notices.length) entry.canceled = true
      entry.text = text
      entry.notices = [...notices]
      return true
    },
    sent: (_conversation, since) => entries.flatMap((entry) => (entry.sent !== undefined && entry.sent >= since ? [entry.sent] : [])),
    steer: (_conversation, _id, text) => steer(text),
    assign: () => {},
    delivered: (reports) => delivered.push(...reports),
    counts: () => "1 working",
    current,
    now,
  }
  return { entries, delivered, deps, open }
}

let reports = 0
function notice(status: "done" | "blocked" = "done", marks: Partial<Notice> = {}): Notice {
  reports += 1
  const report = ReportSchema.parse({ id: `report:${reports}`, child: randomUUID(), status, summary: `Report ${reports}.`, ownerGeneration: 1, at: reports })
  return { id: `notice:${report.child}:${report.id}`, report, label: `"fin-${reports}" (Claude)`, fin: { name: `fin-${reports}`, harness: "claude" }, from: randomUUID(), ...marks }
}

/** A child host: an Apex whose Fin reported while it was idle, so a digest gathers its burst; then it waits to be killed. */
async function childHost(dir: string, harness: string): Promise<void> {
  const script: Script = (turn) => (turn.text.includes("You're fin:") ? "Labels finished." : "ok")
  const world = new AgentsWorld({ root: dir, script })
  const apex = await world.apex(harness, "full")
  const started = await world.agents.start(apex.caller, { brief: { objective: "Label" }, harness, name: "labels", clientKey: "labels", cwd: world.root })
  if ("refused" in started) throw new Error(started.why)
  const digest = () => world.live.snapshot(apex.conversation)?.requests.find((request) => request.digest && request.status === "held")
  await until("the digest to gather", () => Boolean(digest()))
  writeFileSync(join(dir, "ready"), apex.conversation)
  await new Promise(() => {})
}

if (process.argv[2] === "--host") await childHost(process.argv[3]!, process.argv[4]!)

try {
  // The producer's rules, against fake conversations.
  {
    let clock = 1_000_000
    const now = () => clock
    let ready: ParentReady = "idle"
    const f = fakes(() => ready, now)
    const wakes = new AgentWakes(f.deps)
    const first = notice()
    wakes.notice("apex", "", first)
    assert.equal(f.entries.length, 1)
    assert.deepEqual(f.entries[0]!.hold, { at: clock + WAKE_COALESCE_MS }, "an idle Apex's digest is held for its burst's window")
    assert.deepEqual(f.delivered, [first.report.id], "heard once it's in the queue")
    const second = notice("blocked")
    wakes.notice("apex", "", second)
    assert.equal(f.entries.length, 1, "a burst is one digest")
    assert.deepEqual(f.entries[0]!.notices.map((each) => each.id), [first.id, second.id])
    assert.match(f.entries[0]!.text, /1 needs a decision:[\s\S]*1 finished:/, "decisions first")
    wakes.notice("apex", "", second)
    assert.equal(f.entries[0]!.notices.length, 2, "a notice heard twice is one")
    assert.equal(wakes.withdraw("apex", second.id), true)
    assert.equal(f.entries[0]!.notices.length, 1, "a withdrawn notice leaves the digest")
    assert.equal(wakes.withdraw("apex", first.id), true)
    assert.equal(f.entries[0]!.canceled, true, "the last one takes it back")
    // A result the Apex waited for is held only briefly.
    const result = notice("done", { settledOnly: true })
    wakes.notice("apex", "", result)
    assert.deepEqual(f.open()!.hold, { at: clock + RESULT_COALESCE_MS })
    f.open()!.sent = clock
    // A busy Apex's digest waits for its turn's end, unheld; a stopped Fin's is paused for its resume.
    ready = "queue"
    wakes.notice("apex", "", notice())
    assert.equal(f.open()!.hold, undefined)
    f.open()!.sent = clock
    ready = "paused"
    wakes.notice("apex", "", notice())
    assert.equal(f.open()!.hold, "paused")
    f.open()!.sent = clock
    // Past the minute's budget a digest waits for it.
    ready = "idle"
    for (const entry of f.entries) entry.sent ??= clock
    while (f.entries.filter((entry) => entry.sent !== undefined && !entry.canceled).length < WAKES_PER_MINUTE) f.entries.push({ id: randomUUID(), text: "", notices: [], hold: undefined, sent: clock })
    clock += 1_000
    wakes.notice("apex", "", notice())
    const sentTimes = f.entries.flatMap((entry) => (entry.sent !== undefined && !entry.canceled ? [entry.sent] : [])).sort((left, right) => left - right)
    assert.deepEqual(f.open()!.hold, { at: sentTimes[sentTimes.length - WAKES_PER_MINUTE]! + 60_000 }, "the seventh in a minute waits for the budget")
  }
  {
    // A running turn that takes a step's message hears a notice now; one it refuses joins the digest.
    const clock = 5_000_000
    let answer = true
    const steered: string[] = []
    const f = fakes(() => "steer", () => clock, (text) => { steered.push(text); return Promise.resolve(answer) })
    const wakes = new AgentWakes(f.deps)
    wakes.notice("apex", "", notice())
    await pause(0)
    assert.equal(steered.length, 1)
    assert.equal(f.entries.length, 0, "taken by the running turn, nothing queued")
    answer = false
    wakes.notice("apex", "", notice())
    await pause(0)
    assert.equal(f.entries.length, 1, "a refused steer goes as a digest of its own")
    // A result is never steered: it waits for the turn's end.
    wakes.notice("apex", "", notice("done", { settledOnly: true }))
    assert.equal(steered.length, 2)
    assert.equal(f.open()!.notices.length, 2)
  }
  {
    // A notice no longer current leaves the digest when it's read again.
    let live = true
    const f = fakes(() => "queue", () => 9_000_000, () => false, () => live)
    const wakes = new AgentWakes(f.deps)
    wakes.notice("apex", "", notice())
    live = false
    wakes.settled("apex")
    assert.equal(f.entries[0]!.canceled, true, "an end inferred for a Fin that works again isn't said")
  }
  console.log("wakes: a burst is one digest held for its window; joins, results, busy, stopped, steered, budget, duplicates, withdrawals and stale ends each as the queue keeps them")

  for (const harness of HARNESSES) {
    // A host killed by SIGKILL while a digest gathers its burst: the next host sends it once.
    const dir = join(root, `${harness}-kill`)
    const child = spawn(process.execPath, ["--import", "tsx", import.meta.filename, "--host", dir, harness], { stdio: "ignore" })
    await until("the child host", () => { try { return Boolean(readFileSync(join(dir, "ready"), "utf8")) } catch { return false } }, 30_000)
    const apex = readFileSync(join(dir, "ready"), "utf8")
    child.kill("SIGKILL")
    await new Promise((resolve) => child.once("exit", resolve))
    const world = new AgentsWorld({ root: dir, script: () => "ok" })
    await until(`${harness}: the digest to go`, () => world.prompts.some((prompt) => prompt.conversation === apex && prompt.text.startsWith(FROM_AGENTS)), 10_000)
    await world.settle(600, 20_000, "ignore")
    const sent = world.prompts.filter((prompt) => prompt.conversation === apex && prompt.text.startsWith(FROM_AGENTS))
    assert.equal(sent.length, 1, `${harness}: once`)
    // The digest's words, before the person's cards of the same reports (`appendFinReports`).
    assert.equal(readFinReports(sent[0]!.text).text.split('"labels"').length - 1, 1, `${harness}: its report once`)
    assert.equal(world.store.undeliveredReports().length, 0)
    await world.close()
    console.log(`${harness}: a digest gathering its burst survived SIGKILL and went once`)
  }
} finally {
  if (process.argv[2] !== "--host") rmSync(root, { recursive: true, force: true })
}
if (process.argv[2] !== "--host") console.log("wake queue: ok")

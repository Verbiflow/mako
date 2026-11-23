import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { followHostLog } from "@mako/host/base/host-log"
import { ReportSchema, type Notice } from "@mako/host/contracts/agents"
import { DIGEST_WAITS } from "@mako/host/contracts/children"
import { readFinReports } from "@mako/host/contracts/fin-reports"
import { AgentWakes, FROM_AGENTS, HOLD_RESULTS_MS, RESULT_COALESCE_MS, WAKE_COALESCE_MS, WAKES_PER_MINUTE, type AgentWakesDeps, type ParentReady } from "@mako/host/conversations/agent-wakes"
import { FIN_REPORTS_MAX } from "@mako/host/contracts/fin-reports"
import { carriedDigest } from "@mako/host/contracts/delivery-retry"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { AgentsWorld, TESTED_HARNESSES, type Script } from "./lib/agents-world.ts"

/**
 * An Apex's Fins' news is a producer into the Apex's own queue (`npm run
 * test:wake-queue`), step two of the one delivery queue: the queue keeps each
 * digest durably and sends it once, so nothing about it lives only in memory.
 * Covered, against the producer's rules with fake conversations: an idle
 * Apex's first report goes at once, and what follows is one digest, at its
 * turn's end or held until its window after the last digest went; a notice
 * joins the newest digest still unsent; a result the Apex waited for is held
 * only its own short window; a busy Apex's
 * digest waits for its turn's end; a stopped Fin's is paused for its resume;
 * a running turn that takes a step's message hears a notice now, and one it
 * refuses joins the digest; a notice a digest carries already is heard, never
 * queued twice; withdrawing a notice and dropping a stale one reach every
 * unsent digest. Then on the engine: a host killed by SIGKILL at each write
 * between a digest, its claim in the store and its receipt, recovering to
 * each report delivered once; the minute's budget kept as the queue sends,
 * from when each digest went; and a journal that can't be written failing
 * its own conversation alone, the others' times going and its own once
 * writes come back.
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

interface Entry { id: string; text: string; notices: Notice[]; lines?: readonly string[]; hold: { at: number; since?: number } | "paused" | undefined; sent?: number; canceled?: boolean }

/** One Apex conversation as the queue would hold it, and every call the producer made. */
function fakes(ready: () => ParentReady, now: () => number, steer: (text: string) => Promise<boolean> | false = () => false, current: (notice: Notice) => boolean = () => true) {
  const counted = { line: "1 working" }
  const entries: Entry[] = []
  const delivered: string[] = []
  const unsent = () => entries.filter((entry) => entry.sent === undefined && !entry.canceled)
  const deps: AgentWakesDeps = {
    ready,
    lastSent: () => entries.reduce<number | undefined>((last, entry) => (entry.sent !== undefined && (last === undefined || entry.sent > last) ? entry.sent : last), undefined),
    unsent: () => unsent().map((entry) => ({ id: entry.id, notices: entry.notices, ...(entry.lines && { lines: entry.lines }), ...(typeof entry.hold === "object" && entry.hold.since !== undefined && { held: entry.hold.since }) })),
    carried: (_conversation, id) => entries.some((entry) => !entry.canceled && entry.notices.some((each) => each.id === id)),
    admit: (_conversation, id, text, notices, _actor, hold, lines) => { if (!entries.some((entry) => entry.id === id)) entries.push({ id, text, notices: [...notices], hold, ...(lines && { lines }) }) },
    rewrite: (_conversation, id, text, notices, lines, free) => {
      const entry = unsent().find((candidate) => candidate.id === id)
      if (!entry) return false
      if (!notices.length) entry.canceled = true
      // Held for the Fins still at work no longer, as the queue frees it: its time is now.
      if (free && typeof entry.hold === "object" && entry.hold.since !== undefined) entry.hold = undefined
      entry.text = text
      entry.notices = [...notices]
      entry.lines = lines ?? []
      return true
    },
    steer: (_conversation, _id, text) => steer(text),
    assign: () => {},
    delivered: (reports) => delivered.push(...reports),
    counts: () => counted.line,
    current,
    now,
  }
  return { entries, delivered, deps, counted, open: () => unsent().at(-1) }
}

let reports = 0
function notice(status: "done" | "blocked" | "failed" | "progress" = "done", marks: Partial<Notice> = {}, said: Partial<Notice["report"]> = {}): Notice {
  reports += 1
  const report = ReportSchema.parse({ id: `report:${reports}`, child: randomUUID(), status, summary: `Report ${reports}.`, ownerGeneration: 1, at: reports, ...said })
  return { id: `notice:${report.child}:${report.id}`, report, label: `"fin-${reports}" (Claude)`, fin: { name: `fin-${reports}`, harness: "claude" }, from: randomUUID(), ...marks }
}


/**
 * Twelve Fins finishing fifty seconds apart, over ten minutes, under an idle Apex whose turn on a digest takes
 * `turnMs`: the digests its queue sends, each with how many results it carried. The queue is the fake's, stepped a
 * second at a time: a digest goes once its Apex is idle and its time has come, and a turn's end is said as the host
 * says it. `holds` false leaves out what says a Fin is still at work, so nothing is ever held: the rule before.
 */
function twelveFins(holds: boolean, turnMs: number): number[] {
  const SPACING = 50_000
  const finishes = Array.from({ length: 12 }, (_, i) => (i + 1) * SPACING)
  let clock = 0
  let busyUntil = -1
  let onNews = false
  const fins = finishes.map(() => notice())
  const f = fakes(() => (clock < busyUntil ? "queue" : "idle"), () => clock)
  const wakes = new AgentWakes({
    ...f.deps,
    ...(holds && { working: (_conversation, but) => finishes.some((at, i) => at > clock && fins[i]!.report.child !== but), onNews: () => onNews }),
  })
  const sent: number[] = []
  for (; clock <= 20 * 60_000; clock += 1_000) {
    if (busyUntil === clock) {
      onNews = false
      wakes.settled("apex", false)
    }
    const at = finishes.indexOf(clock)
    if (at >= 0) {
      wakes.notice("apex", "", fins[at]!)
      // Its own turn ends with its report, so its Fin's state moves: the host reads its Apex's unsent digests again.
      wakes.refresh("apex")
    }
    const next = f.entries.find((entry) => entry.sent === undefined && !entry.canceled)
    if (next && clock >= busyUntil && (next.hold === undefined || (typeof next.hold === "object" && next.hold.at <= clock))) {
      next.sent = clock
      sent.push(next.notices.length)
      busyUntil = clock + turnMs
      onNews = true
    }
  }
  assert.equal(sent.reduce((sum, count) => sum + count, 0), 12, "every result reached the Apex, once")
  return sent
}

/** The write gaps a digest crosses: its claim and its row as it starts, its row and its claim as a notice joins it. */
const GAPS = ["digest start assigned", "digest admitted", "digest joined", "digest join assigned", "wake"] as const

/**
 * A child host: an idle Apex with three Fins that report one after the other. The first's digest goes at once, the
 * second's is held for the window after it, and the third joins the second's; killed by SIGKILL at `gap`, the `nth`
 * time its log says it.
 */
async function childHost(dir: string, harness: string, gap: string, nth: number): Promise<void> {
  let seen = 0
  followHostLog((line) => {
    if (line.message === gap && ++seen === nth) process.kill(process.pid, "SIGKILL")
  })
  const script: Script = (turn) => (turn.text.includes("You're fin:") ? turn.world.hold(turn.conversation).then(() => `${turn.text.includes("fin:first") ? "First" : turn.text.includes("fin:second") ? "Second" : "Third"} finished.`) : "ok")
  const world = new AgentsWorld({ root: dir, script })
  const apex = await world.apex(harness, "full")
  writeFileSync(join(dir, "apex"), apex.conversation)
  const fins: string[] = []
  for (const name of ["first", "second", "third"]) {
    const started = await world.agents.start(apex.caller, { brief: { objective: `Label ${name}` }, harness, name, clientKey: name, cwd: world.root })
    if ("refused" in started) throw new Error(started.why)
    fins.push(started.conversation!)
  }
  await until("the Fins", () => fins.every((fin) => world.live.session(fin)?.status === "running"))
  const digests = () => world.live.snapshot(apex.conversation)?.requests.filter((request) => request.digest).length ?? 0
  world.release(fins[0]!)
  await until("the first's digest", () => digests() === 1)
  world.release(fins[1]!)
  await until("the second's digest", () => digests() === 2)
  world.release(fins[2]!)
  await new Promise(() => {})
}

if (process.argv[2] === "--host") await childHost(process.argv[3]!, process.argv[4]!, process.argv[5]!, Number(process.argv[6]))

try {
  // The producer's rules, against fake conversations.
  {
    let clock = 1_000_000
    let ready: ParentReady = "idle"
    const f = fakes(() => ready, () => clock)
    const wakes = new AgentWakes(f.deps)
    // The first report to an idle Apex goes at once, not after the two seconds of a burst that may never come.
    const alone = notice()
    wakes.notice("apex", "", alone)
    assert.equal(f.entries.length, 1)
    assert.equal(f.entries[0]!.hold, undefined, "an idle Apex's first digest goes at once")
    assert.deepEqual(f.delivered, [alone.report.id], "heard once it's in the queue")
    f.entries[0]!.sent = clock
    // What follows while the Apex's turn on it runs waits for that turn's end, as one digest.
    ready = "queue"
    clock += 100
    const during = [notice(), notice()]
    for (const each of during) wakes.notice("apex", "", each)
    assert.equal(f.entries.length, 2, "the rest of a burst is one digest, not one a report")
    assert.equal(f.entries[1]!.hold, undefined, "a busy Apex's digest waits for its turn's end, unheld")
    assert.deepEqual(f.entries[1]!.notices.map((each) => each.id), during.map((each) => each.id))
    // Its turn ends: that digest goes then.
    clock += 400
    f.entries[1]!.sent = clock
    // That turn already over too, a moment after the last digest went: the next is held until its window after it.
    ready = "idle"
    const went = clock
    clock += 300
    const first = notice()
    wakes.notice("apex", "", first)
    assert.equal(f.entries.length, 3)
    assert.deepEqual(f.entries[2]!.hold, { at: went + WAKE_COALESCE_MS }, "right after a digest went, the next is held until the window after it")
    const second = notice("blocked")
    wakes.notice("apex", "", second)
    assert.equal(f.entries.length, 3, "a burst is one digest")
    assert.deepEqual(f.entries[2]!.notices.map((each) => each.id), [first.id, second.id])
    assert.match(f.entries[2]!.text, /1 needs a decision:[\s\S]*1 finished:/, "decisions first")
    wakes.notice("apex", "", second)
    assert.equal(f.entries[2]!.notices.length, 2, "a notice heard twice is one")
    // Every report is in exactly one digest: none lost, none twice.
    assert.deepEqual(f.entries.flatMap((entry) => entry.notices.map((each) => each.id)).sort(), [alone, ...during, first, second].map((each) => each.id).sort())
    assert.deepEqual([...f.delivered].sort(), [alone, ...during, first, second].map((each) => each.report.id).sort(), "each heard once")
    f.entries.splice(0, 2)
    // A notice a digest carries already, sent or not, is its own receipt: a new host's re-notice of it queues nothing.
    f.entries[0]!.sent = clock
    const again = new AgentWakes(f.deps)
    again.notice("apex", "", second)
    assert.equal(f.entries.length, 1, "a carried notice is heard, not queued again")
    f.entries[0]!.sent = undefined
    assert.equal(wakes.withdraw("apex", second.id), true)
    assert.equal(f.entries[0]!.notices.length, 1, "a withdrawn notice leaves the digest")
    assert.equal(wakes.withdraw("apex", first.id), true)
    assert.equal(f.entries[0]!.canceled, true, "the last one takes it back")
    // A result the Apex waited for waits only its own short window after the last digest went.
    f.entries[0]!.sent = clock
    wakes.notice("apex", "", notice("done", { settledOnly: true }))
    assert.deepEqual(f.open()!.hold, { at: clock + RESULT_COALESCE_MS }, "a result waits only its own short window")
    f.open()!.sent = clock + RESULT_COALESCE_MS
    clock += 2 * RESULT_COALESCE_MS + 100
    // Past the window after the last digest, an idle Apex hears the next at once again, a result or not.
    wakes.notice("apex", "", notice("done", { settledOnly: true }))
    assert.equal(f.open()!.hold, undefined, "a result past its window after the last digest goes at once")
    f.open()!.sent = clock
    clock += WAKE_COALESCE_MS
    wakes.notice("apex", "", notice())
    assert.equal(f.open()!.hold, undefined, "past the window, the next report is a first again")
    f.open()!.sent = clock
    // A report a previous host left unheard waits the window even as an idle Apex's first: a receipt this host reads
    // back as it takes the Apex up (a steer its harness had) may take it back.
    clock += WAKE_COALESCE_MS
    const left = notice()
    wakes.leftOver([left.id])
    wakes.notice("apex", "", left)
    assert.deepEqual(f.open()!.hold, { at: clock + WAKE_COALESCE_MS }, "a left-over report waits the window")
    f.open()!.sent = clock + WAKE_COALESCE_MS
    clock += 2 * WAKE_COALESCE_MS
    // A last digest that reads as sent in the future (the clock set back since) holds the next no longer than its window.
    f.entries.push({ id: "future", text: "", notices: [], hold: undefined, sent: clock + 3_600_000 })
    wakes.notice("apex", "", notice())
    assert.deepEqual(f.open()!.hold, { at: clock + WAKE_COALESCE_MS }, "held no longer than the window from now")
    f.open()!.sent = clock
    f.entries.splice(f.entries.findIndex((entry) => entry.id === "future"), 1)
    clock += 2 * WAKE_COALESCE_MS
    // A busy Apex's digest waits for its turn's end, unheld; a stopped Fin's is paused for its resume.
    ready = "queue"
    wakes.notice("apex", "", notice())
    assert.equal(f.open()!.hold, undefined)
    f.open()!.sent = clock
    ready = "paused"
    wakes.notice("apex", "", notice())
    assert.equal(f.open()!.hold, "paused")
  }
  {
    // Withdrawing and dropping a stale notice reach every unsent digest, not just the newest.
    const live = new Set<string>()
    const f = fakes(() => "queue", () => 2_000_000, () => false, (each) => !live.size || live.has(each.id))
    const wakes = new AgentWakes(f.deps)
    const old = notice("done", { settledOnly: true })
    const stale = notice()
    wakes.notice("apex", "", old)
    wakes.notice("apex", "", stale)
    f.entries.push({ id: randomUUID(), text: "", notices: [notice()], hold: undefined })
    assert.equal(f.entries.filter((entry) => entry.sent === undefined).length, 2, "two digests wait unsent")
    assert.equal(wakes.withdraw("apex", old.id), true, "a notice in the older digest is found")
    assert.ok(!f.entries[0]!.notices.some((each) => each.id === old.id), "and leaves it")
    live.add(f.entries[1]!.notices[0]!.id)
    wakes.refresh("apex")
    assert.equal(f.entries[0]!.canceled, true, "a stale end leaves the older digest too")
  }
  {
    // A running turn that takes a step's message hears a question it can answer now; one it refuses joins the digest.
    // A result waits for the turn's end, so a working Apex isn't steered by each report (`FOCUS_MS`).
    let answer = true
    const steered: string[] = []
    const f = fakes(() => "steer", () => 5_000_000, (text) => { steered.push(text); return Promise.resolve(answer) })
    const wakes = new AgentWakes({ ...f.deps, focusMs: 60_000 })
    wakes.notice("apex", "", notice("blocked"))
    await pause(0)
    assert.equal(steered.length, 1)
    assert.equal(f.entries.length, 0, "taken by the running turn, nothing queued")
    answer = false
    wakes.notice("apex", "", notice("blocked"))
    await pause(0)
    assert.equal(f.entries.length, 1, "a refused steer goes as a digest of its own")
    wakes.notice("apex", "", notice())
    assert.equal(steered.length, 2, "a finished Fin's result isn't steered into the turn")
    wakes.notice("apex", "", notice("done", { settledOnly: true }))
    assert.equal(steered.length, 2, "nor is a waited-for result")
    assert.equal(f.open()!.notices.length, 3)
    wakes.dispose()
  }
  {
    // A turn that runs past `FOCUS_MS` after the first result it left waiting hears what waits, once: the queued digest
    // itself is steered in (`steer-queued`), so it leaves the queue in the journal's write. A notice that comes while the
    // steer is out starts a digest of its own rather than joining one on its way, and one the harness refuses stays queued.
    const steered: { request: string; text: string }[] = []
    let settle: (answered: boolean) => void = () => {}
    const f = fakes(() => "steer", () => 5_000_000, () => Promise.resolve(true))
    const wakes = new AgentWakes({
      ...f.deps,
      focusMs: 50,
      steerQueued: (_conversation, _id, request, text) => {
        steered.push({ request, text })
        return new Promise<boolean>((resolve) => { settle = resolve })
      },
    })
    const first = notice()
    wakes.notice("apex", "", first)
    wakes.notice("apex", "", notice())
    assert.equal(steered.length, 0, "nothing steered as the results come")
    const digest = f.open()!
    assert.equal(digest.notices.length, 2, "they wait as one digest")
    await pause(120)
    assert.equal(steered.length, 1, "past the focus window, the digest is steered in")
    assert.equal(steered[0]!.request, digest.id, "the queued digest itself, not a copy of its words")
    assert.match(steered[0]!.text, /2 finished:/)
    const late = notice()
    wakes.notice("apex", "", late)
    assert.equal(digest.notices.length, 2, "a notice arriving while the steer is out doesn't join the digest on its way")
    assert.ok(f.entries.some((entry) => entry.id !== digest.id && entry.notices.some((each) => each.id === late.id)), "it starts a digest of its own")
    settle(true)
    await pause(0)
    assert.equal(digest.canceled, undefined, "the steered digest isn't rewritten: the journal's steer took it")
    wakes.dispose()
  }
  {
    // The tree moved since the last notice (a Fin's state, so the counts line), with no notice of its own: the focus steer
    // still goes, with the digest's words said as the tree stands now and stored first, since the journal's steer takes
    // only a queued message's exact words (`steer-queued` refuses one that changed).
    const steered: { request: string; text: string }[] = []
    const f = fakes(() => "steer", () => 5_000_000, () => Promise.resolve(true))
    const wakes = new AgentWakes({
      ...f.deps,
      focusMs: 50,
      steerQueued: (_conversation, _id, request, text) => {
        const queued = f.entries.find((entry) => entry.id === request)!
        if (queued.text !== text) return Promise.resolve(false)
        steered.push({ request, text })
        return Promise.resolve(true)
      },
    })
    wakes.notice("apex", "", notice())
    f.counted.line = "0 working, 1 ended."
    await pause(120)
    assert.equal(steered.length, 1, "the digest is steered, not refused for words the tree's change made stale")
    assert.match(steered[0]!.text, /0 working, 1 ended\./, "said as the tree stands now")
    wakes.dispose()
  }
  {
    // What rides a digest stays with it whatever happens to its reports, and is said once. Nothing takes it away but its going.
    let waiting: string[] = []
    let ready: ParentReady = "queue"
    let answer: Promise<boolean> | false = false
    const live = new Set<string>()
    const f = fakes(() => ready, () => 6_000_000, () => answer, (each) => !live.has(each.id))
    const wakes = new AgentWakes({
      ...f.deps,
      takeLines: () => { const lines = waiting; waiting = []; return lines },
      giveLines: (_conversation, lines) => { waiting = [...lines, ...waiting] },
    })
    const said = () => f.open()?.text.split("labels moved").length ?? 1
    waiting = ["labels moved to Codex"]
    const first = notice()
    wakes.notice("apex", "", first)
    assert.equal(said(), 2, "the first digest carries it")
    const second = notice()
    wakes.notice("apex", "", second)
    assert.equal(said(), 2, "a report joining keeps it, once")
    assert.equal(wakes.withdraw("apex", first.id), true)
    assert.equal(said(), 2, "a withdrawal keeps it")
    live.add(second.id)
    wakes.refresh("apex")
    assert.equal(f.open(), undefined, "its last report gone, the digest goes")
    assert.deepEqual(waiting, ["labels moved to Codex"], "and what it carried waits for the next")
    live.clear()
    wakes.notice("apex", "", notice())
    assert.equal(said(), 2, "which says it")
    assert.deepEqual(waiting, [])
    waiting = ["share moved to Codex"]
    const open = f.open()!
    open.sent = 1
    wakes.notice("apex", "", notice())
    assert.ok(f.open()!.text.includes("share moved"), "a digest that went meanwhile leaves it to the next one")
    f.open()!.sent = 2
    // Refused and not taken, it isn't lost.
    waiting = ["grok moved to Codex"]
    const refused = new AgentWakes({ ...f.deps, admit: () => { throw new Error("a switch is under way") }, takeLines: () => { const lines = waiting; waiting = []; return lines }, giveLines: (_conversation, lines) => { waiting = [...lines, ...waiting] } })
    refused.notice("apex", "", notice())
    assert.deepEqual(waiting, ["grok moved to Codex"], "a digest the queue refused gives it back")
    ready = "steer"
    answer = Promise.resolve(false)
    wakes.notice("apex", "", notice())
    await pause(0)
    assert.ok(f.open()!.text.includes("grok moved"), "a steer not taken: it goes in the digest instead")
  }
  {
    // Results that ask nothing, minutes apart: the first of a run goes at once, and the ones after it are held in the
    // one unsent digest for the Fins still at work, `HOLD_RESULTS_MS` at most from the first held.
    let clock = 9_000_000
    let ready: ParentReady = "idle"
    let working = true
    let onNews = false
    const waitedFor = new Set<string>()
    const f = fakes(() => ready, () => clock)
    const deps: AgentWakesDeps = { ...f.deps, working: () => working, onNews: () => onNews, waitedFor: (each) => waitedFor.has(each.id) }
    const wakes = new AgentWakes(deps)
    const heldUntil = () => f.open()?.hold
    /** The digest that waits goes, as the queue would send it, and its turn is over a moment later. */
    const goes = () => {
      f.open()!.sent = clock
      clock += 30_000
    }
    wakes.notice("apex", "", notice())
    assert.equal(heldUntil(), undefined, "the first result of a run goes at once, whoever still works")
    goes()
    const since = clock
    const second = notice()
    wakes.notice("apex", "", second)
    assert.deepEqual(heldUntil(), { at: since + HOLD_RESULTS_MS, since }, "the next is held for the Fins still at work")
    assert.ok(f.delivered.includes(second.report.id), "heard by the store once it's in the queue, as any digest's report")
    clock += 60_000
    wakes.notice("apex", "", notice())
    assert.equal(f.entries.filter((entry) => entry.sent === undefined).length, 1, "and the one after joins it")
    assert.deepEqual(heldUntil(), { at: since + HOLD_RESULTS_MS, since }, "its time still counted from the first held")
    wakes.refresh("apex")
    wakes.settled("apex", false)
    assert.deepEqual(heldUntil(), { at: since + HOLD_RESULTS_MS, since }, "a Fin's step, or the end of a turn its Fins' news started, frees nothing")

    // What ends the hold sends them as one digest. Each case holds two results again first.
    const again = () => {
      if (f.open()) goes()
      working = true
      ready = "idle"
      wakes.notice("apex", "", notice())
      wakes.notice("apex", "", notice())
      assert.equal(f.open()!.notices.length, 2)
      assert.ok(typeof f.open()!.hold === "object" && (f.open()!.hold as { since?: number }).since !== undefined, "two results held")
    }
    const freed = (what: string, count: number) => {
      assert.equal(f.entries.filter((entry) => entry.sent === undefined && !entry.canceled).length, 1, `${what}: one digest`)
      assert.equal(f.open()!.hold, undefined, `${what}: it goes now`)
      assert.equal(f.open()!.notices.length, count, `${what}: with everything that was held`)
    }
    // A report that asks, or that went wrong, takes them along.
    const asking: [string, Notice][] = [
      ["a failure", notice("failed")],
      ["an end without a result", notice("failed", {}, { unfinished: true })],
      ["a question", notice("blocked")],
      ["a question for the person its Apex hears of", notice("blocked", {}, { for: "person", told: true })],
      ["a decision", notice("done", { decision: "lead" }, { question: "Merge it?" })],
      ["a result a wait start waited for", notice("done", { settledOnly: true })],
      ["a handoff", notice("progress", {}, { handoff: { to: "fin:other" } })],
      ["a wait on someone", notice("progress", {}, { awaits: true })],
      ["another Apex's reply", notice("done", { reply: true })],
      ["a Fin gone quiet", notice("done", { quiet: { since: 1, forMs: 2 } })],
    ]
    for (const [what, each] of asking) {
      again()
      wakes.notice("apex", "", each)
      freed(what, 3)
    }
    // None of those is ever held itself, the Apex woken a moment ago and Fins still at work or not.
    for (const [what, each] of asking) {
      goes()
      clock -= 29_000
      const fresh = { ...each, id: `${each.id}:again`, report: { ...each.report, id: `${each.report.id}:again` } }
      wakes.notice("apex", "", fresh)
      const hold = f.open()!.hold
      assert.ok(hold === undefined || (typeof hold === "object" && hold.since === undefined && hold.at <= clock + WAKE_COALESCE_MS), `${what} is never held past its window: ${JSON.stringify(hold)}`)
      clock += 29_000
    }
    // Nor a result a wait its Apex armed names: that wait's note is on its way.
    goes()
    const waited = notice()
    waitedFor.add(waited.id)
    wakes.notice("apex", "", waited)
    assert.equal(typeof heldUntil() === "object" && (heldUntil() as { since?: number }).since !== undefined, false, "a result a turn wait names isn't held")
    again()
    const named = notice()
    waitedFor.add(named.id)
    wakes.notice("apex", "", named)
    freed("a result a turn wait names", 3)
    // The tree goes quiet: the last Fin's own result, or the last one stopping however it did.
    again()
    working = false
    wakes.notice("apex", "", notice())
    freed("the last Fin's result", 3)
    again()
    working = false
    wakes.refresh("apex")
    freed("none of its Fins at work any more", 2)
    // A turn of the Apex's own ends.
    again()
    wakes.settled("apex", true)
    freed("a turn of its own ended", 2)
    // A question steered into its running turn: what was held goes at that turn's end.
    again()
    ready = "steer"
    const steering = new AgentWakes({ ...deps, steer: () => Promise.resolve(true) })
    steering.notice("apex", "", notice("blocked"))
    await pause(0)
    freed("a question its running turn took", 2)
    steering.dispose()
    // Past the bound since the Apex was last woken, a result is the first of a run again.
    goes()
    ready = "idle"
    working = true
    clock += HOLD_RESULTS_MS
    wakes.notice("apex", "", notice())
    assert.equal(heldUntil(), undefined, "a result long after the last digest goes at once")
    // During a turn its Fins' news started, a result is held as while idle; during a turn of its own it waits for that
    // turn's end, unheld, as before.
    goes()
    clock -= 20_000
    ready = "queue"
    onNews = true
    wakes.notice("apex", "", notice())
    assert.deepEqual(heldUntil(), { at: clock + HOLD_RESULTS_MS, since: clock }, "held through a turn its Fins' news started")
    wakes.settled("apex", false)
    assert.ok(heldUntil(), "and past its end")
    wakes.settled("apex", true)
    goes()
    clock -= 20_000
    onNews = false
    wakes.notice("apex", "", notice())
    assert.equal(heldUntil(), undefined, "a turn of its own: its end takes it")
    // A held digest that is full: the next result starts one behind it, held until the same time.
    goes()
    ready = "idle"
    const from = clock
    for (let count = 0; count <= FIN_REPORTS_MAX; count += 1) wakes.notice("apex", "", notice())
    const waiting = f.entries.filter((entry) => entry.sent === undefined && !entry.canceled)
    assert.deepEqual(waiting.map((entry) => entry.notices.length), [FIN_REPORTS_MAX, 1])
    assert.deepEqual(waiting.map((entry) => entry.hold), [{ at: from + HOLD_RESULTS_MS, since: from }, { at: from + HOLD_RESULTS_MS, since: from }], "both go at the first one's time")
    working = false
    wakes.refresh("apex")
    assert.deepEqual(waiting.map((entry) => entry.hold), [undefined, undefined], "and both are freed together")
    for (const entry of waiting) entry.sent = clock
    // A running turn's focus steer leaves a held digest where it is.
    {
      const steered: string[] = []
      const g = fakes(() => "steer", () => 5_000_000)
      g.entries.push({ id: "sent", text: "", notices: [], hold: undefined, sent: 5_000_000 - 1_000 })
      const focused = new AgentWakes({ ...g.deps, working: () => true, onNews: () => true, focusMs: 30, steerQueued: (_conversation, _id, request) => { steered.push(request); return Promise.resolve(true) } })
      focused.notice("apex", "", notice())
      assert.ok(typeof g.open()!.hold === "object", "held in a turn its Fins' news started")
      await pause(90)
      assert.deepEqual(steered, [], "a held digest isn't steered into the turn")
      focused.dispose()
    }
    // With nothing to say a Fin is still at work, nothing is held: the rule as it was.
    {
      const g = fakes(() => "idle", () => clock)
      const plain = new AgentWakes(g.deps)
      plain.notice("apex", "", notice())
      g.open()!.sent = clock
      clock += 30_000
      plain.notice("apex", "", notice())
      assert.equal(g.open()!.hold, undefined)
    }
    // Twelve Fins finishing over ten minutes, fifty seconds apart: a digest and a turn each before, three now, the
    // first result's at once, then the results of the next five minutes, then the rest as the last Fin finishes.
    assert.deepEqual(twelveFins(false, 20_000), Array.from({ length: 12 }, () => 1), "before: twelve digests")
    assert.deepEqual(twelveFins(true, 20_000), [1, 7, 4], "now: three")
    // The same with an Apex whose turn on a digest outlasts the gap between results: before, each turn's end sent what
    // came during it, so nearly one a result still.
    assert.equal(twelveFins(false, 60_000).length, 11, "before, a slow Apex: eleven")
    assert.deepEqual(twelveFins(true, 60_000), [1, 7, 4], "now: three")
    console.log("wakes: results that ask nothing are held for the Fins still at work after the first, and go as one digest when a Fin asks or fails, none is at work, a turn of the Apex's own ends, or five minutes passed; twelve Fins over ten minutes are 3 digests, 12 before")
  }
  // A digest goes on with all it carries; what's left behind is how that attempt went, named once.
  assert.deepEqual(carriedDigest({ notices: [], lines: ["moved"], sentAt: 1, heard: true, resting: true, nextTry: 2 }), { notices: [], lines: ["moved"] })
  console.log("wakes: an idle Apex's first report goes at once and what follows is one digest; joins, results, busy, stopped, steered, carried receipts, and withdrawals and stale ends across every unsent digest")

  // A host killed by SIGKILL at each write between a digest, its claim and its receipt: each report delivered once.
  for (const harness of ["claude", "cursor"] as const) {
    for (const gap of GAPS) {
      const dir = join(root, `${harness}-${gap.replaceAll(" ", "-")}`)
      const nth = gap === "wake" ? 2 : 1
      const child = spawn(process.execPath, ["--import", "tsx", import.meta.filename, "--host", dir, harness, gap, String(nth)], { stdio: "ignore" })
      const exit = await new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)))
      assert.equal(exit, "SIGKILL", `${harness} ${gap}: the host was killed there`)
      const apex = readFileSync(join(dir, "apex"), "utf8")
      // The second Fin's turn the kill cut goes on here (a crash's continuation), and ends as the second's report.
      const world = new AgentsWorld({ root: dir, script: (turn) => (turn.conversation === apex ? "ok" : turn.text.includes("fin:first") ? "First finished." : turn.text.includes("fin:second") ? "Second finished." : "Third finished.") })
      // The first report's digest went before the kill, in the host that died: what the Apex heard is read from its
      // journal, which both hosts wrote, each digest that was sent by the reports its cards name.
      const heard = () => (world.live.snapshot(apex)?.requests ?? []).filter((request) => request.digest && request.status !== "canceled")
      await until(`${harness} ${gap}: the three reports heard`, () => {
        const digests = heard()
        return digests.every((request) => request.status === "completed") && digests.flatMap((request) => readFinReports(request.text).reports).length >= 3
      }, 15_000)
      await world.settle(800, 20_000, "ignore")
      // Each report by its ID, as the digests' cards name them: every one the Fins wrote, each in one digest.
      const carried = heard().flatMap((request) => readFinReports(request.text).reports.map((card) => card.report))
      assert.equal(new Set(carried).size, carried.length, `${harness} ${gap}: no report delivered twice (${carried.join(", ")})`)
      const written = world.store.edges().children(world.store.journalPlacement(apex)!.thread).flatMap((edge) => world.store.reportsOf(edge.child, 0).map((report) => report.id))
      assert.deepEqual([...carried].sort(), [...written].sort(), `${harness} ${gap}: every report delivered`)
      assert.equal(world.store.undeliveredReports().length, 0, `${harness} ${gap}: every report heard`)
      await world.close()
    }
    console.log(`${harness}: SIGKILL at every write gap of a digest recovered to each report delivered once`)
  }

  // Fins' news folded into the person's turn (`foldQueued`) that fails before its model answers goes again by itself, as
  // a digest of its own would: never lost with the turn that carried it.
  {
    let failed = false
    const script: Script = (turn) => {
      if (turn.text.includes("Hold.")) return turn.world.hold(turn.conversation).then(() => "Held.")
      if (turn.text.startsWith("Ship it.") && !failed) {
        failed = true
        turn.world.endWith(turn.conversation, { fail: "503 Service unavailable" })
        return ""
      }
      return "ok"
    }
    const world = new AgentsWorld({ root: join(root, "folded-news"), script })
    const { conversation } = await world.apex("claude", "full")
    world.say(conversation, "Hold.")
    await until("the turn", () => world.live.session(conversation)?.status === "running")
    world.say(conversation, "Ship it.")
    const actor = { kind: "agent" as const, session: world.store.journalPlacement(conversation)!.session }
    const news = randomUUID()
    world.live.submit(conversation, news, `${FROM_AGENTS}\nDigest folded.`, [], undefined, undefined, undefined, actor, { digest: { notices: [notice()] }, wake: { at: Date.now() + 60_000, after: DIGEST_WAITS } })
    world.release(conversation)
    const heard = () => world.prompts.filter((prompt) => prompt.conversation === conversation && prompt.text.includes("Digest folded."))
    await until("the news to go again after the turn carrying it failed", () => heard().length === 2, 15_000)
    assert.ok(heard()[0]!.text.startsWith("Ship it."), "first inside the person's turn")
    assert.ok(heard()[1]!.text.startsWith(FROM_AGENTS), "then as a digest of its own")
    const requests = world.live.snapshot(conversation)!.requests
    const carrier = requests.find((request) => request.text.startsWith("Ship it."))!
    assert.equal(requests.find((request) => request.id === news)?.joinedInto, carrier.id, "it went inside the person's turn")
    assert.equal(requests.filter((request) => request.continues?.requestId === news && request.digest).length, 1, "and goes again once")
    await world.settle(300, 10_000, "ignore")
    assert.equal(heard().length, 2, "no more than that")
    await world.close()
    console.log("wakes: Fins' news a failed turn carried goes again as its own digest, once")
  }

  // Fins' news folded into a turn that ran into a usage limit waits with that turn for the limit's reset: it isn't sent
  // alone into the same limit, to rest under a lone digest's rules.
  {
    let failed = false
    const script: Script = (turn) => {
      if (turn.text.includes("Hold.")) return turn.world.hold(turn.conversation).then(() => "Held.")
      if (turn.text.startsWith("Ship it.") && !failed) {
        failed = true
        turn.world.endWith(turn.conversation, { fail: "You have reached your usage limit. Try again later." })
        return ""
      }
      return "ok"
    }
    const world = new AgentsWorld({ root: join(root, "folded-news-limit"), script })
    const { conversation } = await world.apex("claude", "full")
    world.say(conversation, "Hold.")
    await until("the turn", () => world.live.session(conversation)?.status === "running")
    world.say(conversation, "Ship it.")
    const actor = { kind: "agent" as const, session: world.store.journalPlacement(conversation)!.session }
    const news = randomUUID()
    world.live.submit(conversation, news, `${FROM_AGENTS}\nDigest at the limit.`, [], undefined, undefined, undefined, actor, { digest: { notices: [notice()] }, wake: { at: Date.now() + 60_000, after: DIGEST_WAITS } })
    world.release(conversation)
    const again = () => world.live.snapshot(conversation)?.requests.find((request) => request.continues?.requestId === news && request.digest)
    await until("the news to wait for the limit", () => again() !== undefined, 15_000)
    await pause(500)
    const heard = () => world.prompts.filter((prompt) => prompt.conversation === conversation && prompt.text.includes("Digest at the limit."))
    assert.equal(again()!.status, "held", "it waits")
    assert.ok(again()!.retry, "for the turn's retry")
    assert.equal(heard().length, 1, "not sent alone into the limit: only inside the turn that ran into it")
    world.live.wakeDue(again()!.retry!.at + 1)
    await until("the news to go once the limit's time comes", () => heard().length === 2, 15_000)
    assert.ok(heard()[1]!.text.startsWith(FROM_AGENTS), "as a digest of its own")
    await world.close()
    console.log("wakes: Fins' news a turn carried into a usage limit waits for the limit's reset with it")
  }

  for (const harness of TESTED_HARNESSES) {
    // The minute's budget is the queue's, as it sends: seven digests waiting for a busy Apex go six now, the seventh a minute after the first.
    {
      const world = new AgentsWorld({ root: join(root, `${harness}-budget`), script: (turn) => (turn.text.includes("Hold.") ? turn.world.hold(turn.conversation).then(() => "Held.") : "ok") })
      const { conversation } = await world.apex(harness, "full")
      world.say(conversation, "Hold.")
      await until("the turn", () => world.live.session(conversation)?.status === "running")
      const actor = { kind: "agent" as const, session: world.store.journalPlacement(conversation)!.session }
      for (let index = 0; index < WAKES_PER_MINUTE + 1; index++) {
        const carried = notice()
        world.live.submit(conversation, randomUUID(), `${FROM_AGENTS}\nDigest ${index}.`, [], undefined, undefined, undefined, actor, { digest: { notices: [carried] } })
      }
      world.release(conversation)
      await until(`${harness}: six to go`, () => world.prompts.filter((prompt) => prompt.conversation === conversation && prompt.text.includes("Digest ")).length === WAKES_PER_MINUTE)
      await pause(500)
      const sent = world.prompts.filter((prompt) => prompt.conversation === conversation && prompt.text.includes("Digest "))
      assert.equal(sent.length, WAKES_PER_MINUTE, `${harness}: only six in a minute`)
      const seventh = world.live.snapshot(conversation)!.requests.find((request) => request.text.includes(`Digest ${WAKES_PER_MINUTE}.`))!
      assert.equal(seventh.status, "held")
      assert.equal(seventh.wake?.after, DIGEST_WAITS)
      const first = world.live.snapshot(conversation)!.requests.find((request) => request.text.includes("Digest 0."))!
      assert.equal(seventh.wake!.at, first.digest!.sentAt! + 60_000, "a minute after the first went")
      // Not before its slot: due early, it's held again.
      world.live.wakeDue(seventh.wake!.at + 1)
      await pause(300)
      assert.ok(!world.prompts.some((prompt) => prompt.conversation === conversation && prompt.text.includes(`Digest ${WAKES_PER_MINUTE}.`)), `${harness}: not before the minute`)
      // A minute on, it goes.
      const realNow = Date.now
      const later = mock.method(Date, "now", () => realNow() + 61_000)
      try {
        world.live.wakeDue(Date.now() + 1)
        await until(`${harness}: the seventh at its slot`, () => world.prompts.some((prompt) => prompt.conversation === conversation && prompt.text.includes(`Digest ${WAKES_PER_MINUTE}.`)))
      } finally {
        later.mock.restore()
      }
      await world.close()
    }

    // A digest steered into a long turn (`FOCUS_MS`) whose harness refuses the steer after that turn ended goes back to
    // the queue of an idle Apex: it goes, rather than waiting there for a turn's end that has already come.
    if (harness === "claude") {
      const world = new AgentsWorld({ root: join(root, `${harness}-steer-refused`), focusMs: 100, steering: { claude: { lands: "step", holds: true } }, script: (turn) => (turn.text.endsWith("Hold.") ? turn.world.hold(turn.conversation).then(() => "Held.") : turn.text.includes("You're fin:") ? "Labels finished." : "ok") })
      const { conversation, caller } = await world.apex(harness, "full")
      world.say(conversation, "Hold.")
      await until(`${harness}: the Apex's long turn`, () => world.prompts.some((prompt) => prompt.conversation === conversation && prompt.text.endsWith("Hold.")))
      const started = await world.agents.start(caller, { brief: { objective: "Label it" }, harness: "codex", name: "labels", clientKey: "labels", cwd: world.root })
      assert.ok(!("refused" in started), JSON.stringify(started))
      // Its report waits for the turn's end, and is steered in once the turn has run long: the harness holds the steer.
      await until(`${harness}: the digest steered in`, () => world.live.snapshot(conversation)?.control?.actions?.some((action) => action.input.kind === "steer-queued" && action.state.kind === "dispatching") === true)
      world.release(conversation)
      await until(`${harness}: the turn to end`, () => !world.live.atWork(conversation))
      assert.ok(world.answerSteer(conversation, { kind: "not-accepted", reason: "The turn moved on" }), "the held steer was answered")
      await until(`${harness}: the refused digest to go`, () => world.prompts.some((prompt) => prompt.conversation === conversation && prompt.text.includes(FROM_AGENTS) && prompt.text.includes('"labels"')), 5_000)
      await world.settle()
      assert.equal(world.store.undeliveredReports().length, 0, `${harness}: every report heard`)
      await world.close()
    }

    // A digest its harness refused before taking it woke nobody: it isn't counted in the minute, so its own next try,
    // the sixth to reach the harness, goes at once rather than waiting out a minute it never spent.
    {
      let refusing = false
      const world = new AgentsWorld({ root: join(root, `${harness}-budget-refused`), script: () => "ok", refusePrompt: () => {
        if (!refusing) return undefined
        refusing = false
        return "Not now: the test refuses it."
      } })
      const { conversation } = await world.apex(harness, "full")
      const actor = { kind: "agent" as const, session: world.store.journalPlacement(conversation)!.session }
      const reached = () => world.prompts.filter((prompt) => prompt.conversation === conversation && prompt.text.includes("Digest ")).length
      for (let index = 0; index < WAKES_PER_MINUTE - 1; index++) {
        world.live.submit(conversation, randomUUID(), `${FROM_AGENTS}\nDigest ${index}.`, [], undefined, undefined, undefined, actor, { digest: { notices: [notice()] } })
        await until(`${harness}: digest ${index} to go`, () => reached() === index + 1)
      }
      refusing = true
      const last = randomUUID()
      world.live.submit(conversation, last, `${FROM_AGENTS}\nDigest ${WAKES_PER_MINUTE - 1}.`, [], undefined, undefined, undefined, actor, { digest: { notices: [notice()] } })
      await until(`${harness}: the refusal`, () => !refusing && world.live.snapshot(conversation)?.requests.find((request) => request.id === last)?.status !== "dispatching")
      // Refused for no reason that clears by itself, it rests until the next turn that can run: the next news brings it.
      world.live.submit(conversation, randomUUID(), `${FROM_AGENTS}\nNews after it.`, [], undefined, undefined, undefined, actor, { digest: { notices: [notice()] } })
      await until(`${harness}: the refused digest's next try`, () => world.prompts.some((prompt) => prompt.conversation === conversation && prompt.text.includes(`Digest ${WAKES_PER_MINUTE - 1}.`)))
      const went = world.live.snapshot(conversation)!.requests.find((request) => request.id === last)!
      assert.notEqual(went.wake?.after, DIGEST_WAITS, `${harness}: not held for the minute's budget`)
      await world.close()
    }

    // A harness that refuses every prompt before taking it, for a cause that clears by itself or one that doesn't: a digest
    // it refuses is tried again a bounded number of times, never in a loop, however the minute's budget counts it.
    for (const refusal of ["503 Service Unavailable", "Not now: the test refuses it."]) {
      let tries = 0
      const world = new AgentsWorld({ root: join(root, `${harness}-refused-loop-${tries}-${refusal.length}`), script: () => "ok", refusePrompt: () => {
        tries += 1
        return refusal
      } })
      const { conversation } = await world.apex(harness, "full")
      const actor = { kind: "agent" as const, session: world.store.journalPlacement(conversation)!.session }
      world.live.submit(conversation, randomUUID(), `${FROM_AGENTS}\nRefused again.`, [], undefined, undefined, undefined, actor, { digest: { notices: [notice()] } })
      await until(`${harness}: the first refusal`, () => tries > 0)
      await pause(3_000)
      assert.ok(tries <= 3, `${harness}: "${refusal}" refused ${tries} times in three seconds`)
      await world.close()
    }

    // A journal that can't be written fails its own conversation alone: the others' times go, and its own once writes come back.
    {
      const world = new AgentsWorld({ root: join(root, `${harness}-readonly`), script: () => "ok" })
      const a = (await world.apex(harness, "full")).conversation
      const b = (await world.apex(harness, "full")).conversation
      await world.settle(300)
      const at = Date.now() + 200
      for (const [conversation, words] of [[a, "For A."], [b, "For B."]] as const)
        world.live.submit(conversation, randomUUID(), words, [], undefined, undefined, undefined, undefined, { wake: { at, after: "earlier" } })
      const commit = LiveJournal.prototype.commit
      const broken = mock.method(LiveJournal.prototype, "commit", function (this: LiveJournal, ...args: Parameters<LiveJournal["commit"]>) {
        if (args[0].session.id === a) throw new Error("attempt to write a readonly database")
        return commit.apply(this, args)
      })
      try {
        world.live.wakeDue(at + 1)
        await until(`${harness}: B to go though A can't be written`, () => world.prompts.some((prompt) => prompt.conversation === b && prompt.text.includes("For B.")))
        assert.equal(world.live.snapshot(a)?.requests.find((request) => request.text.includes("For A."))?.status, "held", "A waits, nothing sent that isn't written")
      } finally {
        broken.mock.restore()
      }
      await until(`${harness}: A to go once writes come back`, () => world.prompts.some((prompt) => prompt.conversation === a && prompt.text.includes("For A.")), 15_000)
      await world.close()
    }
    console.log(`${harness}: the minute's budget held the seventh digest to its slot; an unwritable journal held its own message alone and sent it once writes came back`)
  }
} finally {
  if (process.argv[2] !== "--host") rmSync(root, { recursive: true, force: true })
}
if (process.argv[2] !== "--host") console.log("wake queue: ok")

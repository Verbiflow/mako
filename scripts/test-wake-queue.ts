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
import { AgentWakes, FROM_AGENTS, RESULT_COALESCE_MS, WAKE_COALESCE_MS, WAKES_PER_MINUTE, type AgentWakesDeps, type ParentReady } from "@mako/host/conversations/agent-wakes"
import { carriedDigest } from "@mako/host/contracts/delivery-retry"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { AgentsWorld, TESTED_HARNESSES, type Script } from "./lib/agents-world.ts"

/**
 * An Apex's Fins' news is a producer into the Apex's own queue (`npm run
 * test:wake-queue`), step two of the one delivery queue: the queue keeps each
 * digest durably and sends it once, so nothing about it lives only in memory.
 * Covered, against the producer's rules with fake conversations: a burst is
 * one digest, held for its window; a notice joins the newest digest still
 * unsent; a result the Apex waited for is held only briefly; a busy Apex's
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

interface Entry { id: string; text: string; notices: Notice[]; lines?: readonly string[]; hold: { at: number } | "paused" | undefined; sent?: number; canceled?: boolean }

/** One Apex conversation as the queue would hold it, and every call the producer made. */
function fakes(ready: () => ParentReady, now: () => number, steer: (text: string) => Promise<boolean> | false = () => false, current: (notice: Notice) => boolean = () => true) {
  const entries: Entry[] = []
  const delivered: string[] = []
  const unsent = () => entries.filter((entry) => entry.sent === undefined && !entry.canceled)
  const deps: AgentWakesDeps = {
    ready,
    unsent: () => unsent().map((entry) => ({ id: entry.id, notices: entry.notices, ...(entry.lines && { lines: entry.lines }) })),
    carried: (_conversation, id) => entries.some((entry) => !entry.canceled && entry.notices.some((each) => each.id === id)),
    admit: (_conversation, id, text, notices, _actor, hold, lines) => { if (!entries.some((entry) => entry.id === id)) entries.push({ id, text, notices: [...notices], hold, ...(lines && { lines }) }) },
    rewrite: (_conversation, id, text, notices, lines) => {
      const entry = unsent().find((candidate) => candidate.id === id)
      if (!entry) return false
      if (!notices.length) entry.canceled = true
      entry.text = text
      entry.notices = [...notices]
      entry.lines = lines ?? []
      return true
    },
    steer: (_conversation, _id, text) => steer(text),
    assign: () => {},
    delivered: (reports) => delivered.push(...reports),
    counts: () => "1 working",
    current,
    now,
  }
  return { entries, delivered, deps, open: () => unsent().at(-1) }
}

let reports = 0
function notice(status: "done" | "blocked" = "done", marks: Partial<Notice> = {}): Notice {
  reports += 1
  const report = ReportSchema.parse({ id: `report:${reports}`, child: randomUUID(), status, summary: `Report ${reports}.`, ownerGeneration: 1, at: reports })
  return { id: `notice:${report.child}:${report.id}`, report, label: `"fin-${reports}" (Claude)`, fin: { name: `fin-${reports}`, harness: "claude" }, from: randomUUID(), ...marks }
}

/** The write gaps a digest crosses: its claim and its row as it starts, its row and its claim as a notice joins it. */
const GAPS = ["digest start assigned", "digest admitted", "digest joined", "digest join assigned", "wake"] as const

/**
 * A child host: an idle Apex with two Fins that report one after the other, the second joining the first's digest;
 * killed by SIGKILL at `gap`, the `nth` time its log says it.
 */
async function childHost(dir: string, harness: string, gap: string, nth: number): Promise<void> {
  let seen = 0
  followHostLog((line) => {
    if (line.message === gap && ++seen === nth) process.kill(process.pid, "SIGKILL")
  })
  const script: Script = (turn) => (turn.text.includes("You're fin:") ? turn.world.hold(turn.conversation).then(() => `${turn.text.includes("fin:first") ? "First" : "Second"} finished.`) : "ok")
  const world = new AgentsWorld({ root: dir, script })
  const apex = await world.apex(harness, "full")
  writeFileSync(join(dir, "apex"), apex.conversation)
  const fins: string[] = []
  for (const name of ["first", "second"]) {
    const started = await world.agents.start(apex.caller, { brief: { objective: `Label ${name}` }, harness, name, clientKey: name, cwd: world.root })
    if ("refused" in started) throw new Error(started.why)
    fins.push(started.conversation!)
  }
  await until("both Fins", () => fins.every((fin) => world.live.session(fin)?.status === "running"))
  world.release(fins[0]!)
  await until("the first's digest", () => Boolean(world.live.snapshot(apex.conversation)?.requests.some((request) => request.digest)))
  world.release(fins[1]!)
  await new Promise(() => {})
}

if (process.argv[2] === "--host") await childHost(process.argv[3]!, process.argv[4]!, process.argv[5]!, Number(process.argv[6]))

try {
  // The producer's rules, against fake conversations.
  {
    const clock = 1_000_000
    let ready: ParentReady = "idle"
    const f = fakes(() => ready, () => clock)
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
    // A result the Apex waited for is held only briefly.
    wakes.notice("apex", "", notice("done", { settledOnly: true }))
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
    // A running turn that takes a step's message hears a notice now; one it refuses joins the digest.
    let answer = true
    const steered: string[] = []
    const f = fakes(() => "steer", () => 5_000_000, (text) => { steered.push(text); return Promise.resolve(answer) })
    const wakes = new AgentWakes(f.deps)
    wakes.notice("apex", "", notice())
    await pause(0)
    assert.equal(steered.length, 1)
    assert.equal(f.entries.length, 0, "taken by the running turn, nothing queued")
    answer = false
    wakes.notice("apex", "", notice())
    await pause(0)
    assert.equal(f.entries.length, 1, "a refused steer goes as a digest of its own")
    wakes.notice("apex", "", notice("done", { settledOnly: true }))
    assert.equal(steered.length, 2, "a result is never steered")
    assert.equal(f.open()!.notices.length, 2)
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
  // A digest goes on with all it carries; what's left behind is how that attempt went, named once.
  assert.deepEqual(carriedDigest({ notices: [], lines: ["moved"], sentAt: 1, heard: true, resting: true, nextTry: 2 }), { notices: [], lines: ["moved"] })
  console.log("wakes: a burst is one digest held for its window; joins, results, busy, stopped, steered, carried receipts, and withdrawals and stale ends across every unsent digest")

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
      const world = new AgentsWorld({ root: dir, script: (turn) => (turn.conversation === apex ? "ok" : turn.text.includes("fin:first") ? "First finished." : "Second finished.") })
      await until(`${harness} ${gap}: both reports heard`, () => {
        const words = world.prompts.filter((prompt) => prompt.conversation === apex && prompt.text.startsWith(FROM_AGENTS)).map((prompt) => readFinReports(prompt.text).text).join("\n")
        return words.includes("First finished.") && words.includes("Second finished.")
      }, 15_000)
      await world.settle(800, 20_000, "ignore")
      // Each report by its ID, as the digests' cards name them: every one the Fins wrote, each in one digest.
      const carried = world.prompts.filter((prompt) => prompt.conversation === apex && prompt.text.startsWith(FROM_AGENTS)).flatMap((prompt) => readFinReports(prompt.text).reports.map((card) => card.report))
      assert.equal(new Set(carried).size, carried.length, `${harness} ${gap}: no report delivered twice (${carried.join(", ")})`)
      const written = world.store.edges().children(world.store.journalPlacement(apex)!.thread).flatMap((edge) => world.store.reportsOf(edge.child, 0).map((report) => report.id))
      assert.deepEqual([...carried].sort(), [...written].sort(), `${harness} ${gap}: every report delivered`)
      assert.equal(world.store.undeliveredReports().length, 0, `${harness} ${gap}: every report heard`)
      await world.close()
    }
    console.log(`${harness}: SIGKILL at every write gap of a digest recovered to each report delivered once`)
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

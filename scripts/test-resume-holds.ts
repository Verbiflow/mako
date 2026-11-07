import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { cpSync } from "node:fs"
import { join } from "node:path"
import { mock } from "node:test"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import type { Entry } from "@mako/sessions/entries"
import { Agents } from "@mako/host/conversations/agents"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { LiveRecords } from "@mako/host/conversations/live-records"
import { AgentsWorld, type Script } from "./lib/agents-world.ts"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * A host starting takes up what the last one left without holding its loop (`npm run test:resume-holds`).
 *
 * On 2026-11-07 the person's host held its loop for 4.8 s as it started: resuming Fins (`Agents.resume`) read every
 * open Fin's journal whole (`LiveJournal.read`), one after another, inside the core domain's load. Now the host reads
 * each of them in first a slice at a time (`Agents.resumeInSlices`, `LiveConversations.continueRestartedInSlices`),
 * then resumes as before.
 *
 * Eight Fins work under an Apex, half cut mid-turn by Mako's exit and half finished, their journals grown to a long
 * day's. The same left state is taken up twice by a fresh host: once at once, as the host did (the yardstick, in this
 * run and on this machine), once as the host does now. The loop's longest hold while resuming in slices must stay
 * under a quarter of the one at once (`TIMES`), and both must resume exactly the same: the same messages sent on, the
 * same turns continued, every Fin's requests in the same states.
 *
 * And nothing the resume reads is read whole: every conversation it reads in from its journal (`LiveRecords.load` of
 * one not in memory) must have been read in first. A settled Apex whose Fin's report was kept but not yet heard when
 * the host died is read as the report is sent again (its queue is the receipt), so it's read in first too.
 */
const FINS = 8
/** Blocks added to each Fin's journal, and their size: about 18 MB a journal. */
const BLOCKS = 12_000
const BLOCK_CHARS = 1_500
/** How many times shorter than the hold at once the longest hold in slices must be. */
const TIMES = 4

const root = testScratch("mako-resume-holds-")
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, done: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(10)
  }
}

/** The longest the loop went without turning while `work` ran, and a moment after, sampled every millisecond. */
async function longestHold(work: () => Promise<void>): Promise<number> {
  let longest = 0
  let last = performance.now()
  let running = true
  const tick = () => {
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
    if (running) setTimeout(tick, 1)
  }
  setTimeout(tick, 1)
  await work()
  await pause(100)
  running = false
  return Math.max(longest, performance.now() - last)
}

function block(fin: number, index: number): Entry {
  const text = `Fin ${fin}, step ${index}: ${"read the file, ran the tests, kept the result. ".repeat(BLOCK_CHARS / 48)}`
  return index % 2 ? { type: "text", id: `grown-${fin}-${index}`, text } : { type: "tool", id: `grown-${fin}-${index}`, name: "Bash", status: "completed", input: JSON.stringify({ command: `npm test -- ${index}` }), output: text }
}

/** The last host: an Apex with `FINS` Fins, the even ones still working as Mako exits, then their journals grown. */
async function leftByTheLastHost(at: string): Promise<{ fins: Map<string, string> }> {
  const working = new Set<string>()
  const script: Script = async (turn) => {
    if (!turn.text.includes("You're fin:")) return "ok"
    const name = /You're fin:(\S+?),/.exec(turn.text)?.[1] ?? ""
    if (Number(name.slice(1)) % 2 === 0) {
      working.add(name)
      return turn.world.hold(turn.conversation).then(() => "Cut short.")
    }
    return `${name} finished.`
  }
  const world = new AgentsWorld({ root: at, script, finLimit: () => FINS * 2 })
  const apex = await world.apex("claude", "full")
  const fins = new Map<string, string>()
  for (let index = 0; index < FINS; index++) {
    const name = `f${index}`
    const started = await world.agents.start(apex.caller, { brief: { objective: `Work ${name}` }, harness: index % 3 === 0 ? "codex" : "claude", name, clientKey: name, cwd: at })
    assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
    fins.set(name, started.conversation!)
  }
  await until("the even Fins' turns to run", () => working.size === FINS / 2)
  await until("the odd Fins' turns to end", () => [...fins].every(([name, conversation]) => working.has(name) || world.live.snapshot(conversation)?.requests.at(-1)?.status === "completed"))
  await world.close()
  for (const [index, conversation] of [...fins.values()].entries()) {
    const journal = new LiveJournal(join(at, "journals"), conversation)
    const before = journal.read()
    assert.ok(before, `${conversation}'s journal`)
    journal.commit({ ...before, blocks: [...before.blocks, ...Array.from({ length: BLOCKS }, (_, at) => block(index, at))] }, before)
    journal.close()
  }
  return { fins }
}

interface Taken {
  holdMs: number
  /** What each Fin was sent once the host was back, in order. */
  sent: Record<string, string[]>
  /** Each Fin's requests as they stand once the host settles: a continuation's ID is new each time, so what it is stands for it. */
  requests: Record<string, string[][]>
}

/** What's said of how long ago a turn was cut differs by the moment it's read: the words around it are what's compared. */
const withoutTimes = (text: string) => text.replace(/\d+(?:\.\d+)?\s*(?:ms|s|seconds?|minutes?|m)\b/g, "…")

/**
 * Each conversation `resume` and `continueRestarted` read in whole from its journal while `run` runs: those not in
 * memory as they were asked for.
 */
async function readWhole(run: () => Promise<void>): Promise<string[]> {
  let resuming = false
  const whole: string[] = []
  const during = <Self, Args extends unknown[], Result>(original: (this: Self, ...args: Args) => Result) => function (this: Self, ...args: Args): Result {
    resuming = true
    try {
      return original.apply(this, args)
    } finally {
      resuming = false
    }
  }
  const load = LiveRecords.prototype.load
  const mocks = [
    mock.method(Agents.prototype, "resume", during(Agents.prototype.resume)),
    mock.method(LiveConversations.prototype, "continueRestarted", during(LiveConversations.prototype.continueRestarted)),
    mock.method(LiveRecords.prototype, "load", function (this: LiveRecords, id: string) {
      const cold = resuming && !this.has(id)
      const resident = load.call(this, id)
      if (cold && resident) whole.push(id)
      return resident
    }),
  ]
  try {
    await run()
  } finally {
    for (const each of mocks) each.mock.restore()
  }
  return whole
}

/** A fresh host on a copy of what the last one left, taking it up at once or in slices. */
async function takeUp(at: string, fins: ReadonlyMap<string, string>, inSlices: boolean): Promise<Taken> {
  const script: Script = () => "Done after the restart."
  let world: AgentsWorld | undefined
  let holdMs = 0
  const whole = await readWhole(async () => {
    holdMs = await longestHold(async () => {
      world = new AgentsWorld({ root: at, script, finLimit: () => FINS * 2, ...(inSlices && { resumeInSlices: true }) })
      await world.resumed
    })
  })
  assert.ok(world)
  if (inSlices) assert.deepEqual(whole, [], "resuming in slices reads nothing whole")
  else assert.ok(whole.length >= FINS, `resuming at once reads every Fin whole: ${whole.length}`)
  await world.settle()
  const sent: Record<string, string[]> = {}
  const requests: Record<string, string[][]> = {}
  for (const [name, conversation] of fins) {
    sent[name] = world.prompts.filter((prompt) => prompt.conversation === conversation).map((prompt) => withoutTimes(prompt.text))
    requests[name] = (world.live.snapshot(conversation)?.requests ?? []).map((request) => [request.status, request.actor?.kind ?? "person", String(request.continues?.auto ?? false), withoutTimes(request.text)])
  }
  await world.close()
  return { holdMs, sent, requests }
}

/**
 * A settled Apex, and its Fin's report kept but not yet heard when the host died: the next host sends it again, and
 * reads the Apex's queue for its receipt. The Apex left nothing unsettled, and is read in first all the same.
 */
async function unheardReport(): Promise<void> {
  const at = join(root, "unheard")
  const world = new AgentsWorld({ root: at, script: () => "Done." })
  const apex = await world.apex("codex")
  const fin = await world.agents.start(apex.caller, { harness: "claude", brief: { objective: "Work" }, name: "worker", clientKey: "worker", cwd: at })
  assert.ok(!("refused" in fin) && fin.child, JSON.stringify(fin))
  await world.settle()
  assert.equal(world.live.leftUnsettled(apex.conversation), false, "the Apex left nothing unsettled")
  const child = ThreadIdSchema.parse(fin.child)
  world.store.keepReport({ id: `report:${randomUUID()}`, child, status: "blocked", summary: "Unheard as the host died.", question: "What next?", ownerGeneration: world.store.reportsOf(child, 0).at(-1)?.ownerGeneration ?? 1, at: Date.now() })
  assert.ok(world.store.undeliveredReports().length > 0, "the report waits to be heard")
  await world.close()
  let next: AgentsWorld | undefined
  const whole = await readWhole(async () => {
    next = new AgentsWorld({ root: at, script: () => "Heard.", resumeInSlices: true })
    await next.resumed
  })
  assert.ok(next)
  await next.settle()
  assert.deepEqual(whole, [], "the Apex the unheard report goes to was read in first")
  assert.equal(next.store.undeliveredReports().length, 0, "and it heard the report")
  await next.close()
  console.log("an unheard report's settled Apex: read in first")
}

try {
  await unheardReport()
  const left = join(root, "left")
  const { fins } = await leftByTheLastHost(left)
  cpSync(left, join(root, "at-once"), { recursive: true })
  cpSync(left, join(root, "in-slices"), { recursive: true })
  const atOnce = await takeUp(join(root, "at-once"), fins, false)
  const inSlices = await takeUp(join(root, "in-slices"), fins, true)

  assert.deepEqual(inSlices.requests, atOnce.requests, "every Fin's requests stand as they did when resumed at once")
  assert.deepEqual(inSlices.sent, atOnce.sent, "every Fin was sent what it was when resumed at once")
  const continued = Object.values(atOnce.sent).filter((prompts) => prompts.length > 0).length
  assert.ok(continued >= FINS / 2, `the Fins the exit cut went on: ${continued} of ${FINS} were sent a message`)
  const limit = atOnce.holdMs / TIMES
  console.log(`resumed ${FINS} Fins, ${continued} sent on: at once the loop held ${Math.round(atOnce.holdMs)} ms, in slices ${Math.round(inSlices.holdMs)} ms (limit ${Math.round(limit)} ms, a ${TIMES}th of at once)`)
  assert.ok(inSlices.holdMs < limit, `resuming in slices held the loop ${Math.round(inSlices.holdMs)} ms, not under ${Math.round(limit)} ms, a ${TIMES}th of the ${Math.round(atOnce.holdMs)} ms at once`)
  console.log("resume holds: ok")
} catch (error) {
  console.error(error)
  process.exitCode = 1
}

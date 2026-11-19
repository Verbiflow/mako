import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { cpSync, rmSync } from "node:fs"
import { join } from "node:path"
import { mock } from "node:test"
import { closedFinished, type ThreadParent } from "@mako/host/contracts/agents"
import { SessionIdSchema, ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import type { Entry } from "@mako/sessions/entries"
import { Agents, FINISHED_CLOSE_MS } from "@mako/host/conversations/agents"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { LiveRecords } from "@mako/host/conversations/live-records"
import { AgentsWorld, type Script } from "./lib/agents-world.ts"
import { testScratch } from "./lib/test-scratch.mjs"
import { longestHold, type LoopHold } from "./lib/loop-hold.ts"

/**
 * A host starting takes up what the last one left without holding its loop (`npm run test:resume-holds`).
 *
 * On 2026-11-07 the person's host held its loop for 4.8 s as it started: resuming Fins (`Agents.resume`) read every
 * open Fin's journal whole (`LiveJournal.read`), one after another, inside the core domain's load. Now the host reads
 * each of them in first a slice at a time (`Agents.resumeInSlices`, `LiveConversations.continueRestartedInSlices`),
 * then resumes as before.
 *
 * Eight Fins work under an Apex, half cut mid-turn by Mako's exit and half finished, their journals grown to a long
 * day's. Three interleaved pairs of fresh hosts take up copies of that same left state, at once and in slices.
 * The median of the paired ratios of the CPU each spent in its busiest gap must stay under a quarter (`TIMES`): a
 * runner that preempts the process stretches a gap's wall time with no work in it, and a synchronous stretch of the
 * resume's own shows as CPU. The sliced resume's longest gap by the clock is held to a loose bound (`SLICED_WALL_MS`). Every pair must resume exactly the same: the same messages sent on, the same
 * turns continued, every Fin's requests in the same states. Every raw timing and the paired median are printed.
 *
 * And nothing the resume reads is read whole: every conversation it reads in from its journal (`LiveRecords.load` of
 * one not in memory) must have been read in first. A settled Apex whose Fin's report was kept but not yet heard when
 * the host died is read as the report is sent again (its queue is the receipt), so it's read in first too.
 *
 * A host told to stop while it reads them ends at its next step: under a `TIMES`th of the whole sliced resume's time
 * (the yardstick, in this run), resuming nothing, and the next host takes it all up as if it hadn't started.
 *
 * And a tree whose Fins all finished and were closed for it (`Agents.closeFinished`) costs a start nothing: none of
 * their journals is read in, sliced or whole, nor their Apex's, nor the Apex's of a harness's own reviewer runs. On
 * 2026-11-17 the person's host read 107 journals, 608 MB, at every start, 98 of them of Fins long done.
 */
const FINS = 8
/** Blocks added to each Fin's journal, and their size: about 18 MB a journal. */
const BLOCKS = 12_000
const BLOCK_CHARS = 1_500
/** How many times shorter than the hold at once the longest hold in slices must be. */
const TIMES = 4
const SAMPLES = 3
/**
 * The sliced resume's longest gap by the clock, its median over the samples: a sanity bound loose enough for a
 * preempted runner (gaps of about a second seen there), well under what reading every journal at once would hold.
 */
const SLICED_WALL_MS = 3_000

function median(samples: readonly number[]): number {
  assert.equal(samples.length, SAMPLES)
  assert.ok(samples.every(sample => Number.isFinite(sample) && sample >= 0))
  return [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!
}

const root = testScratch("mako-resume-holds-")
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, done: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(10)
  }
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
  /** The longest gap's wall time: a sanity bound only, since a preempted runner stretches it with no work in it. */
  holdMs: number
  /** The CPU the loop's thread used in its busiest gap: what a synchronous stretch of the resume's own work shows as. */
  holdCpuMs: number
  gap: LoopHold
  constructedMs: number
  /** From the host's opening to its resume settling. */
  resumeMs: number
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
  let gap: LoopHold = { ms: 0, fromMs: 0, toMs: 0, cpuMs: 0, busiest: { ms: 0, fromMs: 0, toMs: 0, cpuMs: 0 } }
  let constructedMs = 0
  let resumeMs = 0
  const whole = await readWhole(async () => {
    gap = await longestHold(async () => {
      const opened = performance.now()
      world = new AgentsWorld({ root: at, script, finLimit: () => FINS * 2, ...(inSlices && { resumeInSlices: true }) })
      constructedMs = performance.now() - opened
      await world.resumed
      resumeMs = performance.now() - opened
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
  return { holdMs: gap.ms, holdCpuMs: gap.busiest.cpuMs, gap, constructedMs, resumeMs, sent, requests }
}

/**
 * A host told to stop as it reads what the last one left in slices: it ends at its next step and resumes nothing. The
 * next host, on the same folder, takes it all up as `expected` was.
 */
async function stopMidRead(at: string, fins: ReadonlyMap<string, string>, expected: Taken, yardstickMs: number): Promise<void> {
  let stop = false
  const world = new AgentsWorld({ root: at, script: () => "Done after the restart.", finLimit: () => FINS * 2, resumeInSlices: true, stopping: () => stop })
  // A slice in: the first journal is being read.
  await new Promise((resolve) => setImmediate(resolve))
  stop = true
  const stopped = performance.now()
  await world.resumed
  const stopMs = performance.now() - stopped
  assert.equal(world.prompts.length, 0, "a host stopped as it read resumed nothing")
  await world.close()
  const limit = yardstickMs / TIMES
  console.log(`stopped as it read: ended in ${Math.round(stopMs)} ms (limit ${Math.round(limit)} ms, a ${TIMES}th of the ${Math.round(yardstickMs)} ms the whole sliced resume took)`)
  assert.ok(stopMs < limit, `a stop as it read took ${Math.round(stopMs)} ms to end, not under ${Math.round(limit)} ms`)
  const next = await takeUp(at, fins, true)
  assert.deepEqual(next.requests, expected.requests, "the next host takes it up: every Fin's requests as when resumed at once")
  assert.deepEqual(next.sent, expected.sent, "and every Fin is sent what it was")
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

/**
 * An Apex whose `CLOSED_FINS` Fins all finished and closed, and another that only ever held its harness's own reviewer
 * runs: the next host, starting at once or in slices, reads none of their journals in.
 */
const CLOSED_FINS = 12
async function closedFinsUnread(): Promise<void> {
  const at = join(root, "closed")
  let offset = 0
  const world = new AgentsWorld({ root: at, script: (turn) => (turn.text.includes("You're fin:") ? "Finished." : "ok"), finLimit: () => CLOSED_FINS * 2, now: () => Date.now() + offset })
  const apex = await world.apex("claude", "full")
  const journals = new Set<string>([apex.conversation])
  for (let index = 0; index < CLOSED_FINS; index++) {
    const started = await world.agents.start(apex.caller, { brief: { objective: `Work c${index}` }, harness: "claude", name: `c${index}`, clientKey: `c${index}`, cwd: at })
    assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
    journals.add(started.conversation)
  }
  await world.settle()
  // Another Apex, which only ever held reviewer runs of its harness's own: closed as they were known for it.
  const reviewed = await world.apex("codex", "full")
  journals.add(reviewed.conversation)
  await world.settle()
  const session = SessionIdSchema.parse(world.store.journalPlacement(reviewed.conversation)!.session)
  const thread = ThreadIdSchema.parse(world.store.journalPlacement(reviewed.conversation)!.thread)
  for (let index = 0; index < 3; index++) {
    const placed = world.store.place({ harness: "codex", nativeId: `review-${index}`, path: join(at, `review-${index}.jsonl`) }, { kind: "service", name: "catalog" })
    const review: ThreadParent = {
      child: ThreadIdSchema.parse(placed.thread), parent: thread, parentSession: session, name: `review-${index}`, role: "worker", origin: "discovered",
      asked: { brief: { objective: "Review" } }, op: `discovered:review-${index}`, startedBy: { kind: "agent", session }, createdAt: Date.now(),
      run: { harness: "codex", nativeId: `review-${index}`, device: world.store.deviceId, startedAt: Date.now(), ended: { at: Date.now(), kind: "done" }, nativeAgent: { kind: "internal-review", role: "guardian", source: "guardian_review" } },
    }
    world.store.keepEdge(review)
  }
  assert.equal(world.store.edges().internalRuns.filter((edge) => edge.closedAt !== undefined).length, 3, "reviewer runs' edges are closed")
  offset = FINISHED_CLOSE_MS + 60_000
  const closed = await world.agents.closeFinished()
  assert.equal(closed.length, CLOSED_FINS, `every finished Fin closed: ${closed.length}`)
  assert.ok(world.store.edges().all.every((edge) => closedFinished(edge)))
  await world.close()
  for (const inSlices of [true, false]) {
    const read: string[] = []
    const load = LiveRecords.prototype.load
    const loadSliced = LiveRecords.prototype.loadSliced
    const mocks = [
      mock.method(LiveRecords.prototype, "load", function (this: LiveRecords, id: string) {
        if (!this.has(id)) read.push(id)
        return load.call(this, id)
      }),
      mock.method(LiveRecords.prototype, "loadSliced", function (this: LiveRecords, id: string) {
        if (!this.has(id)) read.push(id)
        return loadSliced.call(this, id)
      }),
    ]
    let next: AgentsWorld | undefined
    try {
      next = new AgentsWorld({ root: at, script: () => "ok", finLimit: () => CLOSED_FINS * 2, now: () => Date.now() + offset, ...(inSlices && { resumeInSlices: true }) })
      await next.resumed
      await next.settle()
      // The pass a starting host makes over finished Fins finds them closed, and reads nothing either.
      assert.deepEqual(await next.agents.closeFinished(), [])
    } finally {
      for (const each of mocks) each.mock.restore()
    }
    assert.deepEqual(read.filter((id) => journals.has(id)), [], `a start ${inSlices ? "in slices" : "at once"} reads no journal of a closed tree`)
    assert.equal(next.prompts.length, 0, "and sends nothing")
    await next.close()
  }
  console.log(`${CLOSED_FINS} finished and closed Fins, and an Apex of reviewer runs: a start read none of their journals`)
}

try {
  await unheardReport()
  await closedFinsUnread()
  const left = join(root, "left")
  const { fins } = await leftByTheLastHost(left)
  cpSync(left, join(root, "stopped"), { recursive: true })
  const readings: { atOnce: Taken; inSlices: Taken }[] = []
  for (let sample = 0; sample < SAMPLES; sample++) {
    const pair = join(root, `pair-${sample}`)
    const whole = join(pair, "at-once"), sliced = join(pair, "in-slices")
    cpSync(left, whole, { recursive: true })
    cpSync(left, sliced, { recursive: true })
    // Alternate which host resumes first; every invocation starts from the identical original state.
    const first = sample % 2 ? await takeUp(sliced, fins, true) : await takeUp(whole, fins, false)
    const second = sample % 2 ? await takeUp(whole, fins, false) : await takeUp(sliced, fins, true)
    const atOnce = sample % 2 ? second : first
    const inSlices = sample % 2 ? first : second
    assert.deepEqual(inSlices.requests, atOnce.requests, "every Fin's requests stand as they did when resumed at once")
    assert.deepEqual(inSlices.sent, atOnce.sent, "every Fin was sent what it was when resumed at once")
    if (readings.length) {
      assert.deepEqual(atOnce.requests, readings[0]!.atOnce.requests, "each pair takes up the same saved requests")
      assert.deepEqual(atOnce.sent, readings[0]!.atOnce.sent, "each pair sends the same saved messages")
    }
    const continued = Object.values(atOnce.sent).filter((prompts) => prompts.length > 0).length
    assert.ok(continued >= FINS / 2, `the Fins the exit cut went on: ${continued} of ${FINS} were sent a message`)
    console.log("resume timing: " + JSON.stringify({ sample, atOnce: { gap: atOnce.gap, constructedMs: atOnce.constructedMs, resumeMs: atOnce.resumeMs }, inSlices: { gap: inSlices.gap, constructedMs: inSlices.constructedMs, resumeMs: inSlices.resumeMs } }))
    readings.push({ atOnce, inSlices })
    // takeUp joined both owners' shutdown before their private copies are removed.
    rmSync(pair, { recursive: true, force: true })
  }
  // Judged by the CPU of each resume's busiest gap: on 2026-11-16 a preempted runner's sliced resume had gaps of 978 and
  // 667 ms wall with 39 and 12 ms CPU in them, and failed main by wall time though it held the loop for no work.
  const ratio = median(readings.map(({ atOnce, inSlices }) => inSlices.holdCpuMs / atOnce.holdCpuMs))
  const wall = median(readings.map(each => each.inSlices.holdMs))
  console.log(`resumed ${FINS} Fins: busiest-hold CPU medians ${Math.round(median(readings.map(each => each.atOnce.holdCpuMs)))} / ${Math.round(median(readings.map(each => each.inSlices.holdCpuMs)))} ms; paired median ${(ratio * 100).toFixed(1)}% (under ${100 / TIMES}%); longest-hold wall medians ${Math.round(median(readings.map(each => each.atOnce.holdMs)))} / ${Math.round(wall)} ms (under ${SLICED_WALL_MS})`)
  assert.ok(ratio < 1 / TIMES, `resuming in slices held the loop's CPU a paired median ${(ratio * 100).toFixed(1)}% of at once, not under ${100 / TIMES}%`)
  assert.ok(wall < SLICED_WALL_MS, `resuming in slices held the loop a median ${Math.round(wall)} ms by the clock, not under ${SLICED_WALL_MS} ms`)
  await stopMidRead(join(root, "stopped"), fins, readings[0]!.atOnce, median(readings.map(each => each.inSlices.resumeMs)))
  console.log("resume holds: ok")
} catch (error) {
  console.error(error)
  process.exitCode = 1
}

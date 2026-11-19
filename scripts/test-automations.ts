import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { z } from "zod"
import type { JsonValue } from "@mako/host/contracts/json"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentAskGate } from "@mako/host/conversations/agent-ask-gate"
import { AutomationTool } from "@mako/host/conversations/automation-tool"
import { agentAskWords, personOnlyAsk, type AgentAsk } from "@mako/host/contracts/agent-asks"
import { instantOf, nextCron, parseCron } from "@mako/host/contracts/automation-cron"
import { AUTOMATION_PROPOSAL_TTL_MS, automationClientKey, automationDiff, branchFor, scheduleOccurrence, type AutomationDefinitionInput, type AutomationRun } from "@mako/host/contracts/automations"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { parseAutomationFile } from "@mako/host/workspaces/automation-file"
import { AutomationStore } from "@mako/host/workspaces/automation-store"
import { Automations, AutomationNotStartedError, gateContext, type AutomationLaunch, type AutomationThreadReading, type GateOutcome } from "@mako/host/workspaces/automations"

/**
 * Automations on the host's own service, with every outside thing faked: the clock, the Thread a run starts
 * (`startThread`), how it stands (`threadOf`), the gate's command, HEAD, the runWhen model and the asks.
 * `npm run test:automations`.
 */

const scratch = await mkdtemp(join(tmpdir(), "mako-automations-"))
const DiffSchema = z.array(z.object({ field: z.string() }).loose())
const MINUTE = 60_000
const HOUR = 60 * MINUTE
let passed = 0
async function test(name: string, run: () => Promise<void> | void) {
  await run()
  passed += 1
  console.log(`ok ${name}`)
}

/* ------------------------------------------------------------------ cron */

const utc = (text: string) => Date.parse(text)
const iso = (at: number | undefined) => (at === undefined ? "none" : new Date(at).toISOString())
function next(cron: string, zone: string, after: string): string {
  const parsed = parseCron(cron)
  assert.ok(parsed.ok, cron)
  return iso(nextCron(parsed.spec, zone, utc(after)))
}

await test("cron: fields, lists, ranges, steps, names", () => {
  assert.equal(next("17 6 * * *", "UTC", "2026-11-19T06:00:00Z"), "2026-11-19T06:17:00.000Z")
  assert.equal(next("17 6 * * *", "UTC", "2026-11-19T06:17:00Z"), "2026-11-20T06:17:00.000Z", "strictly after")
  assert.equal(next("*/15 * * * *", "UTC", "2026-11-19T06:16:30Z"), "2026-11-19T06:30:00.000Z")
  assert.equal(next("10-50/20 9 * * *", "UTC", "2026-11-19T09:31:00Z"), "2026-11-19T09:50:00.000Z")
  assert.equal(next("0 9 * * mon-fri", "UTC", "2026-11-21T00:00:00Z"), "2026-11-23T09:00:00.000Z", "Saturday to Monday")
  assert.equal(next("0 0 * jan sun", "UTC", "2026-11-19T00:00:00Z"), "2027-01-03T00:00:00.000Z")
  assert.equal(next("0 0 * * 7", "UTC", "2026-11-19T00:00:00Z"), "2026-11-22T00:00:00.000Z", "7 is Sunday")
  assert.equal(next("@daily", "UTC", "2026-11-19T12:00:00Z"), "2026-11-20T00:00:00.000Z")
  // Day of month and weekday both restricted match either.
  assert.equal(next("0 9 1 * mon", "UTC", "2026-11-24T10:00:00Z"), "2026-11-30T09:00:00.000Z")
  assert.equal(next("0 9 1 * mon", "UTC", "2026-11-30T10:00:00Z"), "2026-12-01T09:00:00.000Z")
  for (const bad of ["* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "5-1 * * * *", "*/0 * * * *", "a b c d e"]) assert.equal(parseCron(bad).ok, false, bad)
})

await test("cron: month ends and leap days", () => {
  assert.equal(next("0 0 31 * *", "UTC", "2026-04-01T00:00:00Z"), "2026-05-31T00:00:00.000Z", "April has no 31st")
  assert.equal(next("0 0 30 * *", "UTC", "2026-02-01T00:00:00Z"), "2026-03-30T00:00:00.000Z", "February has no 30th")
  assert.equal(next("0 0 29 2 *", "UTC", "2026-03-01T00:00:00Z"), "2028-02-29T00:00:00.000Z", "the next leap year")
  assert.equal(next("59 23 31 12 *", "UTC", "2026-12-31T23:59:00Z"), "2027-12-31T23:59:00.000Z", "over the year's end")
})

await test("cron: timezones and daylight saving", () => {
  assert.equal(next("17 6 * * *", "America/New_York", "2026-11-19T00:00:00Z"), "2026-11-19T11:17:00.000Z", "EST is UTC-5")
  assert.equal(next("17 6 * * *", "America/New_York", "2026-07-19T00:00:00Z"), "2026-07-19T10:17:00.000Z", "EDT is UTC-4")
  // Spring forward: 02:30 doesn't exist on 2026-03-08 in New York; it runs at the first minute after the jump, once.
  assert.equal(next("30 2 * * *", "America/New_York", "2026-03-08T05:00:00Z"), "2026-03-08T07:00:00.000Z")
  assert.equal(next("30 2 * * *", "America/New_York", "2026-03-08T07:00:00Z"), "2026-03-09T06:30:00.000Z")
  // Fall back: 01:30 happens twice on 2026-11-01; it runs at the first, and not again at the second.
  assert.equal(next("30 1 * * *", "America/New_York", "2026-11-01T04:00:00Z"), "2026-11-01T05:30:00.000Z")
  assert.equal(next("30 1 * * *", "America/New_York", "2026-11-01T05:30:00Z"), "2026-11-02T06:30:00.000Z")
  assert.equal(next("0 * * * *", "Europe/London", "2026-03-29T00:30:00Z"), "2026-03-29T01:00:00.000Z", "an hourly schedule over the jump")
  assert.equal(next("45 5 * * *", "Asia/Kolkata", "2026-11-19T00:00:00Z"), "2026-11-19T00:15:00.000Z", "a half-hour offset")
  assert.equal(instantOf({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, "America/New_York"), utc("2026-11-01T05:30:00Z"))
})

await test("occurrences, branches and the gate's output", () => {
  assert.equal(scheduleOccurrence(utc("2026-11-19T06:17:00Z")), "2026-11-19T06:17Z")
  assert.equal(automationClientKey("harness-version-bump", "2026-11-19T06:17Z"), "automation:harness-version-bump:2026-11-19T06:17Z")
  assert.equal(branchFor("harness-versions/{date}", { id: "x", occurrence: "o", at: utc("2026-11-19T06:17:00Z") }), "harness-versions/2026-11-19")
  assert.equal(branchFor("nightly/{date}-{time}", { id: "x", occurrence: "o", at: utc("2026-11-19T23:30:00Z"), timezone: "Asia/Kolkata" }), "nightly/2026-11-20-0500")
  assert.deepEqual(gateContext('{"key":"claude@2.1","bumps":[1]}'), { key: "claude@2.1", context: { key: "claude@2.1", bumps: [1] } })
  assert.equal(gateContext("not json"), undefined)
})

/* ------------------------------------------------------------------ the world */

interface World {
  automations: Automations
  tool: AutomationTool
  starts: AutomationLaunch[]
  threads: Map<string, AutomationThreadReading>
  stopped: string[]
  told: { conversation: string; request: string; text: string }[]
  events: HostEvent[]
  asks: Map<string, AgentAsk[]>
  gate: AgentAskGate
  heads: Map<string, string>
  setGate(outcome: (project: string) => GateOutcome): void
  setJudge(verdict: { run: boolean; why: string } | { unavailable: string }): void
  failStart(error: Error | undefined): void
  clock: { now: number }
  open: string[]
}

function makeWorld(state: string, open: string[], clock = { now: utc("2026-11-19T06:00:00Z") }, legacyLaunches?: string): World {
  const starts: AutomationLaunch[] = []
  const threads = new Map<string, AutomationThreadReading>()
  const stopped: string[] = []
  const told: World["told"] = []
  const events: HostEvent[] = []
  const asks = new Map<string, AgentAsk[]>()
  const heads = new Map<string, string>()
  let gateOutcome: (project: string) => GateOutcome = () => ({ exit: 0, stdout: "", stderr: "" })
  let judge: { run: boolean; why: string } | { unavailable: string } = { run: true, why: "yes" }
  let startError: Error | undefined
  const liveAsks = {
    open: (id: string) => asks.get(id) ?? [],
    raise: (id: string, ask: AgentAsk) => void asks.set(id, [...(asks.get(id) ?? []), ask]),
    settle: (id: string, ask: string) => {
      const found = asks.get(id)?.find((each) => each.id === ask)
      asks.set(id, (asks.get(id) ?? []).filter((each) => each.id !== ask))
      return found
    },
  }
  const gate = new AgentAskGate(liveAsks)
  const automations = new Automations({
    store: new AutomationStore(state),
    scheduler: { start: () => () => {} },
    emit: (event) => void events.push(event),
    openProjects: () => open,
    startThread: async (launch) => {
      if (startError) throw startError
      starts.push(launch)
      if (!threads.has(launch.conversationId)) threads.set(launch.conversationId, { state: "working" })
      return {}
    },
    threadOf: (conversation) => threads.get(conversation) ?? { state: "unknown" },
    stopThread: async (conversation) => void stopped.push(conversation),
    runGate: async (project) => gateOutcome(project),
    head: async (project) => (heads.get(project) ? { head: heads.get(project)!, branch: "main", subject: "A commit" } : undefined),
    runWhen: { judge: async () => judge },
    tell: async (conversation, request, text) => void told.push({ conversation, request, text }),
    asks: { raise: (conversation, want) => gate.ask(conversation, want).id, settle: (conversation, ask) => void liveAsks.settle(conversation, ask) },
    now: () => clock.now,
    ...(legacyLaunches && { legacyLaunches }),
  })
  const tool = new AutomationTool({ conversationOf: (session) => session, tier: () => "auto", folderOf: () => open[0], automations: () => automations, gate })
  gate.runs = { automation: (id, want, ask) => tool.allowed(id, want, ask), "automation-proposal": async (_id, want) => tool.proposalAllowed(want) }
  gate.declined = async (_id, want) => {
    if (want.kind === "automation-proposal") await tool.proposalDeclined(want)
  }
  return {
    automations, tool, starts, threads, stopped, told, events, asks, gate, heads, clock, open,
    setGate: (outcome) => void (gateOutcome = outcome),
    setJudge: (verdict) => void (judge = verdict),
    failStart: (error) => void (startError = error),
  }
}

let projects = 0
async function project(definitions: AutomationDefinitionInput[]): Promise<string> {
  projects += 1
  const folder = join(scratch, `project-${projects}`)
  await mkdir(join(folder, ".mako"), { recursive: true })
  await writeFile(join(folder, ".mako", "automations.json"), JSON.stringify({ version: 2, automations: definitions }))
  return folder
}

const brief = { objective: "Do the thing." }
const runsOf = (world: World, folder: string, id: string) => world.automations.runs(folder, id)
const statuses = (world: World, folder: string, id: string) => runsOf(world, folder, id).map((run) => run.status).reverse()
const end = (world: World, run: AutomationRun | undefined, status: "done" | "failed", summary = "Finished.") => {
  assert.ok(run?.thread)
  world.threads.set(run.thread.conversation, { state: "ended", status, summary })
  return world.automations.turnEnded(run.thread.conversation)
}

/* ------------------------------------------------------------------ legacy */

await test("legacy reading: the first shape reads as the new one; what can't fire is kept as unsupported", async () => {
  const read = parseAutomationFile(JSON.stringify({ automations: [
    { id: "Typecheck-On-Change", name: "Typecheck", prompt: "Run npm run typecheck", trigger: "files", paths: ["src/**/*.ts"] },
    { id: "summary", name: "Summarise", prompt: "Summarise the commit", trigger: "commit" },
    { id: "by-hand", name: "By hand", prompt: "Do it", trigger: { kind: "manual" } },
    { id: "slack", name: "Slack", prompt: "Triage", trigger: { kind: "slack", event: "reaction_added", channels: ["C1"] } },
    { id: "nothing", name: "No prompt", trigger: "manual" },
  ] }))
  assert.equal(read.legacy, true)
  assert.deepEqual(read.definitions.map((each) => [each.id, each.triggers[0]?.kind]), [["typecheck-on-change", "unsupported"], ["summary", "commit"], ["by-hand", "manual"], ["slack", "unsupported"]])
  const files = read.definitions[0]!
  assert.deepEqual(files.prompt, { objective: "Run npm run typecheck" })
  assert.deepEqual(files.start, { access: "edits", place: "here", whenAway: "queue" }, "default start settings")
  assert.deepEqual(files.triggers[0], { kind: "unsupported", raw: { kind: "files", paths: ["src/**/*.ts"] }, why: "file-change triggers are gone: they ran an agent in your checkout on every save" })
  assert.deepEqual(read.skipped, ["nothing has no prompt"], "an entry that can't be read is kept, and said")
  // The writer writes the new shape, with an unknown trigger kept word for word.
  const folder = join(scratch, "legacy")
  await mkdir(join(folder, ".mako"), { recursive: true })
  await writeFile(join(folder, ".mako", "automations.json"), JSON.stringify({ automations: [{ id: "slack", name: "Slack", prompt: "Triage", trigger: { kind: "slack", event: "reaction_added" } }, { id: "x", trigger: "manual" }] }))
  const world = makeWorld(join(scratch, "legacy-state"), [folder])
  assert.equal((await world.automations.reading(folder)).file.legacy, true)
  await world.automations.save(folder, { id: "added", name: "Added", prompt: { objective: "New" } })
  const written = JSON.parse(await readFile(join(folder, ".mako", "automations.json"), "utf8"))
  assert.equal(written.version, 2)
  assert.deepEqual(written.automations.map((each: { id: string }) => each.id), ["slack", "added", "x"], "unreadable entries stay, after the rest")
  assert.deepEqual(written.automations[0].triggers, [{ kind: "slack", event: "reaction_added" }], "the unsupported trigger goes back as it was written")
  assert.equal(parseAutomationFile(JSON.stringify(written)).definitions[0]?.triggers[0]?.kind, "unsupported", "and reads back the same")
  assert.equal(enabledCount(await world.automations.reading(folder)), 0, "nothing from a file arrives on")
})

/** An older build's approved launches are read once, as runs, so none runs again. */
await test("legacy launches: <dataRoot>/automation-launches is read once, as runs", async () => {
  const folder = await project([{ id: "one", name: "One", prompt: brief }])
  const launches = join(scratch, "automation-launches")
  await mkdir(launches, { recursive: true })
  const operation = JSON.stringify(["conv-old", "ask-old"])
  await writeFile(join(launches, `${createHash("sha256").update(operation).digest("hex")}.json`), JSON.stringify({ cwd: folder, id: "one", result: { status: "completed" } }))
  const world = makeWorld(join(scratch, "legacy-launch-state"), [folder], undefined, launches)
  await world.automations.start()
  assert.deepEqual(statuses(world, folder, "one"), ["completed"])
  assert.equal(await world.automations.legacyLaunched(operation), true, "its approval never launches again")
  assert.equal(await world.automations.legacyLaunched(JSON.stringify(["conv-old", "other"])), false)
})

function enabledCount(reading: Awaited<ReturnType<Automations["reading"]>>): number {
  return reading.automations.filter((each) => each.local.enabled).length
}

/* ------------------------------------------------------------------ behaviour */

await test("persistence across a host restart: on, next run and run records", async () => {
  const folder = await project([{ id: "nightly", name: "Nightly", prompt: brief, triggers: [{ kind: "schedule", cron: "0 3 * * *" }] }])
  const state = join(scratch, "restart-state")
  const first = makeWorld(state, [folder])
  await first.automations.setEnabled(folder, "nightly", true)
  await first.automations.runNow(folder, "nightly", "k1")
  first.automations.stop()
  // A new host on the same data root, with no window open on the project.
  const second = makeWorld(state, [])
  const reading = await second.automations.read()
  const view = reading.projects.find((each) => each.project === folder)?.automations[0]
  assert.equal(view?.local.enabled, true, "still on")
  assert.equal(iso(view?.local.nextRunAt), "2026-11-20T03:00:00.000Z", "its next run kept")
  assert.deepEqual(statuses(second, folder, "nightly"), ["fired"], "its run kept")
  assert.equal(view?.standing, "running")
})

await test("every served project fires, not only the one in front", async () => {
  const every = [{ id: "five", name: "Every five", prompt: brief, triggers: [{ kind: "schedule" as const, cron: "*/5 * * * *" }] }]
  const front = await project(every)
  const behind = await project(every)
  const off = await project(every)
  const world = makeWorld(join(scratch, "every-state"), [front, behind, off])
  await world.automations.setEnabled(front, "five", true)
  await world.automations.setEnabled(behind, "five", true)
  // `behind`'s window closed: it's still served, since it has one on.
  world.open.splice(0, world.open.length, front, off)
  world.clock.now += 5 * MINUTE
  await world.automations.tick(world.clock.now)
  assert.deepEqual(statuses(world, front, "five"), ["fired"])
  assert.deepEqual(statuses(world, behind, "five"), ["fired"], "a project not in front fires")
  assert.deepEqual(statuses(world, off, "five"), [], "one that's off doesn't")
  assert.equal(runsOf(world, front, "five")[0]?.occurrence, "2026-11-19T06:05Z")
  assert.equal(runsOf(world, front, "five")[0]?.cause.kind, "schedule")
  world.clock.now += 30_000
  await world.automations.tick(world.clock.now)
  assert.equal(runsOf(world, front, "five").length, 1, "the next tick in the same slot fires nothing more")
})

await test("a run starts as agents_start would: brief, client key, branch, place, one Thread per occurrence", async () => {
  const folder = await project([{ id: "bump", name: "Bump", prompt: { objective: "Bump it.", doneWhen: ["Checks pass."], boundaries: ["Don't merge."], output: "The PR." }, start: { harness: "claude", model: "claude-opus-5-5", access: "full", place: "cloud", workspace: { branch: "harness-versions/{date}" } }, triggers: [{ kind: "schedule", cron: "17 6 * * *" }], result: "pull-request" }])
  const world = makeWorld(join(scratch, "start-state"), [folder])
  await world.automations.setEnabled(folder, "bump", true)
  world.clock.now = utc("2026-11-19T06:17:10Z")
  await world.automations.tick(world.clock.now)
  const launch = world.starts.at(-1)
  assert.ok(launch)
  assert.equal(launch.run.clientKey, "automation:bump:2026-11-19T06:17Z")
  assert.equal(launch.branch, "harness-versions/2026-11-19")
  assert.match(launch.text, /^Bump it\.\n\nDone when:\n- Checks pass\.\n\nBoundaries:\n- Don't merge\.\n\nOutput: The PR\./)
  assert.match(launch.text, /run 2026-11-19T06:17Z/)
  assert.equal(launch.run.thread?.place, "cloud")
  const again = makeWorld(join(scratch, "start-state-2"), [folder])
  const one = await again.automations.runNow(folder, "bump", "same")
  const two = await again.automations.runNow(folder, "bump", "same")
  assert.deepEqual(one, two, "Run now twice under one key is one run")
  assert.equal(again.starts.length, 1, "and one Thread")
})

await test("the gate: exit 1 skips, its key dedupes, its context reaches the brief, a failure counts", async () => {
  const folder = await project([{ id: "gated", name: "Gated", prompt: brief, triggers: [{ kind: "schedule", cron: "0 * * * *" }], gate: { command: "check", timeoutS: 30 } }])
  const world = makeWorld(join(scratch, "gate-state"), [folder])
  await world.automations.setEnabled(folder, "gated", true)
  const hour = async () => {
    world.clock.now += HOUR
    await world.automations.tick(world.clock.now)
    return runsOf(world, folder, "gated")[0]!
  }
  world.setGate(() => ({ exit: 1, stdout: "", stderr: "" }))
  assert.equal((await hour()).status, "gate-skipped")
  world.setGate(() => ({ exit: 0, stdout: JSON.stringify({ key: "claude@2.1.90", bumps: ["claude"] }), stderr: "" }))
  const ran = await hour()
  assert.equal(ran.status, "fired")
  assert.equal(ran.gate?.key, "claude@2.1.90")
  assert.match(world.starts.at(-1)!.text, /What its gate found:[\s\S]*"bumps"/)
  await end(world, ran, "done")
  const again = await hour()
  assert.equal(again.status, "gate-skipped", "the same key never runs twice")
  assert.match(again.why ?? "", /already ran for claude@2\.1\.90/)
  world.setGate(() => ({ exit: 0, stdout: JSON.stringify({ key: "claude@2.1.91" }), stderr: "" }))
  assert.equal((await hour()).status, "fired", "a new key runs")
  await end(world, runsOf(world, folder, "gated")[0], "failed", "Checks failed.")
  assert.equal((await hour()).status, "fired", "a key whose run failed may run again")
  await end(world, runsOf(world, folder, "gated")[0], "done")
  world.setGate(() => ({ exit: 2, stdout: "", stderr: "boom" }))
  const broken = await hour()
  assert.equal(broken.status, "failed-to-start")
  assert.match(broken.why ?? "", /exit 2: boom/)
})

await test("one active run: extras are skipped and merged, or queued with overlap: queue", async () => {
  const folder = await project([
    { id: "skip", name: "Skip", prompt: brief, triggers: [{ kind: "manual" }] },
    { id: "queue", name: "Queue", prompt: brief, triggers: [{ kind: "manual" }], limits: { overlap: "queue", timeoutMin: 60 } },
  ])
  const world = makeWorld(join(scratch, "overlap-state"), [folder])
  const first = await world.automations.runNow(folder, "skip", "a")
  const second = await world.automations.runNow(folder, "skip", "b")
  assert.ok("run" in first && "run" in second)
  assert.equal(second.run.status, "skipped")
  assert.equal(second.run.mergedInto, first.run.occurrence)
  // Two at once: the overlap check takes them one at a time.
  const [x, y] = await Promise.all([world.automations.runNow(folder, "queue", "x"), world.automations.runNow(folder, "queue", "y")])
  assert.ok("run" in x && "run" in y)
  assert.deepEqual([x.run.status, y.run.status].sort(), ["fired", "queued"])
  const fired = x.run.status === "fired" ? x.run : y.run
  const starts = world.starts.length
  await end(world, fired, "done")
  assert.equal(world.starts.length, starts + 1, "the queued run starts once the first ends")
  assert.deepEqual(statuses(world, folder, "queue").sort(), ["completed", "fired"])
})

await test("catch-up: one run for slots missed asleep or closed, within the grace window", async () => {
  const folder = await project([{ id: "hourly", name: "Hourly", prompt: brief, triggers: [{ kind: "schedule", cron: "0 * * * *" }] }])
  const state = join(scratch, "catchup-state")
  const clock = { now: utc("2026-11-19T06:30:00Z") }
  const before = makeWorld(state, [folder], clock)
  await before.automations.setEnabled(folder, "hourly", true)
  before.automations.stop()
  // Closed for three hours and a half: 07:00 to 10:00 were missed.
  clock.now = utc("2026-11-19T10:05:00Z")
  const after = makeWorld(state, [folder], clock)
  await after.automations.tick(clock.now)
  const runs = runsOf(after, folder, "hourly")
  assert.equal(runs.length, 1, "one catch-up, never one per missed slot")
  assert.equal(runs[0]?.occurrence, "2026-11-19T10:00Z", "the latest slot")
  assert.deepEqual(runs[0]?.cause, { kind: "schedule", at: utc("2026-11-19T10:00:00Z"), catchUp: true })
  // A daily slot missed beyond the window isn't run.
  const daily = await project([{ id: "daily", name: "Daily", prompt: brief, triggers: [{ kind: "schedule", cron: "0 3 * * *" }] }])
  const dailyClock = { now: utc("2026-11-19T04:00:00Z") }
  const d1 = makeWorld(join(scratch, "catchup-daily"), [daily], dailyClock)
  await d1.automations.setEnabled(daily, "daily", true)
  dailyClock.now = utc("2026-11-20T16:00:00Z")
  const d2 = makeWorld(join(scratch, "catchup-daily"), [daily], dailyClock)
  await d2.automations.tick(dailyClock.now)
  assert.equal(runsOf(d2, daily, "daily").length, 0, "03:00 was 13 hours ago, past the 12-hour grace")
  assert.equal(iso((await d2.automations.reading(daily)).automations[0]?.local.nextRunAt), "2026-11-21T03:00:00.000Z", "it goes on from now")
  // Off while slots passed: turning it on again runs nothing for them.
  await d2.automations.setEnabled(daily, "daily", false)
  dailyClock.now = utc("2026-11-22T05:00:00Z")
  await d2.automations.setEnabled(daily, "daily", true)
  await d2.automations.tick(dailyClock.now)
  assert.equal(runsOf(d2, daily, "daily").length, 0, "no catch-up behind the moment it was turned on")
})

await test("auto-pause after three failures in a row, with the reason; turning it on again clears it", async () => {
  const folder = await project([{ id: "flaky", name: "Flaky", prompt: brief, triggers: [{ kind: "schedule", cron: "0 * * * *" }] }])
  const world = makeWorld(join(scratch, "pause-state"), [folder])
  await world.automations.setEnabled(folder, "flaky", true)
  world.failStart(new AutomationNotStartedError("No provider is signed in."))
  for (let index = 0; index < 3; index++) {
    world.clock.now += HOUR
    await world.automations.tick(world.clock.now)
  }
  assert.deepEqual(statuses(world, folder, "flaky"), ["failed-to-start", "failed-to-start", "failed-to-start"])
  const view = (await world.automations.reading(folder)).automations[0]!
  assert.equal(view.standing, "paused")
  assert.equal(view.local.paused?.kind, "failures")
  assert.match(view.local.paused?.reason ?? "", /Paused after 3 failed runs in a row\. The last: Its Thread didn't start: No provider is signed in\./)
  world.clock.now += HOUR
  await world.automations.tick(world.clock.now)
  assert.equal(runsOf(world, folder, "flaky").length, 3, "a paused automation doesn't run")
  world.failStart(undefined)
  await world.automations.setEnabled(folder, "flaky", true)
  const cleared = (await world.automations.reading(folder)).automations[0]!
  assert.equal(cleared.local.paused, undefined)
  assert.equal(cleared.local.failures, 0)
  // A completed run between failures sets the count back.
  await world.automations.runNow(folder, "flaky", "f1")
  await end(world, runsOf(world, folder, "flaky")[0], "failed")
  await world.automations.runNow(folder, "flaky", "f2")
  await end(world, runsOf(world, folder, "flaky")[0], "failed")
  assert.equal((await world.automations.reading(folder)).automations[0]!.local.failures, 2)
  await world.automations.runNow(folder, "flaky", "ok")
  await end(world, runsOf(world, folder, "flaky")[0], "done")
  assert.equal((await world.automations.reading(folder)).automations[0]!.local.failures, 0)
})

await test("a run completes when its Thread's turn ends, with its result; a timeout fails it", async () => {
  const folder = await project([{ id: "report", name: "Report", prompt: brief, triggers: [{ kind: "manual" }], limits: { overlap: "skip", timeoutMin: 30 } }])
  const world = makeWorld(join(scratch, "complete-state"), [folder])
  const started = await world.automations.runNow(folder, "report", "r1")
  assert.ok("run" in started)
  assert.equal(started.run.status, "fired", "launched is not completed")
  await world.automations.turnEnded(started.run.thread!.conversation)
  assert.equal(runsOf(world, folder, "report")[0]?.status, "fired", "a Thread still at work doesn't settle it")
  await end(world, started.run, "done", "Opened https://github.com/acme/app/pull/12 with the fix.")
  const done = runsOf(world, folder, "report")[0]!
  assert.equal(done.status, "completed")
  assert.deepEqual(done.result, { status: "done", summary: "Opened https://github.com/acme/app/pull/12 with the fix.", pullRequest: "https://github.com/acme/app/pull/12" })
  // An ending nobody heard (a restart) is found by the tick.
  const unheard = await world.automations.runNow(folder, "report", "r2")
  assert.ok("run" in unheard)
  world.threads.set(unheard.run.thread!.conversation, { state: "ended", status: "failed", summary: "It broke." })
  await world.automations.tick(world.clock.now)
  assert.equal(runsOf(world, folder, "report")[0]?.status, "failed")
  const slow = await world.automations.runNow(folder, "report", "r3")
  assert.ok("run" in slow)
  world.clock.now += 31 * MINUTE
  await world.automations.tick(world.clock.now)
  assert.deepEqual(world.stopped, [slow.run.thread!.conversation], "its Thread is stopped")
  assert.equal(runsOf(world, folder, "report")[0]?.why, "Stopped after 30 minutes, its limit.")
})

await test("daily cap, commit trigger, runWhen, and a definition changed under it", async () => {
  const folder = await project([
    { id: "capped", name: "Capped", prompt: brief, triggers: [{ kind: "manual" }], limits: { overlap: "skip", timeoutMin: 60, maxRunsPerDay: 1 } },
    { id: "on-commit", name: "On commit", prompt: brief, triggers: [{ kind: "commit", runWhen: "Only for commits that touch docs." }] },
  ])
  const world = makeWorld(join(scratch, "misc-state"), [folder])
  const one = await world.automations.runNow(folder, "capped", "c1")
  assert.ok("run" in one)
  await end(world, one.run, "done")
  const two = await world.automations.runNow(folder, "capped", "c2")
  assert.ok("run" in two)
  assert.equal(two.run.status, "skipped")
  assert.match(two.run.why ?? "", /1 run in the last 24 hours, its limit/)
  await world.automations.setEnabled(folder, "on-commit", true)
  world.heads.set(folder, "aaa")
  await world.automations.tick(world.clock.now)
  assert.equal(runsOf(world, folder, "on-commit").length, 0, "the first HEAD seen is only remembered")
  world.setJudge({ run: false, why: "It changes only code." })
  await world.automations.noticeHead(folder, "bbb")
  const skipped = runsOf(world, folder, "on-commit")[0]
  assert.equal(skipped?.status, "skipped")
  assert.deepEqual(skipped?.runWhen, { verdict: "skip", reason: "It changes only code." })
  assert.equal(skipped?.why, "It changes only code.")
  world.setJudge({ run: true, why: "It touches docs/." })
  await world.automations.noticeHead(folder, "ccc")
  assert.equal(runsOf(world, folder, "on-commit")[0]?.status, "fired")
  assert.equal(runsOf(world, folder, "on-commit")[0]?.occurrence, "commit-ccc")
  assert.equal(runsOf(world, folder, "on-commit")[0]?.runWhen?.verdict, "run")
  // Someone changes the committed definition: it pauses until turned on again.
  const file = join(folder, ".mako", "automations.json")
  const text = JSON.parse(await readFile(file, "utf8"))
  text.automations[1].prompt.objective = "Delete everything."
  await writeFile(file, JSON.stringify(text))
  await world.automations.tick(world.clock.now)
  assert.equal((await world.automations.reading(folder)).automations[1]!.local.paused?.kind, "changed")
  await end(world, runsOf(world, folder, "on-commit")[0], "done")
  assert.equal((await world.automations.reading(folder)).automations[1]!.standing, "paused")
  await world.automations.noticeHead(folder, "ddd")
  assert.equal(runsOf(world, folder, "on-commit")[0]?.occurrence, "commit-ccc", "a changed definition doesn't run")
})

await test("a proposal: agent proposes, pending, the person approves, applied off; decline; stale; expiry; the agent hears", async () => {
  const folder = await project([{ id: "existing", name: "Existing", prompt: brief, triggers: [{ kind: "manual" }] }])
  const world = makeWorld(join(scratch, "proposal-state"), [folder])
  const agent = { kind: "agent" as const, session: "conv-agent" }
  const proposed = await world.tool.act(agent, { action: "create", definition: { id: "weekly", name: "Weekly", prompt: { objective: "Update dependencies." }, triggers: [{ kind: "schedule", cron: "0 6 * * 1" }] }, why: "You asked for weekly updates.", clientKey: "p1" })
  assert.ok("outcome" in proposed && proposed.outcome === "proposed", JSON.stringify(proposed))
  assert.equal(proposed.status, "pending")
  assert.deepEqual(diffFields(proposed.diff), ["name", "prompt", "triggers", "start", "limits", "thread", "result"])
  const repeat = await world.tool.act(agent, { action: "create", definition: { id: "weekly", name: "Weekly", prompt: { objective: "Update dependencies." } }, clientKey: "p1" })
  assert.ok("outcome" in repeat && repeat.outcome === "proposed" && repeat.proposal === proposed.proposal, "a repeat is the same proposal")
  assert.equal((await world.automations.reading(folder)).automations.length, 1, "nothing changed yet")
  const [ask] = world.asks.get("conv-agent") ?? []
  assert.ok(ask?.want.kind === "automation-proposal" && ask.want.proposal === proposed.proposal, "an ask carries it to the Inbox")
  assert.equal(world.asks.get("conv-agent")?.length, 1)
  assert.equal(personOnlyAsk(ask.want), true, "only the person answers it")
  assert.equal(agentAskWords(ask.want, "Claude").title, "Claude wants to add the automation Weekly")
  assert.equal((await world.automations.reading(folder)).proposals[0]?.status, "pending")
  await world.gate.answer("conv-agent", ask.id, true)
  const after = await world.automations.reading(folder)
  assert.deepEqual(after.automations.map((each) => each.definition.id), ["existing", "weekly"])
  assert.equal(after.automations[1]!.local.enabled, false, "a created automation stays off")
  assert.equal(after.proposals[0]?.status, "approved")
  assert.equal(world.asks.get("conv-agent")?.length, 0)
  assert.match(world.told.at(-1)!.text, /^Mako: the person approved your proposal to create the automation weekly/)
  // Enable is a proposal too; the person declines it from its card.
  const enable = await world.tool.act(agent, { action: "enable", id: "weekly", clientKey: "p2" })
  assert.ok("outcome" in enable && enable.outcome === "proposed")
  await world.gate.answer("conv-agent", world.asks.get("conv-agent")![0]!.id, false)
  assert.equal(world.automations.proposal(enable.proposal)?.status, "declined")
  assert.equal((await world.automations.reading(folder)).automations[1]!.local.enabled, false)
  assert.match(world.told.at(-1)!.text, /declined/)
  // An update decided in the Automations view: its diff names only what changes, and its card's ask goes with it.
  const update = await world.tool.act(agent, { action: "update", id: "existing", definition: { limits: { timeoutMin: 15 } }, clientKey: "p3" })
  assert.ok("outcome" in update && update.outcome === "proposed")
  assert.deepEqual(diffFields(update.diff), ["limits"])
  await world.automations.decide(update.proposal, true, "view")
  assert.equal((await world.automations.reading(folder)).automations[0]!.definition.limits.timeoutMin, 15)
  assert.equal(world.asks.get("conv-agent")?.length, 0, "deciding in the view settles its ask")
  // Stale: the definition changed after it was proposed.
  const del = await world.tool.act(agent, { action: "delete", id: "existing", clientKey: "p4" })
  assert.ok("outcome" in del && del.outcome === "proposed")
  await world.automations.save(folder, { id: "existing", name: "Existing, renamed by the person", prompt: brief })
  assert.equal((await world.automations.decide(del.proposal, true)).status, "stale")
  assert.equal((await world.automations.reading(folder)).automations[0]?.definition.id, "existing", "nothing was deleted")
  // Expiry.
  const late = await world.tool.act(agent, { action: "delete", id: "weekly", clientKey: "p5" })
  assert.ok("outcome" in late && late.outcome === "proposed")
  world.clock.now += AUTOMATION_PROPOSAL_TTL_MS + MINUTE
  await world.automations.tick(world.clock.now)
  assert.equal(world.automations.proposal(late.proposal)?.status, "expired")
  assert.equal(world.asks.get("conv-agent")?.length, 0)
  assert.match(world.told.at(-1)!.text, /expired without a decision/)
  // Invalid ones are refused at once, and never asked.
  const bad = await world.tool.act(agent, { action: "create", definition: { id: "Bad Id", name: "x", prompt: brief }, clientKey: "p6" })
  assert.ok("refused" in bad && bad.refused === "invalid")
  assert.equal(world.asks.get("conv-agent")?.length, 0)
  assert.deepEqual(automationDiff(undefined, { name: "a" }), [{ field: "name", after: "a" }])
})

function diffFields(diff: JsonValue): string[] {
  return DiffSchema.parse(diff).map((entry) => entry.field)
}

await test("run_now and disable below full access ask; a known refusal keeps the ask, and a later allow runs once", async () => {
  const folder = await project([{ id: "asked", name: "Asked", prompt: brief, triggers: [{ kind: "manual" }] }])
  const world = makeWorld(join(scratch, "ask-state"), [folder])
  const asked = await world.tool.act({ kind: "agent", session: "conv-b" }, { action: "run_now", id: "asked", clientKey: "r" })
  assert.ok("outcome" in asked && asked.outcome === "asked")
  assert.equal(world.starts.length, 0, "nothing ran on the agent's word")
  world.failStart(new AutomationNotStartedError("No provider."))
  await assert.rejects(world.gate.answer("conv-b", asked.ask, true), /No provider/)
  assert.equal(world.asks.get("conv-b")?.length, 1, "a known refusal keeps the exact ask")
  world.failStart(undefined)
  await Promise.all([world.gate.answer("conv-b", asked.ask, true), world.gate.answer("conv-b", asked.ask, true)])
  assert.equal(world.starts.length, 1, "allowed again, it runs once; two answers at once join")
  assert.equal((await world.gate.answer("conv-b", asked.ask, true)).outcome, "missing", "a later answer finds it settled")
  assert.deepEqual(runsOf(world, folder, "asked")[0]?.cause, { kind: "agent", conversation: "conv-b", ask: asked.ask })
  const off = await world.tool.act({ kind: "agent", session: "conv-b" }, { action: "disable", id: "asked", clientKey: "d" })
  assert.ok("outcome" in off && off.outcome === "asked")
})

console.log(`${passed} automation checks passed`)
await rm(scratch, { recursive: true, force: true })

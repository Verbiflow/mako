import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { frontDoorNote } from "@mako/host/contracts/agent-tools"
import { childState, ReportSchema, waitingStateWords, type ChildState, type Report, type ThreadParent, type WaitingOn } from "@mako/host/contracts/agents"
import { childLine, childWord } from "@mako/host/contracts/children"
import { ChildStateSchema } from "@mako/host/contracts/native-agents"
import { pullOutcome, pullWakeNote, pullWakeWords, type PullReading } from "@mako/host/contracts/pull-waits"
import { SessionIdSchema, ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { PULL_WATCH_EVERY_MS, PULL_WATCH_MAX_MS, PullWatch, type PullWait } from "@mako/host/conversations/pull-watch"
import { readPull } from "@mako/host/git/index"
import { AgentsWorld, type Script, type WorldOptions } from "./lib/agents-world.ts"

/*
 * A Fin woken by the pull request it waits on (`npm run test:fin-pull-waits`): the outcome a reading shows, matched to
 * what the Fin waits for (`pullOutcome`); the one line Mako wakes it with and its transcript's event line; the watched
 * set, its cadence and its pruning on a fake clock (`PullWatch`); and through the engine, a Fin's report that names a
 * pull request read until its outcome, which reaches the Fin once, never its Apex, across restarts. GitHub is a stub.
 */

const SINCE = 1_000_000
const URL = "https://git.example.com/acme/app/pull/371"
const reading = (patch: Partial<PullReading> = {}): PullReading => ({ state: "open", url: URL, author: "fin-bot", checks: [], reviews: [], ...patch })
const check = (name: string, state: PullReading["checks"][number]["state"], at?: number) => ({ name, state, ...(at !== undefined && { at }) })

// Outcomes, each matched to what the wait is for.
{
  const running = reading({ checks: [check("lint", "running"), check("e2e", "running")] })
  assert.equal(pullOutcome(running, "checks", SINCE), undefined, "checks still running: nothing yet")
  const settled = reading({ checks: [check("lint", "failed", SINCE + 5), check("e2e", "failed", SINCE + 9), check("unit", "passed", SINCE + 3)] })
  assert.deepEqual(pullOutcome(settled, "checks", SINCE), { kind: "settled", passed: 1, failed: ["lint", "e2e"] })
  const green = reading({ checks: [check("lint", "passed", SINCE + 5), check("e2e", "passed", SINCE + 9)] })
  assert.deepEqual(pullOutcome(green, "checks", SINCE), { kind: "settled", passed: 2, failed: [] })
  const stale = reading({ checks: [check("lint", "passed", SINCE - 50), check("e2e", "failed", SINCE - 10)] })
  assert.deepEqual(pullOutcome(stale, "checks", SINCE), { kind: "settled", passed: 1, failed: ["e2e"] }, "current-head checks already settled when the wait was registered still answer it")
  const first = reading({ checks: [check("lint", "failed", SINCE + 5), check("e2e", "running")] })
  assert.deepEqual(pullOutcome(first, "checks", SINCE), { kind: "failed", check: "lint", running: 1 }, "the first failure, while others run")
  const known = reading({ checks: [check("lint", "failed", SINCE - 5), check("e2e", "running")] })
  assert.deepEqual(pullOutcome(known, "checks", SINCE), { kind: "failed", check: "lint", running: 1 }, "a current-head failure already present when the wait was registered still answers it")
  assert.equal(pullOutcome(reading(), "checks", SINCE), undefined, "no checks yet: a push GitHub hasn't started on")
  const lone = reading({ checks: [check("lint", "passed"), check("e2e", "cancelled")] })
  assert.deepEqual(pullOutcome(lone, "checks", SINCE), { kind: "settled", passed: 1, failed: [], cancelled: ["e2e"] }, "a cancelled check nothing replaced settles as cancelled, not failed")
  const both = reading({ checks: [check("lint", "failed"), check("e2e", "cancelled"), check("unit", "passed")] })
  assert.deepEqual(pullOutcome(both, "checks", SINCE), { kind: "settled", passed: 1, failed: ["lint"], cancelled: ["e2e"] })
  assert.equal(pullOutcome(reading({ checks: [check("e2e", "cancelled"), check("lint", "running")] }), "checks", SINCE), undefined, "a cancelled check isn't a failure that wakes while others run")

  const approved = reading({ reviews: [{ login: "ada", state: "approved", at: SINCE + 20 }] })
  assert.deepEqual(pullOutcome(approved, "review", SINCE), { kind: "review", by: "ada", state: "approved" })
  assert.deepEqual(pullOutcome(reading({ reviews: [{ login: "ada", state: "changes", at: SINCE + 1 }] }), "review", SINCE), { kind: "review", by: "ada", state: "changes" })
  assert.deepEqual(pullOutcome(reading({ reviews: [{ login: "ada", state: "commented", at: SINCE + 1 }] }), "review", SINCE), { kind: "review", by: "ada", state: "commented" })
  assert.equal(pullOutcome(reading({ reviews: [{ login: "ada", state: "approved", at: SINCE - 1 }] }), "review", SINCE), undefined, "a review from before the wait")
  assert.equal(pullOutcome(reading({ reviews: [{ login: "fin-bot", state: "commented", at: SINCE + 1 }] }), "review", SINCE), undefined, "the author's own replies are no review")
  assert.equal(pullOutcome(approved, "checks", SINCE), undefined, "a review isn't what a wait on checks is for")
  assert.equal(pullOutcome(settled, "review", SINCE), undefined, "nor checks what a wait on review is for")
  assert.equal(pullOutcome(settled, "merge", SINCE), undefined, "and neither is a merge's")

  for (const until of ["checks", "review", "merge", undefined] as const) {
    assert.deepEqual(pullOutcome(reading({ state: "merged" }), until, SINCE), { kind: "merged" }, `merged ends a wait on ${until}`)
    assert.deepEqual(pullOutcome(reading({ state: "closed" }), until, SINCE), { kind: "closed" }, `closed ends a wait on ${until}`)
  }
  assert.deepEqual(pullOutcome(settled, undefined, SINCE), { kind: "settled", passed: 1, failed: ["lint", "e2e"] }, "a wait on nothing in particular takes the first outcome")
}
console.log("outcomes: settled, first failure, review, merged and closed, each matched to until")

// The note, its words read back, and the state words.
{
  const note = pullWakeNote("acme/app#371", URL, { kind: "settled", passed: 1, failed: ["lint", "e2e"] })
  assert.equal(note, `Mako: PR acme/app#371 checks settled: 2 failed (lint, e2e). ${URL}`)
  assert.equal(pullWakeNote("acme/app#371", URL, { kind: "settled", passed: 7, failed: [] }), `Mako: PR acme/app#371 checks settled: all 7 passed. ${URL}`)
  assert.equal(pullWakeNote("acme/app#371", URL, { kind: "failed", check: "lint", running: 3 }), `Mako: PR acme/app#371 check failed: lint, 3 still running. ${URL}`)
  assert.equal(pullWakeNote("acme/app#371", URL, { kind: "review", by: "ada", state: "changes" }), `Mako: PR acme/app#371 review: ada requested changes. ${URL}`)
  assert.equal(pullWakeNote("#371", undefined, { kind: "merged" }), "Mako: PR #371 merged.")
  assert.equal(pullWakeNote("acme/app#371", URL, { kind: "closed" }), `Mako: PR acme/app#371 closed without merging. ${URL}`)
  assert.equal(pullWakeNote("acme/app#9", URL, { kind: "settled", passed: 0, failed: ["a", "b", "c", "d", "e", "f"] }), `Mako: PR acme/app#9 checks settled: 6 failed (a, b, c, d, 2 more). ${URL}`)
  assert.deepEqual(pullWakeWords(note), { line: "Mako: PR acme/app#371 checks settled: 2 failed (lint, e2e).", url: URL }, "its event line says the note's words")
  assert.deepEqual(pullWakeWords("Mako: PR #371 merged."), { line: "Mako: PR #371 merged." })
  const cancelledNote = pullWakeNote("acme/app#371", URL, { kind: "settled", passed: 3, failed: [], cancelled: ["e2e"] })
  assert.equal(cancelledNote, `Mako: PR acme/app#371 checks settled: 3 passed, 1 cancelled (e2e). ${URL}`)
  assert.deepEqual(pullWakeWords(cancelledNote), { line: "Mako: PR acme/app#371 checks settled: 3 passed, 1 cancelled (e2e).", url: URL })
  const mixedNote = pullWakeNote("acme/app#371", URL, { kind: "settled", passed: 1, failed: ["lint"], cancelled: ["e2e", "docs"] })
  assert.equal(mixedNote, `Mako: PR acme/app#371 checks settled: 1 failed (lint), 2 cancelled (e2e, docs). ${URL}`)
  assert.deepEqual(pullWakeWords(mixedNote), { line: "Mako: PR acme/app#371 checks settled: 1 failed (lint), 2 cancelled (e2e, docs).", url: URL })
  assert.equal(pullWakeNote("#3", undefined, { kind: "settled", passed: 1, failed: [], cancelled: [] }), "Mako: PR #3 checks settled: 1 passed.", "no cancelled names, no cancelled words")
  assert.equal(pullWakeWords("Mako: PR acme/app#371 merged. Please fix it."), undefined, "a person's words that start the same aren't the note")
  assert.equal(pullWakeWords("Check the PR"), undefined)

  const waitingOn = [{ kind: "pull-request" as const, ref: URL, repository: "acme/app", number: 371, until: "checks" as const }]
  assert.equal(waitingStateWords(waitingOn, SINCE, SINCE + 12 * 60_000), "Waiting on acme/app#371 checks · 12m")
  assert.equal(waitingStateWords(waitingOn, SINCE, SINCE + 30_000), "Waiting on acme/app#371 checks · <1m")
  assert.equal(waitingStateWords(waitingOn, SINCE, SINCE + 125 * 60_000), "Waiting on acme/app#371 checks · 2h 5m")
  assert.equal(waitingStateWords([{ kind: "pull-request", ref: "#7", until: "merge" }], undefined, undefined), "Waiting on #7 merge")

  const child = ThreadIdSchema.parse("00000000-0000-4000-8000-00000000c41d")
  const session = SessionIdSchema.parse("00000000-0000-4000-8000-0000000a0e01")
  const edge: ThreadParent = {
    child, parent: ThreadIdSchema.parse("00000000-0000-4000-8000-0000000a0e00"), parentSession: session, name: "ci", role: "worker", origin: "started",
    asked: { brief: { objective: "Get the PR green" } }, op: "start:apex:ci", startedBy: { kind: "agent", session }, createdAt: 0,
  }
  const report: Report = { id: `report:${child}:wait`, child, status: "progress", summary: "Opened #371; waiting on its checks.", waitingOn, ownerGeneration: 1, at: SINCE }
  assert.ok(ReportSchema.safeParse(report).success)
  const state = childState(edge, { source: "live" }, { latest: report })
  assert.deepEqual(state, { kind: "idle", waitingOn, since: SINCE }, "a progress report that names what it waits on: idle, waiting since the report")
  assert.ok(ChildStateSchema.safeParse(state).success, "the state crosses the wire")
  assert.equal(childLine(state, SINCE + 12 * 60_000), "Waiting on acme/app#371 checks · 12m", "its row's words")
  assert.equal(childWord(state), "Waiting")
  assert.equal(childState(edge, { source: "live", working: true }, { latest: report }).kind, "working", "a turn of its own is past it")
  assert.deepEqual(childState(edge, { source: "live" }, { latest: { ...report, waitingOn: undefined } }), { kind: "idle" }, "a progress report naming nothing: plain idle")
  const front = frontDoorNote([{ name: "ci", harness: "Codex", state, topic: "Get the PR green" }], SINCE + 12 * 60_000).join("\n")
  assert.match(front, /- fin:ci · Codex · Waiting on acme\/app#371 checks · 12m · asked: Get the PR green/, "its Apex's front door says the same")
}
console.log('words: "Mako: PR acme/app#371 checks settled: 2 failed (lint, e2e). <url>", and "Waiting on acme/app#371 checks · 12m"')

// The reader: the same `gh pr view`, one pull request by repository and number, its checks and reviews with when they finished.
{
  const asked: { cwd: string; args: string[] }[] = []
  const printed = JSON.stringify({
    state: "OPEN", url: URL, headRefOid: "a".repeat(40), author: { login: "fin-bot" },
    statusCheckRollup: [
      { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE", completedAt: "2026-11-04T10:00:00Z" },
      { __typename: "StatusContext", context: "deploy", state: "PENDING", startedAt: "2026-11-04T09:59:00Z" },
    ],
    latestReviews: [{ author: { login: "ada" }, state: "APPROVED", submittedAt: "2026-11-04T10:05:00Z" }],
  })
  const read = await readPull({ repository: "acme/app", number: 371, cwd: "/work" }, async (cwd, args) => (asked.push({ cwd, args }), printed))
  assert.deepEqual(asked, [{ cwd: "/work", args: ["pr", "view", "371", "--repo", "acme/app", "--json", "state,url,headRefOid,author,statusCheckRollup,latestReviews"] }])
  assert.deepEqual(read, {
    state: "open", url: URL, head: "a".repeat(40), author: "fin-bot",
    checks: [{ name: "lint", state: "failed", at: Date.parse("2026-11-04T10:00:00Z") }, { name: "deploy", state: "running", at: Date.parse("2026-11-04T09:59:00Z") }],
    reviews: [{ login: "ada", state: "approved", at: Date.parse("2026-11-04T10:05:00Z") }],
  })

  // A push twice (or a retarget) runs the head again and GitHub cancels the older run: that run is replaced, not failed.
  // gh lists a check's runs as GitHub keeps them, and doesn't say which event started each.
  const runs = (...rollup: object[]) => readPull({ number: 635, cwd: "/work" }, async () => JSON.stringify({ state: "OPEN", url: URL, statusCheckRollup: rollup }))
  const run = (workflowName: string, name: string, conclusion: string, startedAt: string, status = "COMPLETED") => ({ __typename: "CheckRun", workflowName, name, status, conclusion, startedAt, completedAt: startedAt })
  const superseded = await runs(
    run("CI", "test", "CANCELLED", "2026-11-13T10:00:00Z"),
    run("CI", "lint", "SUCCESS", "2026-11-13T10:00:00Z"),
    run("CI", "test", "SUCCESS", "2026-11-13T10:02:00Z"),
    run("CI", "lint", "SUCCESS", "2026-11-13T10:02:00Z"),
  )
  assert.deepEqual(superseded?.checks.map((each) => [each.name, each.state]), [["lint", "passed"], ["test", "passed"], ["lint", "passed"]], "the cancelled run a newer run of its check replaced is dropped")
  assert.deepEqual(pullOutcome(superseded!, "checks", SINCE), { kind: "settled", passed: 3, failed: [] }, "and wakes no one with a failure")
  const replacing = await runs(run("CI", "test", "CANCELLED", "2026-11-13T10:00:00Z"), run("CI", "test", "", "0001-01-01T00:00:00Z", "QUEUED"))
  assert.deepEqual(replacing?.checks.map((each) => each.state), ["running"], "a replacing run not started yet (gh's zero time) still replaces it")
  const lone = await runs(run("CI", "test", "CANCELLED", "2026-11-13T10:00:00Z"), run("CI", "lint", "SUCCESS", "2026-11-13T10:00:00Z"))
  assert.deepEqual(lone?.checks.map((each) => [each.name, each.state]), [["test", "cancelled"], ["lint", "passed"]], "a cancelled run nothing replaced says cancelled")
  assert.deepEqual(pullOutcome(lone!, "checks", SINCE), { kind: "settled", passed: 1, failed: [], cancelled: ["test"] })
  const twice = await runs(run("CI", "test", "CANCELLED", "2026-11-13T10:02:00Z"), run("CI", "test", "CANCELLED", "2026-11-13T10:00:00Z"))
  assert.deepEqual(twice?.checks.map((each) => each.state), ["cancelled"], "of runs all cancelled, the check says cancelled once")
  const apart = await runs(run("CI", "test", "CANCELLED", "2026-11-13T10:00:00Z"), run("Nightly", "test", "SUCCESS", "2026-11-13T10:02:00Z"))
  assert.deepEqual(apart?.checks.map((each) => each.state), ["cancelled", "passed"], "a job of the same name in another workflow is another check")
  const events = await runs(run("CI", "test", "FAILURE", "2026-11-13T10:00:00Z"), run("CI", "test", "SUCCESS", "2026-11-13T10:00:05Z"))
  assert.deepEqual(events?.checks.map((each) => each.state), ["failed", "passed"], "a failure is never hidden by another run of its check (push and pull_request runs read alike)")

  const bare = await readPull({ number: 12, cwd: "/work" }, async (_cwd, args) => (asked.push({ cwd: _cwd, args }), JSON.stringify({ state: "MERGED", url: URL })))
  assert.deepEqual(asked.at(-1)?.args, ["pr", "view", "12", "--json", "state,url,headRefOid,author,statusCheckRollup,latestReviews"], "a bare number is read in the Fin's folder")
  assert.equal(bare?.state, "merged")
  assert.equal(await readPull({ number: 1, cwd: "/work" }, async () => { throw new Error("gh: not logged in") }), null, "a reader that can't answer says nothing")
}
console.log("readPull: one gh pr view by repository and number, parsed as the status tool parses it")

// A PR condition follows the head in the current reading, with that observation preserved in its durable note.
{
  const oldHead = "a".repeat(40)
  const currentHead = "b".repeat(40)
  let now = 0
  let pull = reading({ head: oldHead, checks: [check("lint", "running")] })
  let waits: PullWait[] = [{ key: "head-wait", child: "fin", report: "r", pullKey: "acme/app#371", since: SINCE, pull: "acme/app#371", target: { key: "acme/app#371", repository: "acme/app", number: 371, cwd: "/work" }, until: "checks" }]
  const notes: string[] = []
  const watch = new PullWatch({ waits: () => waits, read: async () => pull, now: () => now, fire: async (_wait, _outcome, note) => { notes.push(note); waits = [] } })
  await watch.tick()
  assert.equal(notes.length, 0, "the earlier head is still running")
  pull = reading({ head: currentHead, checks: [check("lint", "passed", SINCE - 50)] })
  now = PULL_WATCH_EVERY_MS
  await watch.tick()
  assert.equal(notes.length, 1, "a new current head already complete at registration satisfies the condition")
  assert.ok(notes[0]!.includes(`observed head ${currentHead}`))
  assert.ok(!notes[0]!.includes(oldHead), "the previous reading's head cannot label the new check rollup")
  const restored = pullWakeWords(notes[0]!)
  assert.ok(restored?.line.includes(currentHead), "transcript readback preserves the observed head")
  assert.equal(restored?.url, URL)
}

// The watched set on a fake clock: what waits is read, at once, then each minute doubling while nothing changes; dropped once nothing waits.
{
  let now = 0
  const reads: string[] = []
  const fired: string[] = []
  const watching: boolean[] = []
  const readings = new Map<string, PullReading>()
  const wait = (key: string, pull: string, until?: PullWait["until"]): PullWait => ({ key, child: "fin", report: "r", pullKey: pull, since: 0, pull, target: { key: pull, repository: pull.split("#")[0], number: Number(pull.split("#")[1]), cwd: "/work" }, ...(until && { until }) })
  let waits: PullWait[] = [wait("w1", "acme/app#371", "checks"), wait("w2", "acme/app#371", "merge"), wait("w3", "acme/api#9", "review")]
  const watch = new PullWatch({
    waits: () => waits,
    read: async (target) => (reads.push(target.key), readings.get(target.key) ?? null),
    fire: async (fire, _outcome, note) => {
      fired.push(`${fire.key}: ${note}`)
      waits = waits.filter((each) => each.key !== fire.key)
    },
    watching: (on) => watching.push(on),
    now: () => now,
  })
  assert.deepEqual(watch.keys(), [], "nothing is watched before it's asked")
  watch.refresh()
  assert.deepEqual(watch.keys(), ["acme/app#371", "acme/api#9"], "each pull request once, however many wait on it")
  assert.equal(watching.at(-1), true, "the job that reads runs while something is watched")
  readings.set("acme/app#371", reading({ checks: [check("lint", "running")] }))
  readings.set("acme/api#9", reading({ url: "https://git.example.com/acme/api/pull/9" }))
  await watch.tick()
  assert.deepEqual(reads, ["acme/app#371", "acme/api#9"], "a new one is read at the next tick")
  await watch.tick()
  assert.equal(reads.length, 2, "and not again before its minute")
  assert.equal(watch.due("acme/app#371"), PULL_WATCH_EVERY_MS)
  const cadence: number[] = []
  for (let read = 0; read < 5; read++) {
    now = watch.due("acme/app#371")!
    await watch.tick()
    cadence.push(watch.due("acme/app#371")! - now)
  }
  assert.deepEqual(cadence, [2, 4, 8, 8, 8].map((minutes) => minutes * 60_000), "unchanged readings double the wait, up to its most")
  assert.equal(PULL_WATCH_MAX_MS, 8 * 60_000)
  readings.set("acme/app#371", reading({ checks: [check("lint", "failed", 10), check("e2e", "running")] }))
  now = watch.due("acme/app#371")!
  await watch.tick()
  assert.deepEqual(fired, [`w1: Mako: PR acme/app#371 check failed: lint, 1 still running. ${URL}`], "the first failure fires the wait on checks, not the one on merge")
  assert.equal(watch.due("acme/app#371")! - now, PULL_WATCH_EVERY_MS, "a change brings the minute back")
  now = watch.due("acme/app#371")!
  await watch.tick()
  assert.equal(fired.length, 1, "a wait fires once")
  readings.set("acme/app#371", reading({ state: "merged" }))
  now = Math.max(watch.due("acme/app#371")!, watch.due("acme/api#9")!)
  await watch.tick()
  assert.deepEqual(fired.slice(1), [`w2: Mako: PR acme/app#371 merged. ${URL}`])
  assert.deepEqual(watch.keys(), ["acme/api#9"], "a pull request nothing waits on is dropped")
  waits = []
  watch.refresh()
  assert.deepEqual(watch.keys(), [])
  assert.equal(watching.at(-1), false, "and with nothing watched, nothing reads")
  const before = reads.length
  now += PULL_WATCH_MAX_MS * 4
  await watch.tick()
  assert.equal(reads.length, before, "no pull request is read that nothing waits on")
}
console.log("PullWatch: read at once, then a minute doubling to eight while unchanged; fired once; pruned when nothing waits")

// Prose retains its exact source identities but is never an effective subscription, before or after restart.
{
  const dir = mkdtempSync(join(tmpdir(), "mako-unwatched-main-"))
  let reads = 0
  const options: WorldOptions = { root: dir, script: () => "ok", readPull: async () => { reads += 1; return null } }
  const world = new AgentsWorld(options)
  const wait = { kind: "other" as const, text: `Main CI run7 attempt1 job71 at ${"a".repeat(40)}` }
  const artifacts = [{ kind: "test-run" as const, ref: "https://github.com/acme/app/actions/runs/7" }, { kind: "commit" as const, ref: "a".repeat(40) }]
  try {
    const apex = await world.apex("codex", "full")
    const fin = await world.agents.start(apex.caller, { harness: "claude", brief: { objective: "Observe main CI" }, name: "ci", clientKey: "ci", cwd: dir })
    assert.ok(!("refused" in fin) && fin.conversation)
    await world.settle(100)
    const input = { status: "done" as const, summary: "Waiting for main CI.", waitingOn: [wait], artifacts, clientKey: "prose" }
    const receipt = await world.agents.report(world.caller(fin.conversation!), input)
    assert.ok(!("refused" in receipt))
    assert.equal(receipt.subscriptions?.[0]?.state, "unsupported", "recorded prose must not masquerade as an automatic watch")
    assert.match(receipt.subscriptions?.[0]?.why ?? "", /no automatic wake/)
    assert.deepEqual(receipt.subscriptions?.[0]?.wait, wait, "the refusal preserves job/run/attempt/head identity")
    assert.match(waitingStateWords([wait], 0, 0), /no automatic wake/, "the durable unsupported state is visible when read")
    await world.agents.pulls.tick()
    assert.deepEqual(world.agents.pulls.keys(), [])
    assert.equal(reads, 0, "an artifact URL or prose is never parsed into a PR watch")
    await world.restart()
    await world.agents.pulls.tick()
    const reread = await world.agents.report(world.caller(fin.conversation!), input)
    assert.ok(!("refused" in reread) && reread.subscriptions?.[0]?.state === "unsupported", "an old durable report gets the same honest receipt after migration/restart")
    const child = world.store.edges().all.find((edge) => edge.name === "ci")!.child
    const kept = world.store.reportsOf(child).find((report) => report.id.endsWith(":prose"))!
    assert.deepEqual(kept.waitingOn, [wait])
    assert.deepEqual(kept.artifacts, artifacts)
    const readBack = await world.agents.read(apex.caller, { child: "ci" })
    assert.ok(!("refused" in readBack))
    assert.match(readBack.text, /run7 attempt1 job71 at a{40} \(no automatic wake\)/, "reading an old done report shows its unsupported wait explicitly")
    assert.deepEqual(world.agents.pulls.keys(), [])
    assert.equal(reads, 0, "restart doesn't invent a subscription")
    const validInput = { status: "progress" as const, summary: "Waiting on an actual PR.", waitingOn: [{ kind: "pull-request" as const, ref: "acme/app#371", until: "checks" as const }], clientKey: "valid" }
    const valid = await world.agents.report(world.caller(fin.conversation!), validInput)
    assert.ok(!("refused" in valid) && valid.subscriptions?.[0]?.state === "registered", "a supported condition returns an actual registration receipt")
    assert.deepEqual(world.agents.pulls.keys(), ["acme/app#371"])
    const stale = await world.agents.report(world.caller(fin.conversation!), input)
    assert.ok(!("refused" in stale) && stale.subscriptions?.[0]?.state === "unsupported")
    assert.deepEqual(world.agents.pulls.keys(), ["acme/app#371"], "replaying the old prose report cannot replace a newer subscription")
    const current = world.store.reportsOf(child).at(-1)!
    world.store.claimPullWake({ wait: `pull-wake:${child}:${current.id}:acme/app#371`, child, report: current.id, pull: "acme/app#371", outcome: "settled", request: randomUUID(), text: "Mako: PR acme/app#371 checks settled: all 1 passed.", at: Date.now() })
    const claimed = await world.agents.report(world.caller(fin.conversation!), validInput)
    assert.ok(!("refused" in claimed) && claimed.subscriptions?.[0]?.state === "claimed", "a durable claim is distinct from a live watch or proven delivery")
    assert.match(!("refused" in claimed) ? claimed.subscriptions?.[0]?.why ?? "" : "", /does not prove/)
    await world.agents.report(world.caller(fin.conversation!), { status: "progress", summary: "Wait withdrawn.", clientKey: "withdraw" })
    const inactive = await world.agents.report(world.caller(fin.conversation!), validInput)
    assert.ok(!("refused" in inactive) && inactive.subscriptions?.[0]?.state === "inactive", "replaying an obsolete report cannot claim a live registration")
    options.readPull = undefined
    await world.restart()
    const unavailable = await world.agents.report(world.caller(fin.conversation!), { ...validInput, clientKey: "without-reader" })
    assert.ok(!("refused" in unavailable) && unavailable.subscriptions?.[0]?.state === "unavailable", "a host without the reader cannot promise an automatic wake")
    assert.deepEqual(world.agents.pulls.keys(), [])
  } finally {
    await world.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
console.log("subscription receipts: unsupported prose, exact identity through restart, valid PR registration, no implicit monitoring")

// Through the engine: a Fin's report names a pull request; its outcome wakes the Fin once, never its Apex, across restarts.
const root = mkdtempSync(join(tmpdir(), "mako-pull-waits-"))
try {
  let offset = 0
  const now = () => Date.now() + offset
  let pull: PullReading | null = null
  const reads: string[] = []
  const finTexts: string[] = []
  const apexTexts: string[] = []
  const fins = new Map<string, string>()
  const WAIT_ON = new Map([
    ["ci", { ref: URL, until: "checks" as const }],
    ["review", { ref: "https://git.example.com/acme/app/pull/380", until: "review" as const }],
  ])
  const script: Script = async (turn) => {
    const name = fins.get(turn.conversation)
    if (!name) {
      if (turn.text.startsWith(FROM_AGENTS)) apexTexts.push(turn.text)
      return "ok"
    }
    if (name === "ci") finTexts.push(turn.text)
    if (turn.text.includes("You're fin:")) {
      const waitOn = WAIT_ON.get(name)!
      const reported = await turn.world.agents.report(turn.caller, { status: "progress", summary: `Opened the PR; waiting on its ${waitOn.until}.`, waitingOn: [{ kind: "pull-request", ...waitOn }], clientKey: "wait" })
      assert.ok(!("refused" in reported) && reported.delivered === "none", "a progress report wakes no Apex")
      return "Waiting on the PR."
    }
    return "Fixed lint and e2e; pushed."
  }
  const world = new AgentsWorld({ root, script, now, readPull: async (target) => (reads.push(`${target.repository}#${target.number}`), target.number === 371 ? pull : null) })
  const apex = await world.apex("claude", "full")
  for (const name of ["ci", "review"]) {
    const started = await world.agents.start(apex.caller, { brief: { objective: `PR ${name}` }, harness: "codex", name, clientKey: name, cwd: world.root })
    assert.ok(!("refused" in started) && started.conversation)
    fins.set(started.conversation!, name)
  }
  const stateOf = (name: string): ChildState | undefined => world.agents.roster(apex.conversation).find((each) => each.child?.name === name)?.child?.state
  await world.settle(300)
  const waiting = stateOf("ci")
  assert.ok(waiting?.kind === "idle" && waiting.waitingOn?.length === 1 && waiting.since !== undefined, `the Fin waits: ${JSON.stringify(waiting)}`)
  assert.equal(childLine(waiting, waiting.since! + 12 * 60_000), "Waiting on acme/app#371 checks · 12m")
  const listed = await world.agents.list(apex.caller, {})
  assert.ok("children" in listed)
  assert.match(listed.children.find((strip) => strip.name === "ci")?.waiting ?? "", /^Waiting on acme\/app#371 checks · <1m$/, "its strip says the same")
  assert.deepEqual(world.agents.pulls.keys(), ["acme/app#371", "acme/app#380"], "the watched set is what reports named")

  // Stopping a Fin drops what it waited on.
  const stopped = await world.agents.stop(apex.caller, { child: "review" })
  assert.ok(!("refused" in stopped))
  assert.deepEqual(world.agents.pulls.keys(), ["acme/app#371"], "a stopped Fin waits on nothing")

  pull = reading({ checks: [check("lint", "running"), check("e2e", "running")] })
  await world.agents.pulls.tick()
  assert.deepEqual(reads, ["acme/app#371"], "only what a Fin waits on is read")
  assert.equal(finTexts.length, 1, "running checks wake no one")

  // A restart rebuilds the set from the stored reports.
  await world.restart()
  assert.deepEqual(world.agents.pulls.keys(), ["acme/app#371"], "a new host watches what the last one did")

  const at = now() - 10_000
  pull = reading({ checks: [check("lint", "failed", at), check("e2e", "failed", at + 10)] })
  await world.agents.pulls.tick()
  const note = `Mako: PR acme/app#371 checks settled: 2 failed (lint, e2e). ${URL}`
  await world.settle(300)
  assert.deepEqual(finTexts.slice(1), [note], "the Fin takes Mako's note as its next turn")
  assert.ok(!apexTexts.some((text) => text.includes("Mako: PR")) && !world.prompts.some((prompt) => prompt.conversation === apex.conversation && prompt.text.includes("Mako: PR")), "its Apex never hears the note")
  const ciConversation = [...fins].find(([, name]) => name === "ci")![0]
  const request = world.live.held(ciConversation)?.requests.find((each) => each.text === note)
  assert.deepEqual(request?.actor, { kind: "service", name: "pull-watch" }, "Mako's words, never the person's")
  assert.deepEqual(world.agents.pulls.keys(), [], "a wait that fired is watched no more")
  assert.equal(world.store.undeliveredPullWakes().length, 0)

  // Once per outcome: another tick, and a restart, send nothing again.
  offset += PULL_WATCH_MAX_MS
  await world.agents.pulls.tick()
  await world.restart()
  offset += PULL_WATCH_MAX_MS
  await world.agents.pulls.tick()
  await world.settle(300)
  assert.equal(finTexts.filter((text) => text === note).length, 1, "the outcome reached the Fin once, across a restart")
  assert.notEqual(stateOf("ci")?.kind, "idle", "its turn after the note is past the wait")
  // A new report may renew an unchanged wait after all checks finished (#544 and #470). It is a new wait,
  // answered from the current head's state, even after restart and even when every check predates that report.
  const finishedAt = now() - 10_000
  const observedHead = "c".repeat(40)
  pull = reading({ head: observedHead, checks: [check("lint", "passed", finishedAt), check("e2e", "passed", finishedAt)] })
  await world.agents.report(world.caller(ciConversation), {
    status: "progress", summary: "Rerun accepted; waiting for checks.", clientKey: "renewed-after-completion",
    waitingOn: [{ kind: "pull-request", ref: URL, until: "checks" }],
  })
  await world.restart()
  await world.agents.pulls.tick()
  await world.settle(300)
  const greenNote = `Mako: PR acme/app#371 checks settled: all 2 passed; observed head ${observedHead}. ${URL}`
  assert.equal(finTexts.filter((text) => text === greenNote).length, 1, "a renewed wait wakes on checks that finished before its report")
  await world.restart()
  await world.agents.pulls.tick()
  await world.settle(300)
  assert.equal(finTexts.filter((text) => text === greenNote).length, 1, "the renewed wait's receipt survives restart")
  await world.close()
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log("engine: watched from reports, rebuilt on start, pruned on stop; the outcome reaches the Fin once as Mako's note, never its Apex")

// What can come between a reading and the Fin taking the note: a stop, a newer report, a restart. Each sends nothing.
{
  const roots = mkdtempSync(join(tmpdir(), "mako-pull-withdrawn-"))
  const MERGED: PullReading = { state: "merged", url: "https://git.example.com/acme/app/pull/7", checks: [], reviews: [] }
  const until = async (what: string, done: () => boolean): Promise<void> => {
    const deadline = Date.now() + 10_000
    while (!done()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  /** An Apex and one Fin whose first turn reports it waits on acme/app#7's merge; `busy` holds a turn of the Fin's that says so. */
  const waiting = async (name: string, read: () => Promise<PullReading | null> = async () => MERGED, now?: () => number, retain = false) => {
    const fin = { conversation: "", ready: false }
    const world: AgentsWorld = new AgentsWorld({
      root: join(roots, name),
      ...(now && { now }),
      readPull: (target) => target.number === 7 ? read() : Promise.resolve(null),
      script: async (turn) => {
        if (turn.text.includes("You're fin:")) {
          fin.conversation = turn.conversation
          await turn.world.agents.report(turn.caller, { status: "progress", summary: "Waiting on #7.", waitingOn: [{ kind: "pull-request", ref: "acme/app#7", until: "merge" }], clientKey: "wait" })
          fin.ready = true
        } else if (turn.text.includes("busy")) await turn.world.hold(turn.conversation)
        else if (retain && turn.text.startsWith("Mako: PR")) await turn.world.agents.report(turn.caller, { status: "progress", summary: "Outcome received; another dependency remains.", waitingOn: [{ kind: "pull-request", ref: "acme/app#7", until: "merge" }], clientKey: `retained-${turn.world.prompts.length}` })
        return "ok"
      },
    })
    const apex = await world.apex("claude", "full")
    const started = await world.agents.start(apex.caller, { harness: "codex", brief: { objective: "Land #7" }, name: "one", clientKey: "one", cwd: world.root })
    assert.ok(!("refused" in started))
    await until("the Fin to wait", () => fin.ready && world.live.session(fin.conversation)?.status === "ready")
    const notes = () => world.prompts.filter((prompt) => prompt.conversation === fin.conversation && prompt.text.startsWith("Mako: PR"))
    const supersede = async (key: string) => {
      const reported = await world.agents.report(world.caller(fin.conversation), { status: "progress", summary: "No longer waiting; on other work.", clientKey: key })
      assert.ok(!("refused" in reported))
    }
    return { world, apex, fin, notes, supersede }
  }
  /** A claim kept as a host that died right after claiming leaves it: not yet handed to delivery. */
  const claimed = (world: AgentsWorld) => {
    const child = world.store.edges().all.find((edge) => edge.name === "one")!.child
    const report = `report:${child}:wait`
    const kept = world.store.claimPullWake({
      wait: `pull-wake:${child}:${report}:acme/app#7`, child, report, pull: "acme/app#7", outcome: "merged",
      request: randomUUID(), text: "Mako: PR acme/app#7 merged. https://git.example.com/acme/app/pull/7", at: Date.now(),
    })
    assert.ok(kept.claimed)
    return child
  }

  try {
    // #463: equivalent narration must preserve the already queued outcome and its identity.
    {
      const { world, apex, fin, notes } = await waiting("retained-wait-at-handoff", undefined, undefined, true)
      const sent = await world.agents.send(apex.caller, { to: "one", text: "busy: clarify another PR", clientKey: "busy" })
      assert.ok(!("refused" in sent))
      await until("the Fin to be busy", () => world.live.session(fin.conversation)?.status === "running")
      await world.agents.pulls.tick()
      const old = world.live.held(fin.conversation)!.requests.find((request) => request.actor?.kind === "service")!
      assert.equal(old.status, "queued")
      await world.agents.report(world.caller(fin.conversation), { status: "progress", summary: "Clarifying another PR; still waiting on #7.", waitingOn: [{ kind: "pull-request", ref: "acme/app#7", until: "merge" }], clientKey: "clarification" })
      world.release(fin.conversation)
      await world.settle()
      assert.equal(notes().length, 1, "retaining the dependency must not cancel its queued outcome")
      assert.equal(world.live.held(fin.conversation)?.requests.find((request) => request.id === old.id)?.status, "completed", "the original request reaches native handoff")
      await world.restart()
      await world.agents.pulls.tick()
      await world.settle()
      assert.equal(notes().length, 1, "equivalent narration cannot create another wake after restart")
      const child = world.store.edges().all.find((edge) => edge.name === "one")!.child
      assert.equal(world.store.pullWakesOf([child]).size, 1, "the dependency keeps one durable outcome claim")
      await world.agents.report(world.caller(fin.conversation), { status: "progress", summary: "Another PR finished; both dependencies still matter.", waitingOn: [{ kind: "pull-request", ref: "https://git.example.com/acme/app/pull/7", until: "merge" }, { kind: "pull-request", ref: "acme/app#8", until: "checks" }], clientKey: "multi-dependency" })
      await world.restart()
      await world.agents.pulls.tick()
      await world.settle()
      assert.equal(notes().length, 1, "reporting another dependency cannot re-fire the finished one")
      await world.close()
    }

    // Multiple unconsumed dependencies survive narration; observation changes, not narration, re-arm their outcomes.
    {
      let offset = 0
      let seq = 0
      let readable = false
      const target = (number: number): WaitingOn => ({ kind: "pull-request", ref: `acme/app#${number}`, until: "checks" })
      let waits = [target(7), target(8)]
      const pulls = new Map([[7, reading({ head: "a".repeat(40), checks: [check("lint", "failed", 10)] })], [8, reading({ head: "b".repeat(40), checks: [check("unit", "passed", 10)] })]])
      const world = new AgentsWorld({ root: join(roots, "observation-cursors"), now: () => Date.now() + offset, readPull: async (target) => readable ? pulls.get(target.number) ?? null : null, script: async (turn) => {
        if (turn.text.includes("busy")) await turn.world.hold(turn.conversation)
        else if (turn.text.includes("You're fin:") || turn.text.startsWith("Mako: PR")) await turn.world.agents.report(turn.caller, { status: "progress", summary: "Retain the dependencies while coordinating other work.", waitingOn: waits, clientKey: `keep-${seq++}` })
        return "ok"
      } })
      try {
        const apex = await world.apex("claude", "full")
        const fin = await world.agents.start(apex.caller, { harness: "codex", brief: { objective: "Coordinate dependencies" }, name: "one", clientKey: "one", cwd: world.root })
        assert.ok(!("refused" in fin) && fin.conversation)
        const conversation = fin.conversation!
        const child = world.store.edges().all.find((edge) => edge.name === "one")!.child
        const notes = () => world.prompts.filter((prompt) => prompt.conversation === conversation && prompt.text.startsWith("Mako: PR"))
        const report = () => world.agents.report(world.caller(conversation), { status: "progress", summary: "Other work finished; same dependencies remain.", waitingOn: waits, clientKey: `narration-${seq++}` })
        const tick = async () => { offset += PULL_WATCH_MAX_MS; await world.agents.pulls.tick(); await world.settle(100) }
        await world.settle(100)
        await world.agents.send(apex.caller, { to: "one", text: "busy", clientKey: "busy" })
        await until("both outcomes to queue behind busy work", () => world.live.session(conversation)?.status === "running")
        readable = true
        offset += PULL_WATCH_MAX_MS
        await world.agents.pulls.tick()
        const queued = world.live.held(conversation)!.requests.filter((request) => request.actor?.kind === "service" && request.status === "queued")
        assert.equal(queued.length, 2)
        await report()
        world.release(conversation)
        await world.settle(100)
        assert.equal(notes().length, 2, "both already-finished dependencies survive another dependency's narration")
        assert.ok(queued.every((request) => world.live.held(conversation)!.requests.find((row) => row.id === request.id)?.status === "completed"), "the original unconsumed requests are retained")
        await world.restart()
        await report()
        await tick()
        assert.equal(notes().length, 2, "same-head terminal observations do not form a green wake loop across reports/restart")
        assert.equal(world.store.pullWakesOf([child]).size, 2)
        pulls.set(7, reading({ head: "c".repeat(40), checks: [check("lint", "passed", 10)] }))
        await tick()
        assert.equal(notes().length, 3, "a different head is a new observation even with the same completion time")
        pulls.set(7, reading({ head: "c".repeat(40), checks: [check("lint", "passed", 20)] }))
        await tick()
        assert.equal(notes().length, 4, "a same-head rerun with a different completion cursor is a new observation")
        await report()
        await tick()
        assert.equal(notes().length, 4)
        pulls.set(7, { ...pulls.get(7)!, reviews: [{ login: "reviewer", state: "commented", at: Date.now() + offset + 1 }] })
        await tick()
        assert.equal(notes().length, 4, "irrelevant review metadata does not re-fire a checks observation")
        waits = [target(8)]
        await report()
        waits = [target(7), target(8)]
        await report()
        await tick()
        assert.equal(notes().length, 5, "explicit withdrawal and re-registration deliberately starts a new dependency wait")
      } finally { await world.close() }
    }

    // Existing durable claims keep their original identity after upgrade, including the old outbox boundary.
    for (const retired of [false, true]) {
      const { world, fin, notes } = await waiting(`legacy-equivalent-${retired}`, undefined, undefined, true)
      const child = claimed(world)
      const original = world.store.pullWakesFor(child)[0]!
      if (retired) world.store.retirePullWake(original.wait, Date.now())
      await world.agents.report(world.caller(fin.conversation), { status: "progress", summary: "Same dependency; updated narration.", waitingOn: [{ kind: "pull-request", ref: "acme/app#7", until: "merge" }], clientKey: "clarification" })
      await world.restart()
      await world.agents.pulls.tick()
      await world.settle(100)
      assert.equal(notes().length, 1, "legacy outbox claims are preserved, or regenerated only if already retired by the old host")
      if (!retired) assert.equal(world.live.held(fin.conversation)?.requests.find((request) => request.id === original.request)?.status, "completed", "upgrade retains the original unconsumed legacy request")
      await world.restart()
      await world.agents.pulls.tick()
      await world.settle(100)
      assert.equal(notes().length, 1, "legacy reconciliation does not replay an unchanged terminal result")
      await world.close()
    }

    for (const boundary of ["archive", "condition", "withdraw-readd"] as const) {
      const { world, apex, fin, notes } = await waiting(`retained-guard-${boundary}`)
      await world.agents.send(apex.caller, { to: "one", text: "busy", clientKey: "busy" })
      await until("the guard's busy turn", () => world.live.session(fin.conversation)?.status === "running")
      await world.agents.pulls.tick()
      const original = world.live.held(fin.conversation)!.requests.find((request) => request.actor?.kind === "service")!
      const report = (waitingOn?: WaitingOn[]) => world.agents.report(world.caller(fin.conversation), { status: "progress", summary: "Changed dependency control.", ...(waitingOn && { waitingOn }), clientKey: `guard-${waitingOn ? "keep" : "withdraw"}` })
      if (boundary === "archive") world.archived.add(fin.conversation)
      else {
        if (boundary === "withdraw-readd") await report()
        await report([{ kind: "pull-request", ref: "acme/app#7", until: boundary === "condition" ? "checks" : "merge" }])
      }
      world.release(fin.conversation)
      await world.settle(100)
      assert.equal(notes().length, 0, `${boundary} still rejects the old queued claim`)
      assert.equal(world.live.held(fin.conversation)?.requests.find((request) => request.id === original.id)?.status, "canceled")
      await world.restart()
      await world.agents.pulls.tick()
      await world.settle(100)
      assert.equal(notes().length, boundary === "archive" ? 0 : 1, "only the deliberately new dependency may produce a replacement outcome")
      await world.close()
    }

    // A stop after the claim, before delivery: a restart's replay finds the Fin stopped, sends nothing, reopens nothing.
    {
      const { world, apex, notes } = await waiting("stop-after-claim")
      const child = claimed(world)
      const stopped = await world.agents.stop(apex.caller, { child: "one" })
      assert.ok(!("refused" in stopped))
      await world.restart()
      await world.settle(300)
      assert.deepEqual(notes(), [], "a stopped Fin gets no note")
      assert.ok(world.store.edges().of(child)?.closedAt !== undefined, "and stays stopped: no PR note reopens it")
      assert.equal(world.store.undeliveredPullWakes().length, 0, "its claim is retired, never resent")
      await world.close()
    }

    // A note queued behind the Fin's running turn, then a stop: the Stop's latch holds it at the handoff.
    {
      const { world, apex, fin, notes } = await waiting("stop-while-queued")
      const sent = await world.agents.send(apex.caller, { to: "one", text: "busy: look at the flaky test", clientKey: "busy" })
      assert.ok(!("refused" in sent))
      await until("the Fin to be busy", () => world.live.session(fin.conversation)?.status === "running")
      await world.agents.pulls.tick()
      assert.equal(world.live.held(fin.conversation)?.requests.find((request) => request.actor?.kind === "service")?.status, "queued")
      const stopped = await world.agents.stop(apex.caller, { child: "one" })
      assert.ok(!("refused" in stopped))
      await world.settle(300)
      await world.restart()
      await world.settle(300)
      assert.deepEqual(notes(), [], "nothing reaches a stopped Fin, across a restart too")
      assert.ok(world.store.edges().all.find((edge) => edge.name === "one")?.closedAt !== undefined, "and it stays stopped")
      await world.close()
    }

    // A newer report without waitingOn while GitHub is read: the old wait wakes no one.
    {
      let opened = false
      let release = () => {}
      const held = new Promise<void>((resolve) => (release = resolve))
      const { world, notes, supersede } = await waiting("superseded-during-read", async () => {
        opened = true
        await held
        return MERGED
      })
      const tick = world.agents.pulls.tick()
      await until("the read to begin", () => opened)
      await supersede("moved-on")
      release()
      await tick
      await world.settle(300)
      assert.deepEqual(notes(), [], "a withdrawn wait sends nothing")
      assert.equal(world.store.undeliveredPullWakes().length, 0, "and claims nothing")
      assert.deepEqual(world.agents.pulls.keys(), [], "nor is watched")
      await world.close()
    }

    // A note queued behind the Fin's running turn, withdrawn by a report in that turn: its handoff refuses it.
    {
      const { world, apex, fin, notes, supersede } = await waiting("withdrawn-at-handoff")
      const sent = await world.agents.send(apex.caller, { to: "one", text: "busy: look at the flaky test", clientKey: "busy" })
      assert.ok(!("refused" in sent))
      await until("the Fin to be busy", () => world.live.session(fin.conversation)?.status === "running")
      await world.agents.pulls.tick()
      const queued = world.live.held(fin.conversation)?.requests.find((request) => request.actor?.kind === "service")
      assert.equal(queued?.status, "queued", "the note waits for the Fin's turn to end")
      await supersede("moved-on")
      world.release(fin.conversation)
      await world.settle(300)
      assert.deepEqual(notes(), [], "the handoff refused it: the harness never had it")
      assert.equal(world.live.held(fin.conversation)?.requests.find((request) => request.id === queued!.id)?.status, "canceled", "and it never goes")
      const kept = world.store.pullWakeOfRequest(world.store.edges().all.find((edge) => edge.name === "one")!.child, queued!.id)
      assert.ok(kept?.obsolete !== undefined, "its claim is retired as obsolete")
      await world.restart()
      await world.settle(300)
      assert.deepEqual(notes(), [], "and a restart doesn't send it")
      await world.close()
    }

    // Reports in one millisecond keep the order they were taken in, whatever their ids say, read live and after a
    // restart: "supersede" and "a" both sort before "wait", and each was taken after it.
    {
      const at = 1_900_000_000_000
      const { world, supersede, notes, fin } = await waiting("same-millisecond", undefined, () => at)
      const reports = () => world.store.reportsOf(world.store.edges().all[0]!.child).map((report) => report.id)
      claimed(world)
      await supersede("supersede")
      assert.equal(world.store.latestReports().get(world.store.edges().all[0]!.child)?.waitingOn, undefined, "the latest report is the last taken")
      assert.equal(new Set(world.store.reportsOf(world.store.edges().all[0]!.child).map((report) => report.at)).size, 1, "all in one millisecond")
      await world.agents.report(world.caller(fin.conversation), { status: "progress", summary: "Newest.", clientKey: "a" })
      assert.equal(world.store.reportsOf(world.store.edges().all[0]!.child).at(-1)?.summary, "Newest.", `taken last, whatever its id sorts as: ${reports().join()}`)
      await world.restart()
      await world.settle(300)
      assert.deepEqual(notes(), [], "the withdrawn wait's note isn't sent")
      assert.equal(world.store.latestReports().get(world.store.edges().all[0]!.child)?.summary, "Newest.", "and the next host reads the same order")
      assert.deepEqual(world.agents.pulls.keys(), [], "and watches nothing")
      await world.close()
    }

    // A note queued behind a running turn when Mako quits: the exit pauses it with the queue, and the next host sends it.
    {
      const { world, fin } = await waiting("queued-at-quit")
      world.say(fin.conversation, "busy")
      await until("the turn to run", () => world.live.session(fin.conversation)?.status === "running")
      await world.agents.pulls.tick()
      await until("the note to queue", () => world.live.snapshot(fin.conversation)?.requests.some((request) => request.text.startsWith("Mako: PR") && request.status === "queued") === true)
      await world.restart()
      // Beneath Mako's word of the turn the quit cut.
      const sent = () => world.prompts.filter((prompt) => prompt.conversation === fin.conversation && prompt.text.includes("Mako: PR acme/app#7"))
      await until("the note to go by itself", () => sent().length > 0)
      await world.settle(300)
      assert.equal(sent().length, 1, "once")
      await world.close()
    }

    // A claim not yet delivered, then a report that withdraws its wait, then a restart: the replay retires it.
    {
      const { world, notes, supersede } = await waiting("withdrawn-then-restart")
      claimed(world)
      assert.equal(world.store.undeliveredPullWakes().length, 1, "one claim waits for the next start")
      await supersede("withdrawn")
      await world.restart()
      await world.settle(300)
      assert.deepEqual(notes(), [], "the old note isn't sent")
      assert.equal(world.store.undeliveredPullWakes().length, 0, "its claim is retired")
      await world.close()
    }
  } finally {
    rmSync(roots, { recursive: true, force: true })
  }
}
console.log("withdrawn: a stop after the claim or while queued, a newer report during the read or before the handoff, and a replay after a restart each send nothing")

console.log("fin pull waits: ok")

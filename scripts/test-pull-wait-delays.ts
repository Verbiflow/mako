import assert from "node:assert/strict"
import { CI_INCOMPLETE_MS, PULL_READ_FAILED_MS, pullOutcome, pullWakeNote, pullWakeWords, type PullReading, type PullOutcome } from "@mako/host/contracts/pull-waits"

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { followHostLog } from "@mako/host/base/host-log"
import { PULL_WATCH_MAX_MS, PullWatch, type PullWait } from "@mako/host/conversations/pull-watch"
import { PullReadError, readPull } from "@mako/host/git/index"
import { GitHubRateLimitError, GitHubRepositoryLookupError } from "@mako/host/git/github-reads"
import { AgentsWorld } from "./lib/agents-world"

const since = 1_000_000
const pending: PullReading = { state: "open", url: "https://github.com/acme/app/pull/7", head: "a".repeat(40), checks: [{ name: "e2e", state: "running" }], reviews: [] }
assert.deepEqual(pullOutcome(pending, "checks", since, since + 45 * 60_000, since), { kind: "incomplete", minutes: 45, running: ["e2e"] }, "a head still running at 45 minutes wakes its Fin")

assert.equal(pullOutcome(pending, "checks", since, since + CI_INCOMPLETE_MS - 1, since), undefined)
assert.equal(pullOutcome(pending, "review", since, since + CI_INCOMPLETE_MS, since), undefined)
assert.equal(pullOutcome(pending, "merge", since, since + CI_INCOMPLETE_MS, since), undefined)
assert.deepEqual(pullOutcome({ ...pending, checks: [...pending.checks, { name: "lint", state: "failed" }] }, "checks", since, since + CI_INCOMPLETE_MS, since), { kind: "incomplete", minutes: 45, running: ["e2e"] }, "an earlier failure doesn't hide that other checks never finish")
assert.deepEqual(pullOutcome({ ...pending, headAt: since }, "checks", since + CI_INCOMPLETE_MS, since + CI_INCOMPLETE_MS, since + CI_INCOMPLETE_MS), { kind: "incomplete", minutes: 45, running: ["e2e"] }, "an old head's current check start proves its push was at least this old, even for a new wait")
assert.equal(pullOutcome({ ...pending, headAt: Number.NaN }, "checks", since, since + CI_INCOMPLETE_MS - 1, since), undefined)
assert.equal(pullOutcome({ ...pending, headAt: since + CI_INCOMPLETE_MS }, "checks", since, since + CI_INCOMPLETE_MS - 1, since), undefined, "future/invalid starts cannot cause an early wake")
for (const outcome of [{ kind: "incomplete", minutes: 45, running: ["e2e"] }, { kind: "unreadable", minutes: 15 }] satisfies PullOutcome[]) {
  const note = pullWakeNote("acme/app#7", pending.url, outcome, pending.head)
  assert.deepEqual(pullWakeWords(note), { line: note.slice(0, note.lastIndexOf(" https://")), url: pending.url })
}
await assert.rejects(readPull({ number: 7, cwd: "/fixture" }, async () => { throw new Error("PRIVATE-CLI-OUTPUT") }), error => error instanceof PullReadError && error.reason === "request" && !String(error).includes("PRIVATE"))
for (const refusal of [new GitHubRateLimitError(since + 20 * 60_000), new GitHubRepositoryLookupError(since + 60_000)])
  await assert.rejects(readPull({ number: 7, cwd: "/fixture" }, async () => { throw refusal }), error => error === refusal, "shared reader refusals retain their type and deadline")
for (const bad of ["not json", "null", "{}", '{"state":"OPEN"}', JSON.stringify({ state: "OPEN", url: pending.url }), JSON.stringify({ state: "WRONG", url: pending.url }), JSON.stringify({ state: "OPEN", url: pending.url, statusCheckRollup: [null] })])
  await assert.rejects(readPull({ number: 7, cwd: "/fixture" }, async () => bad), error => error instanceof PullReadError && error.reason === "response")

// A later push has its own conservative age bound, without a new timer or faster cadence.
{
  let now = since, head = "a".repeat(40)
  const waits: PullWait[] = [{ key: "head-clock", child: "fin", report: "r", pullKey: "acme/app#7", since, pull: "acme/app#7", target: { key: "acme/app#7", repository: "acme/app", number: 7, cwd: "/fixture" }, until: "checks" }]
  const notes: string[] = []
  const watch = new PullWatch({ waits: () => waits, now: () => now, read: async () => ({ ...pending, head }), fire: async (_wait, _outcome, note) => { notes.push(note) } })
  await watch.tick()
  now += CI_INCOMPLETE_MS - 60_000; head = "b".repeat(40); await watch.tick()
  now += 60_000; await watch.tick()
  assert.equal(notes.length, 0, "the previous head's deadline cannot expire a new head")
  now += CI_INCOMPLETE_MS; await watch.tick()
  assert.equal(notes.length, 1)
  assert.match(notes[0]!, /observed head b{40}/)
}

// Failed readings use the existing due times. Null custom readers and thrown failures get the same bounded host log.
{
  let now = since, calls = 0, fails = true
  const waits: PullWait[] = [{ key: "delayed", child: "fin", report: "r", pullKey: "acme/app#7", since, pull: "acme/app#7", target: { key: "acme/app#7", repository: "acme/app", number: 7, cwd: "/fixture" }, until: "merge" }]
  const notes: string[] = [], logs: string[] = []
  const stop = followHostLog(line => { if (line.message === "a watched pull request could not be read") logs.push(JSON.stringify(line)) })
  const watch = new PullWatch({ waits: () => waits, now: () => now, read: async () => { calls++; if (!fails) return pending; if (calls % 2) return null; throw new Error("PRIVATE-CLI-OUTPUT") }, fire: async (_wait, _outcome, note) => { notes.push(note) } })
  try {
    await watch.tick()
    await watch.tick()
    assert.equal(calls, 1, "a duplicate tick adds no read before the existing due time")
    now += 2 * 60_000; await watch.tick()
    assert.equal(logs.length, 1, "failures within five minutes share a log allowance")
    now = since + PULL_READ_FAILED_MS; await watch.tick()
    assert.equal(notes.length, 1)
    assert.match(notes[0]!, /GitHub reads failed for 15m; the PR's checks and state are unknown/)
    assert.equal(logs.length, 2)
    assert.ok(logs.every(line => !line.includes("PRIVATE")), "raw exceptions never reach the host log")
    fails = false; now += PULL_WATCH_MAX_MS; await watch.tick()
    fails = true; now += PULL_WATCH_MAX_MS; await watch.tick()
    now += PULL_READ_FAILED_MS - 1; await watch.tick()
    assert.equal(notes.length, 1, "a successful read resets the continuous-failure clock")
  } finally { stop() }
}

// Backoff is an intentional pause, not a continuous read failure, including after earlier request errors.
for (const earlierFailure of [false, true]) {
  let now = since, calls = 0, limited = false
  const until = since + 20 * 60_000
  const notes: string[] = []
  const wait: PullWait = { key: "backoff", child: "fin", report: "r", pullKey: "acme/app#7", since, pull: "acme/app#7", target: { key: "acme/app#7", repository: "acme/app", number: 7, cwd: "/fixture" }, until: "merge" }
  const watch = new PullWatch({ waits: () => [wait], now: () => now,
    read: target => readPull(target, async () => {
      calls++
      if (limited) throw new GitHubRateLimitError(until)
      throw new Error("request failed")
    }), fire: async (_wait, _outcome, note) => { notes.push(note) },
  })
  if (earlierFailure) { await watch.tick(); now += 2 * 60_000 }
  limited = true; await watch.tick()
  assert.equal(watch.due(wait.target.key), until, "backoff uses the shared reader's exact deadline")
  const before = calls
  now = until - 1; await watch.tick()
  assert.equal(calls, before, "no read is made during the block")
  assert.equal(notes.length, 0, "twenty minutes of rate limiting never produces unreadable")
  limited = false; now = until; await watch.tick()
  assert.equal(notes.length, 0, "backoff cannot extend an earlier request-failure interval")
  now += PULL_READ_FAILED_MS - 1; await watch.tick()
  assert.equal(notes.length, 0)
  now += PULL_WATCH_MAX_MS; await watch.tick()
  assert.equal(notes.length, 1, "fifteen minutes of actual request errors produces one unreadable wake")
}

// Actual durable claims and delivery, including a host restart: one informational wake per head, then a settled wake.
const root = mkdtempSync(join(tmpdir(), "mako-pull-wait-delays-"))
try {
  for (const kind of ["incomplete", "unreadable"] as const) {
    const outcomes: string[] = []
    const stopLog = followHostLog(line => { if (line.message === "pull request outcome") outcomes.push(JSON.stringify(line)) })
    let offset = 0, ready = false, conversation = "", settled = false, renamed = false, report = 0, readable = kind === "incomplete"
    const base = Date.now(), now = () => Date.now() + offset
    const world: AgentsWorld = new AgentsWorld({ root: join(root, kind), now,
      readPull: async target => kind === "unreadable" && !readable
        ? readPull(target, async () => { throw new Error("PRIVATE-CLI-OUTPUT") })
        : { ...pending, headAt: base, checks: [{ name: renamed ? "unit" : "e2e", state: settled ? "passed" : "running" }] },
      script: async turn => {
        if (turn.text.includes("You're fin:") || turn.text.startsWith("Mako: PR")) {
          conversation = turn.conversation
          await turn.world.agents.report(turn.caller, { status: "progress", summary: "Waiting for checks.", waitingOn: [{ kind: "pull-request", ref: "acme/app#7", until: "checks" }], clientKey: `wait-${report++}` })
          ready = true
        }
        return "ok"
      },
    })
    try {
      const apex = await world.apex("claude", "full")
      const start = await world.agents.start(apex.caller, { harness: "codex", brief: { objective: "Wait on checks" }, name: "worker", clientKey: "worker", cwd: world.root })
      assert.ok(!("refused" in start))
      const deadline = Date.now() + 20_000
      while (!ready || world.live.session(conversation)?.status !== "ready") {
        assert.ok(Date.now() < deadline, "the fixture Fin becomes ready")
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      const notes = () => world.prompts.filter(prompt => prompt.conversation === conversation && prompt.text.startsWith("Mako: PR"))
      await world.agents.pulls.tick()
      offset += (kind === "incomplete" ? CI_INCOMPLETE_MS : PULL_READ_FAILED_MS) + PULL_WATCH_MAX_MS
      await world.agents.pulls.tick(); await world.settle(300, 20_000, "ignore")
      assert.equal(notes().length, 1, kind)
      assert.match(notes()[0]!.text, kind === "incomplete" ? /checks incomplete after 45m: e2e/ : /GitHub reads failed for 15m/)
      if (kind === "unreadable") {
        readable = true; offset += PULL_WATCH_MAX_MS
        await world.agents.pulls.tick(); await world.settle(300, 20_000, "ignore")
        readable = false; offset += PULL_WATCH_MAX_MS
        await world.agents.pulls.tick()
        offset += PULL_READ_FAILED_MS + PULL_WATCH_MAX_MS
        await world.agents.pulls.tick(); await world.settle(300, 20_000, "ignore")
        assert.equal(notes().length, 1, "learning a head between outages cannot replay this wait's unreadable wake")
      }
      renamed = true
      offset += PULL_WATCH_MAX_MS; await world.agents.pulls.tick()
      await world.restart()
      offset += CI_INCOMPLETE_MS + PULL_WATCH_MAX_MS
      await world.agents.pulls.tick(); await world.settle(300, 20_000, "ignore")
      offset += PULL_READ_FAILED_MS + PULL_WATCH_MAX_MS
      await world.agents.pulls.tick(); await world.settle(300, 20_000, "ignore")
      assert.equal(notes().length, 1, "changing check names and restarting cannot replay the same head's informational wake")
      assert.equal(outcomes.length, 1, "only a taken durable claim logs an outcome")
      settled = true; readable = true; offset += PULL_WATCH_MAX_MS
      await world.agents.pulls.tick(); await world.settle(300, 20_000, "ignore")
      assert.equal(notes().length, 2, `${kind}: recovery/settlement still reaches the Fin`)
      assert.match(notes()[1]!.text, /checks settled: 1 passed/)
      assert.equal(outcomes.length, 2, "the new settlement claim logs once too")
    } finally { await world.close(); stopLog() }
  }
} finally { rmSync(root, { recursive: true, force: true }) }
console.log("Pull waits: incomplete/read-failure boundaries, bounded logs, existing cadence and durable once-per-head wakes/recovery passed")

import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LIST_BUDGET_CHARS, LIST_ENDED_FOR_MS, type AgentStrip } from "@mako/host/contracts/agent-tools"
import { foldList, foldShiver } from "@mako/host/conversations/agent-list-fold"
import { agentToolText } from "@mako/host/conversations/agent-tools"
import { compactAnswer, TOPIC_CHARS } from "@mako/host/conversations/agent-tool-compact"
import type { ShiverMate } from "@mako/host/contracts/agent-tools"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { z } from "zod"
import { AgentsWorld } from "./lib/agents-world.ts"

/**
 * An Apex's `agents_list` stays within `LIST_BUDGET_CHARS` however many Fins it ever started: a Fin that ended or sat idle
 * over a day ago with nothing open is counted, not listed, and past the budget idle and ended rows lose their pull
 * requests, then fold. A Fin needing attention is never folded, past the budget if it must be. `ended: true` (or
 * `scope: all`) lists every one; a Fin's `scope: shiver` folds the same way. 130 Fins, an Apex's week, were 105 KB a call
 * before. The model reads each row compacted (`compactAnswer`): clock readings in words, nothing repeated, every
 * question and pull request kept.
 */
const now = Date.UTC(2026, 10, 15, 12)
const HOUR = 60 * 60_000
const LINE = "Opened #812 with the four hot-site fixes; each measured inline against once, lint and tests pass."
const strip = (index: number, state: AgentStrip["state"], movedAgo: number, extra: Partial<AgentStrip> = {}): AgentStrip => ({
  child: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`, name: `fin-${index}`, harness: "claude", origin: "started", state, title: `fin-${index}`,
  report: { status: "done", line: LINE, at: now - movedAgo },
  openPRs: [{ repository: "acme/app", number: 800 + index, url: `https://github.com/acme/app/pull/${800 + index}`, state: "reported" }],
  startedAt: now - movedAgo - HOUR, ...extra,
})
const decision = { question: "Merge it?", on: "lead" as const, ask: { kind: "report" as const, id: "report:x:1", options: [{ label: "Merge", detail: "squash" }, { label: "Leave open" }], recommended: 0 } }

// An Apex's week: most of its Fins ended days ago, a few at work, asking, idle or ended today.
{
  const strips: AgentStrip[] = []
  for (let index = 0; index < 100; index++) strips.push(strip(index, { kind: "ended", outcome: "done" }, 3 * 24 * HOUR + index * HOUR))
  for (let index = 100; index < 105; index++) strips.push(strip(index, { kind: "working", step: "Running npm test" }, 0))
  strips.push(strip(105, { kind: "ended", outcome: "done", decision }, 4 * 24 * HOUR))
  strips.push(strip(106, { kind: "blocked", question: "Which branch?", on: "lead" }, 2 * HOUR))
  strips.push(strip(107, { kind: "ended", outcome: "done" }, 5 * 24 * HOUR, { pendingQuestions: 1 }))
  for (let index = 108; index < 118; index++) strips.push(strip(index, { kind: "idle" }, HOUR, { idleFor: 3600 }))
  for (let index = 118; index < 130; index++) strips.push(strip(index, { kind: "ended", outcome: "done" }, 3 * HOUR))
  const all = JSON.stringify({ children: strips }).length
  const listed = foldList(strips, now)
  const size = JSON.stringify(listed).length
  assert.ok(size <= LIST_BUDGET_CHARS, `the default list is ${size} characters, over its ${LIST_BUDGET_CHARS} budget`)
  const names = new Set(listed.children.map((each) => each.name))
  for (const asking of ["fin-105", "fin-106", "fin-107", "fin-100", "fin-104"]) assert.ok(names.has(asking), `${asking} needs attention or is at work, and is listed`)
  for (const index of [0, 50, 99]) assert.ok(!names.has(`fin-${index}`), `fin-${index} ended days ago and is counted, not listed`)
  assert.equal(listed.children.length + listed.folded!.idle + listed.folded!.ended, strips.length, "every Fin is listed or counted")
  assert.match(listed.folded!.note, /ended: true/)
  // The rows kept are in the list's order.
  const order = listed.children.map((each) => Number(each.name.slice(4)))
  assert.deepEqual(order, [...order].sort((a, b) => a - b))
  console.log(`fold: 130 Fins, ${Math.round(all / 1024)} KB whole, listed ${listed.children.length} in ${(size / 1024).toFixed(1)} KB; ${listed.folded!.note}`)
}

// A Fin that ended just inside the day is listed; just past it, counted.
{
  const inside = strip(1, { kind: "ended", outcome: "done" }, LIST_ENDED_FOR_MS - 60_000)
  const past = strip(2, { kind: "ended", outcome: "failed" }, LIST_ENDED_FOR_MS + 60_000)
  const listed = foldList([inside, past], now)
  assert.deepEqual(listed.children.map((each) => each.name), ["fin-1"])
  assert.deepEqual({ ...listed.folded, note: undefined }, { idle: 0, ended: 1, note: undefined })
  assert.equal(foldList([inside], now).folded, undefined, "nothing folded says nothing")
  // Idle with nothing open folds the same way past the day; idle waiting on a pull request never does.
  const idleOld = strip(3, { kind: "idle" }, 2 * LIST_ENDED_FOR_MS, { idleFor: 2 * LIST_ENDED_FOR_MS / 1000 })
  const idleWaiting = strip(4, { kind: "idle" }, 2 * LIST_ENDED_FOR_MS, { idleFor: 2 * LIST_ENDED_FOR_MS / 1000, waiting: "waiting on #812 checks" })
  const idle = foldList([idleOld, idleWaiting], now)
  assert.deepEqual(idle.children.map((each) => each.name), ["fin-4"])
  assert.deepEqual({ ...idle.folded, note: undefined }, { idle: 1, ended: 0, note: undefined })
}

// The Shiver view folds as the children's does: a mate needing a decision or waiting stays, whatever its age.
{
  const mate = (name: string, state: ShiverMate["state"], agoMs: number): ShiverMate => ({ name, harness: "Claude Code", state, topic: "Fix it.", idleFor: agoMs / 1000, report: { status: "done", line: "Done.", at: now - agoMs } })
  const shiver = [
    mate("recent", { kind: "ended", outcome: "done" }, HOUR),
    mate("old", { kind: "ended", outcome: "done" }, 3 * LIST_ENDED_FOR_MS),
    mate("old-idle", { kind: "idle" }, 3 * LIST_ENDED_FOR_MS),
    mate("deciding", { kind: "ended", outcome: "done", decision }, 3 * LIST_ENDED_FOR_MS),
    mate("waiting", { kind: "idle", waitingOn: [{ kind: "pull-request", ref: "acme/app#9", until: "checks" }] }, 3 * LIST_ENDED_FOR_MS),
    { name: "working", harness: "Codex", state: { kind: "working" }, topic: "Build it." } satisfies ShiverMate,
  ]
  const folded = foldShiver(shiver, now)
  assert.deepEqual(folded.shiver.map((each) => each.name), ["recent", "deciding", "waiting", "working"])
  assert.deepEqual({ ...folded.folded, note: undefined }, { idle: 1, ended: 1, note: undefined })
  assert.match(folded.folded!.note, /ended: true/)
}

// What the model reads of a list: clock readings in words, repeats gone, every question and pull request kept.
{
  const title = "The Apex's own title"
  const asking = strip(1, { kind: "ended", outcome: "done", decision }, 3 * HOUR, { title, idleFor: 3 * 3600, pendingQuestions: 2, model: "claude-opus-5-5", runsOn: "Opus 5.5 · High", changedAt: now - 3 * HOUR })
  const working = strip(2, { kind: "working", step: "Building" }, 0, { title })
  const text = JSON.stringify(compactAnswer("agents_list", { children: [asking, working], tree: { running: 1, started: 2 }, mark: "x:1" }, now))
  const read = z.object({ children: z.array(z.record(z.string(), z.json())), mark: z.string() }).parse(JSON.parse(text))
  const [row] = read.children
  assert.equal(read.mark, "x:1", "the list's mark, which since takes, stays")
  assert.equal(row!["idle"], "3h")
  assert.deepEqual(row!["report"], { status: "done", line: LINE, ago: "3h" })
  for (const gone of ["idleFor", "startedAt", "changedAt", "origin", "title", "model"]) assert.ok(!(gone in row!), `${gone} is left out`)
  assert.deepEqual(row!["openPRs"], asking.openPRs, "every pull request fact stays")
  assert.equal(row!["pendingQuestions"], 2)
  assert.deepEqual(row!["state"], asking.state, "the decision stays whole")
  assert.equal(row!["runsOn"], "Opus 5.5 · High")
  assert.equal(row!["child"], asking.child)
  assert.ok(!text.includes(String(asking.report!.at)), "no raw report time")
  // A Shiver mate's topic is cut; the rest of a Shiver answer as it was.
  const shiver = compactAnswer("agents_list", { you: "me", apex: { title, working: false }, shiver: [{ name: "a", harness: "Codex", state: { kind: "working" }, topic: "x".repeat(200) }] })
  const topic = z.object({ shiver: z.array(z.object({ topic: z.string() })) }).parse(shiver).shiver[0]!.topic
  assert.equal(topic.length, TOPIC_CHARS)
  assert.deepEqual(shiver["apex"], { title, working: false })
  // Other tools, and refusals, read as they were.
  const refusal = { refused: "unknown-child", why: "No Fin named x." }
  assert.deepEqual(compactAnswer("agents_list", refusal), refusal)
  const read2 = { child: "c", text: "idleFor startedAt", startedAt: 1 }
  assert.deepEqual(compactAnswer("agents_read", read2), read2)
}

// agents_move { all }: what each moved Fin shares said once, each row only what differs.
{
  const moved = Array.from({ length: 4 }, (_, index) => ({ child: `child-${index}`, name: `fin-${index}`, from: index === 3 ? "cursor" : "claude", harness: "codex", state: "moved",
    hears: `fin-${index} runs nothing until your next message, which goes there with its whole conversation.` }))
  moved[2]!.hears = "fin-2 takes what waited for it there now, with its whole conversation."
  const left = [{ name: "fin-9", refused: "conflict", why: "fin-9 is at work." }]
  const answer = compactAnswer("agents_move", { moved, left })
  assert.deepEqual(answer["each"], { harness: "codex", state: "moved" })
  assert.deepEqual(answer["moved"], [
    { name: "fin-0", from: "claude", hears: moved[0]!.hears },
    { name: "fin-1", from: "claude", hears: moved[1]!.hears },
    { name: "fin-2", from: "claude", hears: moved[2]!.hears },
    { name: "fin-3", from: "cursor", hears: moved[3]!.hears },
  ], "a sentence not every Fin hears keeps its name")
  assert.deepEqual(answer["left"], left, "every refusal stays")
  const same = compactAnswer("agents_move", { moved: moved.slice(0, 2) })
  assert.deepEqual(same["each"], { from: "claude", harness: "codex", state: "moved", hears: "Each runs nothing until your next message, which goes there with its whole conversation." })
  assert.deepEqual(same["moved"], [{ name: "fin-0" }, { name: "fin-1" }])
  const one = { moved: moved.slice(0, 1) }
  assert.deepEqual(compactAnswer("agents_move", one), one, "a single move stays as it was")
}

// More needing attention than the budget holds: every one is listed, whatever it costs, and the idle and ended rows
// beside them fold. A long-waiting question is the oldest-moved row, the first a fold by age would take.
{
  const strips: AgentStrip[] = []
  for (let index = 0; index < 50; index++) strips.push(strip(index, { kind: "working", step: "Building" }, index * 60_000))
  strips.push(strip(50, { kind: "ended", outcome: "done" }, 9 * 24 * HOUR, { pendingQuestions: 2 }))
  strips.push(strip(51, { kind: "idle" }, 8 * 24 * HOUR, { pendingActions: 1, idleFor: 8 * 24 * 3600 }))
  strips.push(strip(52, { kind: "ended", outcome: "done" }, 7 * 24 * HOUR, { custodyActions: 1 }))
  strips.push(strip(53, { kind: "ended", outcome: "done", decision }, 6 * 24 * HOUR))
  strips.push(strip(54, { kind: "blocked", question: "Which branch?", on: "person" }, 5 * 24 * HOUR))
  strips.push(strip(55, { kind: "idle" }, 4 * 24 * HOUR, { waiting: "waiting on #812 checks", idleFor: 4 * 24 * 3600 }))
  for (let index = 56; index < 66; index++) strips.push(strip(index, { kind: "idle" }, HOUR, { idleFor: 3600 }))
  for (let index = 66; index < 76; index++) strips.push(strip(index, { kind: "ended", outcome: "done" }, 2 * HOUR))
  const listed = foldList(strips, now)
  const names = new Set(listed.children.map((each) => each.name))
  for (let index = 0; index < 56; index++) assert.ok(names.has(`fin-${index}`), `fin-${index} needs attention and is listed`)
  assert.ok(JSON.stringify(listed).length > LIST_BUDGET_CHARS, "the answer goes past the budget for them")
  assert.equal(listed.folded!.idle + listed.folded!.ended, 20, "the idle and ended rows fold")
  assert.equal(listed.children.length, 56)
  console.log(`attention: ${listed.children.length} Fins needing attention listed in ${(JSON.stringify(listed).length / 1024).toFixed(1)} KB, past the budget; ${listed.folded!.note}`)
}

// Just past the budget: idle and ended rows lose their pull requests before any of them folds.
{
  const strips: AgentStrip[] = []
  for (let index = 0; index < 34; index++) strips.push(strip(index, { kind: "ended", outcome: "done" }, HOUR + index * 60_000))
  const whole = JSON.stringify({ children: strips }).length
  const listed = foldList(strips, now)
  assert.ok(whole > LIST_BUDGET_CHARS - 1024, `the rows whole (${whole}) are past the budget`)
  assert.equal(listed.folded, undefined, "none folds once their pull requests are left out")
  assert.ok(listed.children.every((each) => each.openPRs === undefined), "their pull requests are agents_read's to give")
}

// Through the engine: an Apex with 60 Fins that each reported, its default list within the budget, scope all every one.
{
  const root = mkdtempSync(join(tmpdir(), "mako-agents-list-fold-"))
  let later = 0
  const world = new AgentsWorld({ root, script: (turn) => (turn.text.includes("You're fin:") ? "Done for now." : "ok"), budget: { running: 70, started: 70 }, now: () => Date.now() + later })
  try {
    const apex = await world.apex("claude", "full")
    const children: string[] = []
    for (let index = 0; index < 60; index++) {
      const answer = await world.agents.start(apex.caller, { brief: { objective: `Fix item ${index}` }, name: `fin-${index}`, harness: "claude", cwd: world.root, clientKey: `fin-${index}`, queue: true })
      assert.ok(!("refused" in answer), JSON.stringify(answer))
      children.push(answer.child!)
    }
    await world.settle(40, 120_000)
    for (const [index, child] of children.entries()) {
      const conversation = world.store.thread(ThreadIdSchema.parse(child))!.sessions.flatMap((session) => world.store.conversationsOf(session))[0]!
      const answer = await world.agents.report(world.caller(conversation), { status: "done", summary: `${LINE} ${"More words for the report. ".repeat(20)}`, clientKey: `done-${index}`,
        artifacts: [{ kind: "pull-request", ref: `https://github.com/acme/app/pull/${900 + index}` }] })
      assert.ok(!("refused" in answer), JSON.stringify(answer))
    }
    await world.settle(40, 60_000, "ignore")
    const listed = await world.agents.list(apex.caller, {})
    assert.ok("children" in listed && "tree" in listed)
    const size = JSON.stringify(listed).length
    assert.ok(size <= LIST_BUDGET_CHARS, `the default list is ${size} characters`)
    assert.equal(listed.children.length + (listed.folded ? listed.folded.idle + listed.folded.ended : 0), 60)
    const all = await world.agents.list(apex.caller, { scope: "all" })
    assert.ok("children" in all)
    assert.equal(all.children.length, 60, "scope all lists every Fin")
    assert.equal("folded" in all ? all.folded : undefined, undefined)
    console.log(`engine: 60 Fins, default ${(size / 1024).toFixed(1)} KB with ${listed.children.length} listed, all ${(JSON.stringify(all).length / 1024).toFixed(1)} KB`)

    // One asks its Apex to decide; then two days pass. Every other Fin folds, the one asking never does, and
    // ended: true lists them all again, in the children's view and a Fin's Shiver view alike.
    const conversationOf = (child: string) => world.store.thread(ThreadIdSchema.parse(child))!.sessions.flatMap((session) => world.store.conversationsOf(session))[0]!
    const asked = await world.agents.report(world.caller(conversationOf(children[7]!)), { status: "done", summary: "Ready to merge.", question: "Merge #907?", options: [{ label: "Merge" }, { label: "Leave open" }], clientKey: "ask-7" })
    assert.ok(!("refused" in asked), JSON.stringify(asked))
    await world.settle(40, 60_000, "ignore")
    later = 2 * LIST_ENDED_FOR_MS
    const aged = await world.agents.list(apex.caller, {})
    assert.ok("children" in aged && "mark" in aged)
    assert.deepEqual(aged.children.map((each) => each.name), ["fin-7"], "only the Fin asking its Apex is listed")
    assert.equal(aged.folded?.ended, 59)
    const shown = await world.agents.list(apex.caller, { ended: true })
    assert.ok("children" in shown)
    assert.equal(shown.children.length, 60, "ended: true lists every one")
    assert.equal("folded" in shown ? shown.folded : undefined, undefined)
    const shiver = await world.agents.list(world.caller(conversationOf(children[0]!)), { scope: "shiver" })
    assert.ok("shiver" in shiver, JSON.stringify(shiver))
    assert.deepEqual(shiver.shiver.map((each) => each.name), ["fin-7"], "a Fin's Shiver folds the same way, keeping the one asking")
    assert.equal(shiver.folded?.ended, 58)
    const wholeShiver = await world.agents.list(world.caller(conversationOf(children[0]!)), { scope: "shiver", ended: true })
    assert.ok("shiver" in wholeShiver)
    assert.equal(wholeShiver.shiver.length, 59)
    // since still lists what changed, folded or not: a Fin reporting again shows, the rest are unchanged.
    const again = await world.agents.report(world.caller(conversationOf(children[3]!)), { status: "done", summary: "Followed up.", clientKey: "again-3" })
    assert.ok(!("refused" in again), JSON.stringify(again))
    await world.settle(40, 60_000, "ignore")
    const since = await world.agents.list(apex.caller, { since: aged.mark })
    assert.ok("children" in since)
    assert.deepEqual(since.children.map((each) => each.name).sort(), ["fin-3", "fin-7"], "the Fin that changed, and the one waiting on its Apex")
    assert.equal(since.unchanged, 58)
    // The model door's text of the aged list: one row, the fold one line.
    const text = agentToolText({ ...aged }, "agents_list")
    assert.ok(!/idleFor|startedAt|changedAt/.test(text), text)
    console.log(`engine, two days on: ${text.length} characters to the model; ${aged.folded!.note}`)
  } finally {
    await world.close()
    rmSync(root, { recursive: true, force: true })
  }
}

console.log("agents_list: a Fin ended or idle over a day ago is counted, not listed, in the children's and the Shiver's view; past the budget idle and ended rows lose their pull requests, then fold; what needs attention is never folded; ended: true lists every one; since still lists what changed; the model reads compact rows; agents_move all says what its Fins share once")

import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LIST_BUDGET_CHARS, LIST_ENDED_FOR_MS, type AgentStrip } from "@mako/host/contracts/agent-tools"
import { foldList } from "@mako/host/conversations/agent-list-fold"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { AgentsWorld } from "./lib/agents-world.ts"

/**
 * An Apex's `agents_list` stays within `LIST_BUDGET_CHARS` however many Fins it ever started: a Fin that ended over a day
 * ago with nothing open is counted, not listed, and past the budget the rest fold by rank, what needs attention last.
 * `scope: all` lists every one. 130 Fins, an Apex's week, were 105 KB a call before.
 */
const now = Date.UTC(2026, 10, 15, 12)
const HOUR = 60 * 60_000
const LINE = "Opened #812 with the four hot-site fixes; each measured inline against once, lint and tests pass."
const strip = (index: number, state: AgentStrip["state"], movedAgo: number, extra: Partial<AgentStrip> = {}): AgentStrip => ({
  child: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`, name: `fin-${index}`, harness: "claude", origin: "started", state, title: `fin-${index}`,
  report: { status: "done", line: LINE, at: now - movedAgo }, waiting: "waiting on #812 checks",
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
  assert.equal(listed.children.length + listed.folded!.attention + listed.folded!.idle + listed.folded!.ended, strips.length, "every Fin is listed or counted")
  assert.equal(listed.folded!.attention, 0, "nothing needing attention folds while there's room")
  assert.match(listed.folded!.note, /scope all/)
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
  assert.deepEqual({ ...listed.folded, note: undefined }, { attention: 0, idle: 0, ended: 1, note: undefined })
  assert.equal(foldList([inside], now).folded, undefined, "nothing folded says nothing")
}

// More at work than the budget holds: the newest stay, the rest are counted as needing attention.
{
  const strips = Array.from({ length: 60 }, (_, index) => strip(index, { kind: "working", step: "Building" }, index * 60_000))
  const listed = foldList(strips, now)
  assert.ok(JSON.stringify(listed).length <= LIST_BUDGET_CHARS)
  assert.ok(listed.folded!.attention > 0 && listed.children.some((each) => each.name === "fin-0"), "the most recently moved are kept")
}

// Through the engine: an Apex with 60 Fins that each reported, its default list within the budget, scope all every one.
{
  const root = mkdtempSync(join(tmpdir(), "mako-agents-list-fold-"))
  const world = new AgentsWorld({ root, script: (turn) => (turn.text.includes("You're fin:") ? "Done for now." : "ok"), budget: { running: 70, started: 70 } })
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
        artifacts: [{ kind: "pull-request", ref: `https://github.com/acme/app/pull/${900 + index}` }], waitingOn: [{ kind: "pull-request", ref: `acme/app#${900 + index}`, until: "checks" }] })
      assert.ok(!("refused" in answer), JSON.stringify(answer))
    }
    await world.settle(40, 60_000, "ignore")
    const listed = await world.agents.list(apex.caller, {})
    assert.ok("children" in listed && "tree" in listed)
    const size = JSON.stringify(listed).length
    assert.ok(size <= LIST_BUDGET_CHARS, `the default list is ${size} characters`)
    assert.equal(listed.children.length + (listed.folded ? listed.folded.attention + listed.folded.idle + listed.folded.ended : 0), 60)
    const all = await world.agents.list(apex.caller, { scope: "all" })
    assert.ok("children" in all)
    assert.equal(all.children.length, 60, "scope all lists every Fin")
    assert.equal("folded" in all ? all.folded : undefined, undefined)
    console.log(`engine: 60 Fins, default ${(size / 1024).toFixed(1)} KB with ${listed.children.length} listed, all ${(JSON.stringify(all).length / 1024).toFixed(1)} KB`)
  } finally {
    await world.close()
    rmSync(root, { recursive: true, force: true })
  }
}

console.log("agents_list: a Fin ended over a day ago is counted, not listed; past the budget the rest fold by rank; scope all lists every one")

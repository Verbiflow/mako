import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { frontDoorNote, type FrontDoorChild } from "@mako/host/contracts/agent-tools"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { FinChanges } from "@mako/host/conversations/fin-changes"
import { AgentsWorld } from "./lib/agents-world.ts"

/**
 * Change marks (`FinChanges`): an Apex reads only what changed. `agents_list` answers a `mark`, and with `since` lists
 * only the Fins whose state, report, open questions or pull requests changed since, counting the rest; the front door's
 * note names a Fin nothing changed for since the last note instead of describing it again (`npm run test:agents-doors`).
 */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// What counts as a change: a working Fin's next step doesn't, nor a queued one's place in line; a report, a question,
// an end and a pull request do.
{
  const changes = new FinChanges()
  const fin = "fin-a"
  assert.equal(changes.at(fin, { state: { kind: "working", step: "Reading" } }, 1), 1, "first read: changed then")
  assert.equal(changes.at(fin, { state: { kind: "working", step: "Running npm test", phase: "testing" } }, 2), 1, "a working Fin's step moving is no change")
  assert.equal(changes.at(fin, { state: { kind: "working" }, report: { status: "progress", at: 5 } }, 3), 3, "a report is")
  assert.equal(changes.at(fin, { state: { kind: "working" }, report: { status: "progress", at: 5 }, questions: 1 }, 4), 4, "so is a question it asks")
  assert.equal(changes.at(fin, { state: { kind: "ended", outcome: "done" }, report: { status: "done", at: 6 }, questions: 1 }, 5), 5, "and its end")
  assert.equal(changes.at(fin, { state: { kind: "ended", outcome: "done" }, report: { status: "done", at: 6 }, questions: 1, pulls: [{ number: 12, state: "open" }] }, 6), 6, "and a pull request it opens")
  assert.equal(changes.at(fin, { state: { kind: "ended", outcome: "done" }, report: { status: "done", at: 6 }, questions: 1, pulls: [{ number: 12, state: "open" }] }, 9), 6, "the same facts again: same since")
  assert.equal(changes.at("fin-q", { state: { kind: "queued", reason: "tree-running", ahead: 3 } }, 1), 1)
  assert.equal(changes.at("fin-q", { state: { kind: "queued", reason: "tree-running", ahead: 1 } }, 2), 1, "a queued Fin moving up the line is no change")
}

// The note: changed Fins in full, unchanged ones named on one line, one that waits on an answer always in full.
{
  const fin = (name: string, state: FrontDoorChild["state"], changedAt: number): FrontDoorChild => ({ name, harness: "Codex", state, topic: `Do ${name}.`, changedAt })
  const now = 10 * 60_000
  const seenAt = 5 * 60_000
  const lines = frontDoorNote([
    fin("fresh", { kind: "ended", outcome: "done" }, 6 * 60_000),
    fin("still", { kind: "idle" }, 60_000),
    fin("old", { kind: "ended", outcome: "done" }, 60_000),
    fin("asks", { kind: "blocked", question: "Which branch?", on: "lead" }, 60_000),
  ], now, false, seenAt)
  const text = lines.join("\n")
  assert.ok(lines.some((line) => line.startsWith("- fin:fresh ·")), `a Fin that changed is described: ${text}`)
  assert.ok(lines.some((line) => line.startsWith("- fin:asks ·") && line.includes("Which branch?")), "one waiting on an answer always is")
  assert.ok(!lines.some((line) => line.startsWith("- fin:still") || line.startsWith("- fin:old")), "unchanged ones aren't described again")
  assert.ok(lines.includes("Unchanged since the last note (5m ago): fin:still (idle), fin:old (done) (agents_list has each)."), text)
  const first = frontDoorNote([fin("still", { kind: "idle" }, 60_000)], now, false)
  assert.ok(first.some((line) => line.startsWith("- fin:still ·")), "with no note before, every Fin is described")
}

// Through the engine: a list's mark, `since` with a Fin that reported, and the front door's second note.
{
  const root = mkdtempSync(join(tmpdir(), "mako-fin-changes-"))
  const world = new AgentsWorld({ root, script: (turn) => (turn.text.includes("You're fin:") ? "Done for now." : "ok") })
  try {
    const apex = await world.apex("claude", "full")
    const children: string[] = []
    for (const name of ["alpha", "beta", "gamma"]) {
      const answer = await world.agents.start(apex.caller, { brief: { objective: `Check ${name}` }, name, harness: "codex", cwd: world.root, clientKey: name })
      assert.ok(!("refused" in answer), JSON.stringify(answer))
      children.push(answer.child!)
    }
    await world.settle(300, 30_000, "ignore")
    const first = await world.agents.list(apex.caller, {})
    assert.ok("children" in first && "mark" in first, JSON.stringify(first))
    assert.equal(first.children.length, 3)
    const mark = first.mark!
    assert.ok(first.children.every((strip) => strip.changedAt !== undefined && strip.changedAt <= mark), "every row has its change mark, on the list's clock")
    await pause(5)
    const quiet = await world.agents.list(apex.caller, { since: mark })
    assert.ok("children" in quiet && "mark" in quiet)
    assert.equal(quiet.children.length, 0, "nothing changed: nothing listed")
    assert.equal(quiet.unchanged, 3, "and every Fin counted")

    const door = () => world.agents.frontDoor(apex.conversation, {}, false)
    const before = door()
    assert.equal(before.filter((line) => line.startsWith("- fin:")).length, 3, `the first note describes each: ${before.join("\n")}`)
    await pause(5)
    const conversation = world.store.thread(ThreadIdSchema.parse(children[1]!))!.sessions.flatMap((session) => world.store.conversationsOf(session))[0]!
    const reported = await world.agents.report(world.caller(conversation), { status: "done", summary: "Beta is checked: two fixes, PR to follow.", clientKey: "beta-done" })
    assert.ok(!("refused" in reported), JSON.stringify(reported))
    await world.settle(300, 30_000, "ignore")
    const moved = await world.agents.list(apex.caller, { since: mark })
    assert.ok("children" in moved)
    assert.deepEqual(moved.children.map((strip) => strip.name), ["beta"], "only the Fin that reported")
    assert.equal(moved.unchanged, 2)
    const after = door()
    const described = after.filter((line) => line.startsWith("- fin:")).map((line) => line.slice("- fin:".length).split(" ")[0])
    assert.deepEqual(described, ["beta"], `the next note describes only what changed: ${after.join("\n")}`)
    assert.ok(after.some((line) => line.startsWith("Unchanged since the last note") && line.includes("fin:alpha") && line.includes("fin:gamma")), after.join("\n"))
    // A process that hasn't heard a note (new, compacted, after a failed send) hears every Fin described again.
    const whole = world.agents.frontDoor(apex.conversation, {}, false, true)
    assert.equal(whole.filter((line) => line.startsWith("- fin:")).length, 3, `a fresh context: each described: ${whole.join("\n")}`)
    assert.ok(!whole.some((line) => line.startsWith("Unchanged since")))
    const chars = (lines: readonly string[]) => lines.reduce((sum, line) => sum + line.length + 1, 0)
    console.log(`front door: ${chars(before)} characters with every Fin described, ${chars(after)} with one changed of three`)
  } finally {
    await world.close()
    rmSync(root, { recursive: true, force: true })
  }
}

console.log("change marks: agents_list answers a mark and lists only what changed since it; the front door names an unchanged Fin instead of describing it again")
